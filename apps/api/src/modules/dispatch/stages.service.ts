import { timingSafeEqual } from 'node:crypto';
import type { Delivery, Order, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { raiseOpsAlert } from '../../platform/ops-alerts';
import { writeOutbox } from '../../platform/outbox';
import type { AuditService } from '../audit';
import type { SettingsService } from '../config';
import type { FilesService } from '../files';
import { haversineM } from '../geo';
import type { LedgerService } from '../ledger';
import {
  deliveryCodeHash,
  type OrderSettlement,
  type OrderTimers,
  type OrderTransitions,
} from '../orders';
import type {
  PartnerAvailabilityService,
  PartnerEarningsService,
  PresenceStore,
} from '../partners';
import { lockDelivery, moveDelivery } from './delivery-state';
import type { DispatchService } from './dispatch.service';

type Tx = Prisma.TransactionClient;
type Point = { lat: number; lng: number };

const MAX_OTP_ATTEMPTS = 5; // BR-DEL-009
const HEARTBEAT_ALERT_MS = 3 * 60_000; // FR-DISP-014
const HEARTBEAT_RELEASE_MS = 5 * 60_000;

/**
 * The trip itself (FR-DEL-010…037, D04…D07, T13/T13c/T15): geofenced
 * arrivals, pickup by the partner or a restaurant handover with the pickup
 * code, completion by OTP or photo with COD cash, then settlement and pay.
 */
export class DeliveryStagesService {
  /** Set by orders: refunds and ledger for a failed delivery (T16, BR-REFUND-001); returns refund ids. */
  onFailed:
    | ((
        tx: Tx,
        order: Order,
        cause: 'DELIVERY_FAILED' | 'CUSTOMER_UNREACHABLE',
        actor: { type: 'ADMIN'; id: string },
      ) => Promise<string[]>)
    | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly transitions: OrderTransitions,
    private readonly timers: OrderTimers,
    private readonly settlement: OrderSettlement,
    private readonly earnings: PartnerEarningsService,
    private readonly ledger: LedgerService,
    private readonly presence: PresenceStore,
    private readonly availability: PartnerAvailabilityService,
    private readonly dispatch: DispatchService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly secret: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  private now() {
    return this.clock.now();
  }

  private async partner(userId: string) {
    const p = await this.prisma.deliveryPartner.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!p) throw new AppError('FORBIDDEN');
    return p.id;
  }

  /** The partner's own delivery, locked. */
  private async mine(tx: Tx, userId: string, deliveryId: string) {
    const partnerId = await this.partner(userId);
    const d = await lockDelivery(tx, deliveryId);
    if (d.partnerId !== partnerId)
      throw new AppError('NOT_FOUND', { message: "We couldn't find that delivery." });
    return d;
  }

  private async points(d: Delivery) {
    const [r] = await this.prisma.$queryRaw<
      { blat: number; blng: number; dlat: number | null; dlng: number | null }[]
    >`
      SELECT ST_Y(b.location::geometry) AS blat, ST_X(b.location::geometry) AS blng,
        ST_Y(a.location::geometry) AS dlat, ST_X(a.location::geometry) AS dlng
      FROM branches b LEFT JOIN order_addresses a ON a.order_id = ${d.orderId}::uuid WHERE b.id = ${d.branchId}::uuid`;
    return {
      branch: { lat: Number(r!.blat), lng: Number(r!.blng) },
      drop: r!.dlat !== null ? { lat: Number(r!.dlat), lng: Number(r!.dlng) } : null,
    };
  }

  /** BR-DEL-008: outside the geofence needs an explicit confirmation and is flagged. */
  private async geofence(
    target: Point,
    at: Point | undefined,
    radiusKey: 'delivery.restaurantGeofenceM' | 'delivery.customerGeofenceM',
    confirm: boolean,
  ) {
    if (!at) return { distance: null, flagged: false };
    const distance = Math.round(haversineM(target, at));
    const limit = await this.settings.get(radiusKey);
    if (distance <= limit) return { distance, flagged: false };
    if (!confirm)
      throw new AppError('GEOFENCE_CONFIRMATION_REQUIRED', {
        details: [
          {
            path: 'confirm',
            code: 'OUTSIDE_GEOFENCE',
            message: `${distance} m away (limit ${limit} m)`,
          },
        ],
      });
    return { distance, flagged: true };
  }

  /* ----------------------------- reads ----------------------------- */

  /** API-DPDEL-004/005 (FR-DEL-010): what the partner needs at each stage. */
  async view(userId: string, deliveryId?: string) {
    const partnerId = await this.partner(userId);
    const d = deliveryId
      ? await this.prisma.delivery.findFirst({ where: { id: deliveryId, partnerId } })
      : await this.prisma.delivery.findFirst({
          where: {
            partnerId,
            status: { in: ['ASSIGNED', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'] },
          },
        });
    if (!d) {
      if (deliveryId)
        throw new AppError('NOT_FOUND', { message: "We couldn't find that delivery." });
      return null;
    }
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: d.orderId },
      include: {
        items: { select: { itemName: true, quantity: true } },
        address: true,
        branch: {
          select: {
            name: true,
            line1: true,
            area: true,
            phone: true,
            restaurant: { select: { brandName: true } },
          },
        },
      },
    });
    const pts = await this.points(d);
    const active = ['ASSIGNED', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'].includes(
      d.status,
    );
    const afterPickup = ['EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'].includes(d.status);
    const earning = await this.prisma.partnerEarning.findUnique({ where: { deliveryId: d.id } });
    return {
      id: d.id,
      status: d.status,
      orderNumber: order.number,
      orderStatus: order.status,
      pickupCode: active ? d.pickupCode : null,
      restaurant: {
        name: order.branch.restaurant.brandName,
        branch: order.branch.name,
        address: `${order.branch.line1}, ${order.branch.area}`,
        phone: active ? order.branch.phone : null,
        location: pts.branch,
      },
      items: order.items.reduce((s, i) => s + i.quantity, 0),
      // The full drop address only while the trip is live (data minimisation, BR-DEL-012).
      customer: active
        ? {
            name: order.contactName.split(/\s+/)[0],
            address: order.address
              ? [
                  order.address.line1,
                  order.address.line2,
                  order.address.landmark,
                  order.address.area,
                ]
                  .filter(Boolean)
                  .join(', ')
              : null,
            instructions: order.deliveryInstructions,
            location:
              afterPickup || d.status === 'AT_RESTAURANT' || d.status === 'ASSIGNED'
                ? pts.drop
                : null,
          }
        : { name: null, address: order.address?.area ?? null, instructions: null, location: null },
      payment:
        order.paymentMethod === 'COD'
          ? { type: 'COD', collect: order.payableAmount }
          : { type: 'PREPAID' },
      proof: order.paymentMethod !== 'COD' && order.contactless ? 'PHOTO' : 'OTP',
      distances: { pickupM: d.distancePickupM, dropM: d.distanceDropM },
      earning: earning ? { total: earning.totalAmount, tip: earning.tipAmount } : null,
      times: {
        assignedAt: d.assignedAt,
        arrivedRestaurantAt: d.arrivedRestaurantAt,
        pickedUpAt: d.pickedUpAt,
        deliveredAt: d.deliveredAt,
      },
    };
  }

  /** API-DPDEL-013 (FR-DEL-037) */
  async history(
    userId: string,
    opts: { from?: Date | undefined; to?: Date | undefined; limit: number },
  ) {
    const partnerId = await this.partner(userId);
    const rows = await this.prisma.delivery.findMany({
      where: {
        partnerId,
        status: { in: ['DELIVERED', 'FAILED', 'CANCELLED'] },
        ...(opts.from || opts.to
          ? {
              createdAt: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lt: opts.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      include: {
        order: {
          select: {
            number: true,
            branch: { select: { restaurant: { select: { brandName: true } } } },
          },
        },
        earning: true,
      },
    });
    return rows.map((d) => ({
      id: d.id,
      orderNumber: d.order.number,
      restaurant: d.order.branch.restaurant.brandName,
      status: d.status,
      date: d.deliveredAt ?? d.updatedAt,
      distanceKm: d.distanceDropM ? Math.round(d.distanceDropM / 100) / 10 : null,
      earning: d.earning?.totalAmount ?? 0,
    }));
  }

  /* ----------------------------- stages ----------------------------- */

  /** API-DPDEL-006 (FR-DEL-020, D04) */
  async arrivedAtRestaurant(
    userId: string,
    deliveryId: string,
    input: { at?: Point | undefined; confirm?: boolean | undefined },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.mine(tx, userId, deliveryId);
      if (d.status !== 'ASSIGNED')
        throw new AppError('ORDER_STATE_CONFLICT', { message: 'Already marked.' });
      const { branch } = await this.points(d);
      const g = await this.geofence(
        branch,
        input.at,
        'delivery.restaurantGeofenceM',
        Boolean(input.confirm),
      );
      await moveDelivery(tx, d, 'AT_RESTAURANT', {
        actor: { type: 'PARTNER', id: userId },
        now: this.now(),
        at: input.at ?? null,
        distanceToTargetM: g.distance,
        flagged: g.flagged,
      });
    });
    return this.view(userId, deliveryId);
  }

  /** Order PICKED_UP (T13, or T13c from PREPARING) and delivery EN_ROUTE in one transaction. */
  private async pickup(
    tx: Tx,
    d: Delivery,
    actor: { type: 'PARTNER' | 'RESTAURANT'; id: string },
    at: Point | null,
  ) {
    const order = await this.transitions.lock(tx, d.orderId);
    if (order.status === 'PREPARING' && actor.type === 'PARTNER')
      throw new AppError('PICKUP_NOT_READY', {
        message: 'Wait until the restaurant marks the order ready, or ask them to hand it over.',
      });
    if (order.status !== 'READY_FOR_PICKUP' && order.status !== 'PREPARING')
      throw new AppError('PICKUP_NOT_READY');
    const roadFactor = await this.settings.get('geo.roadFactor');
    const kmph = await this.settings.get('geo.motorbikeKmph');
    const travelMin = (((d.distanceDropM ?? 0) * roadFactor) / 1000 / kmph) * 60 + 3;
    const now = this.now();
    // ETA range ±5 min rounded to 5 (DELIVERY-ASSIGNMENT-ALGORITHM §9).
    const mid = now.getTime() + travelMin * 60_000;
    const round5 = (ms: number) => new Date(Math.round(ms / 300_000) * 300_000);
    const { order: picked } = await this.transitions.apply(tx, {
      orderId: d.orderId,
      to: 'PICKED_UP',
      actor,
      patch: { etaMinAt: round5(mid - 300_000), etaMaxAt: round5(mid + 300_000) },
    });
    if (d.status === 'ASSIGNED' || d.status === 'AT_RESTAURANT')
      await moveDelivery(tx, d, 'EN_ROUTE_TO_CUSTOMER', { actor, now, at });
    return picked;
  }

  /** API-DPDEL-007 (FR-DEL-025, BR-DEL-008): when ready, unless pickup codes are enforced. */
  async pickedUp(userId: string, deliveryId: string, input: { at?: Point | undefined }) {
    if (await this.settings.get('pickup.verifyCode'))
      throw new AppError('PICKUP_NOT_READY', {
        message: 'Show your pickup code to the restaurant; they confirm the handover.',
      });
    const order = await this.prisma.$transaction(async (tx) => {
      const d = await this.mine(tx, userId, deliveryId);
      if (!['ASSIGNED', 'AT_RESTAURANT'].includes(d.status))
        throw new AppError('ORDER_STATE_CONFLICT', { message: 'Already picked up.' });
      return this.pickup(tx, d, { type: 'PARTNER', id: userId }, input.at ?? null);
    });
    await this.timers.afterPickedUp(order);
    return this.view(userId, deliveryId);
  }

  /** API-RORD-009 (FR-RORD-007): the restaurant hands over against the partner's pickup code. */
  async handover(staffUserId: string, orderId: string, code: string) {
    const order = await this.prisma.$transaction(async (tx) => {
      const d0 = await tx.delivery.findUnique({ where: { orderId } });
      if (!d0 || !d0.partnerId)
        throw new AppError('PICKUP_NOT_READY', { message: 'No delivery partner is assigned yet.' });
      const d = await lockDelivery(tx, d0.id);
      if (!['ASSIGNED', 'AT_RESTAURANT'].includes(d.status))
        throw new AppError('ORDER_STATE_CONFLICT', { message: 'Already handed over.' });
      const ok =
        d.pickupCode &&
        d.pickupCode.length === code.length &&
        timingSafeEqual(Buffer.from(d.pickupCode), Buffer.from(code));
      if (!ok) throw new AppError('PICKUP_CODE_INVALID');
      return this.pickup(tx, d, { type: 'RESTAURANT', id: staffUserId }, null);
    });
    await this.timers.afterPickedUp(order);
    const partner = await this.prisma.delivery.findUniqueOrThrow({
      where: { orderId },
      select: { partner: { select: { user: { select: { fullName: true } } } } },
    });
    return {
      orderId,
      status: 'PICKED_UP',
      partner: partner.partner?.user.fullName.split(/\s+/)[0] ?? null,
    };
  }

  /** API-DPDEL-008 (FR-DEL-026, D06) */
  async arrivedAtCustomer(
    userId: string,
    deliveryId: string,
    input: { at?: Point | undefined; confirm?: boolean | undefined },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.mine(tx, userId, deliveryId);
      if (d.status !== 'EN_ROUTE_TO_CUSTOMER')
        throw new AppError('ORDER_STATE_CONFLICT', { message: 'Pick up the order first.' });
      const { drop } = await this.points(d);
      const g = drop
        ? await this.geofence(drop, input.at, 'delivery.customerGeofenceM', Boolean(input.confirm))
        : { distance: null, flagged: false };
      await moveDelivery(tx, d, 'AT_CUSTOMER', {
        actor: { type: 'PARTNER', id: userId },
        now: this.now(),
        at: input.at ?? null,
        distanceToTargetM: g.distance,
        flagged: g.flagged,
      });
    });
    return this.view(userId, deliveryId);
  }

  /**
   * API-DPDEL-009 (FR-DEL-030…033, BR-DEL-009/010, T15/D07): proof, COD cash,
   * order delivered, settlement and partner pay — all or nothing.
   */
  async complete(
    userId: string,
    deliveryId: string,
    input: {
      method: 'OTP' | 'PHOTO';
      otp?: string | undefined;
      photoFileId?: string | undefined;
      cashCollected?: boolean | undefined;
      at?: Point | undefined;
    },
  ) {
    const partnerId = await this.partner(userId);
    // Wrong OTPs are counted even though the completion fails, so check them in their own transaction.
    if (input.method === 'OTP') await this.checkOtp(userId, deliveryId, input.otp ?? '');
    await this.prisma.$transaction(async (tx) => {
      const d = await this.mine(tx, userId, deliveryId);
      if (!['EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'].includes(d.status))
        throw new AppError('ORDER_STATE_CONFLICT', { message: 'This delivery is not on its way.' });
      const order = await this.transitions.lock(tx, d.orderId);
      const cod = order.paymentMethod === 'COD';
      if (cod && input.method !== 'OTP')
        throw new AppError('VALIDATION_ERROR', {
          message: 'Cash orders need the customer’s code.',
        });
      if (cod && !input.cashCollected)
        throw new AppError('VALIDATION_ERROR', {
          details: [
            {
              path: 'cashCollected',
              code: 'REQUIRED',
              message: `Collect ₹${order.payableAmount / 100} in cash first.`,
            },
          ],
        });
      if (input.method === 'PHOTO') {
        if (!order.contactless)
          throw new AppError('VALIDATION_ERROR', {
            message: 'This order needs the customer’s code.',
          });
        if (!input.photoFileId)
          throw new AppError('VALIDATION_ERROR', {
            details: [
              {
                path: 'photoFileId',
                code: 'REQUIRED',
                message: 'Take a photo of the package at the door.',
              },
            ],
          });
        await this.files.claim(tx, {
          fileId: input.photoFileId,
          userId,
          purposes: ['DELIVERY_PROOF'],
        });
      }
      await this.finish(tx, d, order, {
        actor: { type: 'PARTNER', id: userId },
        at: input.at ?? null,
        patch: { proofType: input.method, proofFileId: input.photoFileId ?? null },
      });
    });
    await this.afterTrip(partnerId);
    return this.view(userId, deliveryId);
  }

  /** T15/D07 and everything that follows a handover: COD cash, settlement, pay and stats. */
  private async finish(
    tx: Tx,
    d: Delivery,
    order: Order,
    input: {
      actor: { type: 'PARTNER' | 'ADMIN'; id: string };
      at?: Point | null;
      reason?: string;
      patch: Prisma.DeliveryUncheckedUpdateInput;
    },
  ) {
    const partnerId = d.partnerId!;
    const cod = order.paymentMethod === 'COD';
    const now = this.now();
    const { order: delivered } = await this.transitions.apply(tx, {
      orderId: d.orderId,
      to: 'DELIVERED',
      actor: input.actor,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    const done = await moveDelivery(tx, d, 'DELIVERED', {
      actor: input.actor,
      now,
      at: input.at ?? null,
      patch: input.patch,
    });
    if (cod) {
      // FR-DEL-032: the partner now holds the customer's cash.
      await tx.payment.updateMany({
        where: { orderId: d.orderId, method: 'COD', status: 'PENDING' },
        data: {
          status: 'COLLECTED',
          capturedAmount: order.payableAmount,
          capturedAt: now,
          version: { increment: 1 },
        },
      });
      await this.ledger.post(tx, {
        type: 'COD_COLLECTION',
        referenceType: 'order',
        referenceId: d.orderId,
        description: `Cash collected for order ${order.number}`,
        entries: [
          {
            ownerType: 'PARTNER',
            ownerId: partnerId,
            type: 'PARTNER_CASH_IN_HAND',
            amount: order.payableAmount,
          },
          {
            ownerType: 'ORDER',
            ownerId: d.orderId,
            type: 'CUSTOMER_ORDER_LIABILITY',
            amount: -order.payableAmount,
          },
        ],
      });
    }
    await this.settlement.settle(tx, delivered);
    await this.earnings.recordDelivered(tx, done);
    await tx.partnerStats.update({
      where: { partnerId },
      data: { deliveriesToday: { increment: 1 }, lastDeliveryCompletedAt: now },
    });
  }

  /** The order of an admin action, locked with its delivery (which must be on its way). */
  private async onTheWay(tx: Tx, orderId: string) {
    const d0 = await tx.delivery.findUnique({ where: { orderId }, select: { id: true } });
    if (!d0)
      throw new AppError('ORDER_STATE_CONFLICT', { message: 'This order has no delivery yet.' });
    const d = await lockDelivery(tx, d0.id);
    if (!['EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'].includes(d.status) || !d.partnerId)
      throw new AppError('ORDER_STATE_CONFLICT', {
        message: 'Only an order that has been picked up can be closed this way.',
      });
    return { d, order: await this.transitions.lock(tx, orderId) };
  }

  /**
   * API-ADM-063 (T15 by A ★, D07): ops closes the handover for the partner with
   * an evidence note; settlement and pay are the same as a partner completion.
   */
  async completeByAdmin(
    adminUserId: string,
    orderId: string,
    input: { note: string; cashCollected?: boolean | undefined },
  ) {
    const partnerId = await this.prisma.$transaction(async (tx) => {
      const { d, order } = await this.onTheWay(tx, orderId);
      if (order.paymentMethod === 'COD' && !input.cashCollected)
        throw new AppError('VALIDATION_ERROR', {
          details: [
            {
              path: 'cashCollected',
              code: 'REQUIRED',
              message: 'Confirm the partner collected the cash for this order.',
            },
          ],
        });
      await this.finish(tx, d, order, {
        actor: { type: 'ADMIN', id: adminUserId },
        reason: input.note,
        patch: { proofType: 'ADMIN' },
      });
      return d.partnerId!;
    });
    await this.afterTrip(partnerId);
    return { orderId, status: 'DELIVERED' as const };
  }

  /**
   * API-ADM-064 (T16 by A ★, D10): the delivery failed after pickup. COD is not
   * collected; the money side (refund per cause, BR-REFUND-001) is the orders
   * module's `onFailed`; the partner is paid for the trip (BR-EARN-007).
   * Returns the refunds to submit once committed.
   */
  async failByAdmin(
    adminUserId: string,
    orderId: string,
    input: { cause: 'DELIVERY_FAILED' | 'CUSTOMER_UNREACHABLE'; note: string },
  ): Promise<{ refundIds: string[] }> {
    if (!this.onFailed) throw new Error('failed-delivery handler not registered');
    const onFailed = this.onFailed;
    const actor = { type: 'ADMIN' as const, id: adminUserId };
    let refundIds: string[] = [];
    const partnerId = await this.prisma.$transaction(async (tx) => {
      const { d, order } = await this.onTheWay(tx, orderId);
      await this.transitions.apply(tx, {
        orderId,
        to: 'FAILED',
        actor,
        reason: input.note,
        failureReason: input.cause,
      });
      await moveDelivery(tx, d, 'FAILED', {
        actor,
        now: this.now(),
        patch: { failureReason: `${input.cause}: ${input.note}`.slice(0, 300) },
      });
      await tx.payment.updateMany({
        where: { orderId, method: 'COD', status: 'PENDING' },
        data: { status: 'CANCELLED', version: { increment: 1 } },
      });
      refundIds = await onFailed(tx, order, input.cause, actor);
      await this.dispatch.onCompensate?.(tx, d, 'AFTER_PICKUP');
      return d.partnerId!;
    });
    await this.afterTrip(partnerId);
    return { refundIds };
  }

  /** FR-DEL-030: 4-digit code, at most 5 tries per order, then support takes over. */
  private async checkOtp(userId: string, deliveryId: string, otp: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const d = await this.mine(tx, userId, deliveryId);
      const order = await this.transitions.lock(tx, d.orderId);
      if (order.deliveryOtpAttempts >= MAX_OTP_ATTEMPTS) return 'LOCKED' as const;
      const expected = order.deliveryOtpHash ? Buffer.from(order.deliveryOtpHash) : null;
      const given = deliveryCodeHash(this.secret, order.id, otp);
      const ok = Boolean(
        expected && expected.length === given.length && timingSafeEqual(expected, given),
      );
      await tx.deliveryOtpAttempt.create({
        data: { deliveryId: d.id, success: ok, createdAt: this.now() },
      });
      if (ok) return 'OK' as const;
      const after = await tx.order.update({
        where: { id: order.id },
        data: { deliveryOtpAttempts: { increment: 1 } },
        select: { deliveryOtpAttempts: true },
      });
      if (after.deliveryOtpAttempts >= MAX_OTP_ATTEMPTS)
        await raiseOpsAlert(tx, {
          type: 'DELIVERY_OTP_LOCKED',
          severity: 'WARNING',
          refType: 'order',
          refId: order.id,
          message: `Order ${order.number}: delivery code failed ${MAX_OTP_ATTEMPTS} times.`,
          dedupeKey: `otp-locked:${order.id}`,
        });
      return { left: MAX_OTP_ATTEMPTS - after.deliveryOtpAttempts };
    });
    if (outcome === 'LOCKED') throw new AppError('DELIVERY_OTP_LOCKED');
    if (outcome !== 'OK')
      throw new AppError('DELIVERY_OTP_INVALID', {
        details: [{ path: 'otp', code: 'ATTEMPTS_LEFT', message: String(outcome.left) }],
      });
  }

  /** The partner is free again: idle (or offline if they asked) and a candidate for waiting deliveries. */
  private async afterTrip(partnerId: string) {
    const live = await this.presence.get(partnerId);
    if (!live) return;
    if (live.offlineAfterCurrent) return this.availability.setOffline(partnerId, 'MANUAL');
    await this.presence.put({ ...live, state: 'ONLINE_IDLE' });
    await this.prisma.deliveryPartner.update({
      where: { id: partnerId },
      data: { availabilityState: 'ONLINE_IDLE' },
    });
    await this.dispatch.partnerIdle(partnerId);
  }

  /** API-DPDEL-010 (FR-DEL-034): support takes it from here (10-minute wait, then FAILED by support). */
  async customerUnreachable(
    userId: string,
    deliveryId: string,
    input: { callAttempts: number; note?: string | undefined },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.mine(tx, userId, deliveryId);
      if (d.status !== 'AT_CUSTOMER')
        throw new AppError('ORDER_STATE_CONFLICT', { message: 'Mark that you’ve arrived first.' });
      if (input.callAttempts < 2)
        throw new AppError('VALIDATION_ERROR', {
          details: [
            {
              path: 'callAttempts',
              code: 'MIN',
              message: 'Try calling the customer at least twice.',
            },
          ],
        });
      await writeOutbox(tx, {
        aggregateType: 'delivery',
        aggregateId: d.id,
        aggregateVersion: d.version,
        eventType: 'delivery.customer_unreachable',
        payload: {
          deliveryId: d.id,
          orderId: d.orderId,
          callAttempts: input.callAttempts,
          waitUntil: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
        },
      });
      await raiseOpsAlert(tx, {
        type: 'CUSTOMER_UNREACHABLE',
        severity: 'WARNING',
        refType: 'delivery',
        refId: d.id,
        message:
          `Partner waiting at the door; ${input.callAttempts} call attempts. ${input.note ?? ''}`.trim(),
        dedupeKey: `unreachable:${d.id}`,
      });
      await this.audit.record(
        {
          action: 'delivery.customer_unreachable',
          targetType: 'delivery',
          targetId: d.id,
          actorUserId: userId,
          after: { callAttempts: input.callAttempts },
        },
        tx,
      );
    });
    return { deliveryId, waitMinutes: 10 };
  }

  /** API-DPDEL-011 (FR-DEL-035, BR-DEL-013): before pickup only. */
  async unassign(userId: string, deliveryId: string, reason: string) {
    const partnerId = await this.partner(userId);
    const d = await this.prisma.delivery.findUnique({ where: { id: deliveryId } });
    if (!d || d.partnerId !== partnerId)
      throw new AppError('NOT_FOUND', { message: "We couldn't find that delivery." });
    await this.dispatch.release(deliveryId, reason, { type: 'PARTNER', id: userId });
    const since = new Date(this.now().getTime() - 7 * 86_400_000);
    const recent = await this.prisma.deliveryAssignment.count({
      where: { partnerId, status: 'RELEASED', offeredAt: { gte: since } },
    });
    if (recent > 3)
      await raiseOpsAlert(this.prisma, {
        type: 'PARTNER_UNASSIGNS',
        severity: 'WARNING',
        refType: 'partner',
        refId: partnerId,
        message: `${recent} unassignments in 7 days.`,
        dedupeKey: `unassigns:${partnerId}`,
      });
    return { deliveryId, released: true };
  }

  /**
   * FR-DISP-014 (AC-DEL-009): an assigned partner going silent gets an ops alert
   * at 3 minutes and, before pickup, loses the delivery at 5 minutes.
   */
  async heartbeatSweep(): Promise<{ alerted: number; released: number }> {
    const now = this.now().getTime();
    let alerted = 0;
    let released = 0;
    const active = await this.prisma.delivery.findMany({
      where: {
        status: { in: ['ASSIGNED', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'] },
        partnerId: { not: null },
      },
      select: { id: true, status: true, partnerId: true },
    });
    for (const d of active) {
      const live = await this.presence.get(d.partnerId!);
      const silentFor = live ? now - live.at : Infinity;
      if (silentFor < HEARTBEAT_ALERT_MS) continue;
      if (silentFor >= HEARTBEAT_RELEASE_MS && ['ASSIGNED', 'AT_RESTAURANT'].includes(d.status)) {
        await this.dispatch
          .release(d.id, 'Partner heartbeat lost', { type: 'SYSTEM' })
          .catch((error: unknown) =>
            this.logger.warn({ err: error, deliveryId: d.id }, 'release failed'),
          );
        await raiseOpsAlert(this.prisma, {
          type: 'PARTNER_ABANDONED',
          severity: 'CRITICAL',
          refType: 'partner',
          refId: d.partnerId!,
          message: 'Delivery released after 5 minutes without location.',
          dedupeKey: `abandoned:${d.id}`,
        });
        released++;
      } else {
        await raiseOpsAlert(this.prisma, {
          type: 'PARTNER_HEARTBEAT_LOST',
          severity: 'WARNING',
          refType: 'delivery',
          refId: d.id,
          message: 'No location from the assigned partner for 3 minutes.',
          dedupeKey: `heartbeat:${d.id}`,
        });
        alerted++;
      }
    }
    return { alerted, released };
  }
}
