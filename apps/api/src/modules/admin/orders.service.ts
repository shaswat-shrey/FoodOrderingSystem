import type { CancellationFault, OrderStatus, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import type { SettingsService } from '../config';
import type { DeliveryStagesService } from '../dispatch';
import type { OrderCancellationService, OrderTimers } from '../orders';
import type { RefundService } from '../payments';
import type { AdminActor, Page } from './admin.http';
import { auditAs, maskPhone, pageArgs, pageMeta } from './admin.http';

/** API-ADM-065: how far one extension may push the acceptance timeout. */
export const MAX_ACCEPT_EXTENSION_MINUTES = 15;

/**
 * Admin order search, order 360 and interventions (FR-ADMIN-040/041,
 * API-ADM-060…065, 067). Every intervention is a defined transition through
 * the orders/dispatch services, never an arbitrary status write.
 */
export class AdminOrdersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cancellation: OrderCancellationService,
    private readonly stages: DeliveryStagesService,
    private readonly refunds: RefundService,
    private readonly timers: OrderTimers,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async order(id: string) {
    const o = await this.prisma.order.findUnique({ where: { id } });
    if (!o) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    return o;
  }

  /** API-ADM-060: newest first. `q` is an order number (prefix) or a customer phone. */
  async list(
    filter: Page & {
      q?: string | undefined;
      status?: OrderStatus | undefined;
      zone?: string | undefined;
      restaurantId?: string | undefined;
      partnerId?: string | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
    },
  ) {
    const q = filter.q?.trim();
    const digits = q?.replace(/[\s-]/g, '');
    const phoneLike = digits && /^\+?\d{6,13}$/.test(digits);
    const where: Prisma.OrderWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.zone ? { branch: { zoneId: filter.zone } } : {}),
      ...(filter.restaurantId ? { restaurantId: filter.restaurantId } : {}),
      ...(filter.partnerId ? { delivery: { partnerId: filter.partnerId } } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lt: filter.to } : {}),
            },
          }
        : {}),
      ...(q
        ? phoneLike
          ? {
              OR: [
                { user: { phone: { contains: digits!.slice(-10) } } },
                { contactPhone: { contains: digits!.slice(-10) } },
              ],
            }
          : { number: { startsWith: q.toUpperCase() } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(filter),
        select: {
          id: true,
          number: true,
          status: true,
          refundStatus: true,
          paymentMethod: true,
          totalAmount: true,
          createdAt: true,
          placedAt: true,
          user: { select: { id: true, fullName: true, phone: true } },
          restaurant: { select: { id: true, brandName: true } },
          branch: { select: { id: true, name: true, zoneId: true } },
          delivery: {
            select: {
              id: true,
              status: true,
              escalated: true,
              partner: { select: { id: true, legalName: true } },
            },
          },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return {
      items: rows.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        refundStatus: o.refundStatus,
        paymentMethod: o.paymentMethod,
        totalAmount: o.totalAmount,
        createdAt: o.createdAt,
        placedAt: o.placedAt,
        customer: { id: o.user.id, name: o.user.fullName, phone: maskPhone(o.user.phone) },
        restaurant: { id: o.restaurant.id, name: o.restaurant.brandName },
        branch: { id: o.branch.id, name: o.branch.name, zoneId: o.branch.zoneId },
        delivery: o.delivery
          ? {
              id: o.delivery.id,
              status: o.delivery.status,
              escalated: o.delivery.escalated,
              partner: o.delivery.partner
                ? { id: o.delivery.partner.id, name: o.delivery.partner.legalName }
                : null,
            }
          : null,
      })),
      meta: pageMeta(filter, total),
    };
  }

  /** API-ADM-061: order 360 — items, money, delivery and assignments, timeline, issues. */
  async detail(id: string) {
    const o = await this.prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, fullName: true, phone: true } },
        restaurant: { select: { id: true, brandName: true } },
        branch: { select: { id: true, name: true, zoneId: true } },
        address: { select: { line1: true, area: true, city: true, pincode: true } },
        items: { include: { options: true } },
        priceComponents: { orderBy: { id: 'asc' } },
        payments: { include: { attempts: { orderBy: { createdAt: 'asc' } } } },
        refunds: { include: { items: true }, orderBy: { createdAt: 'asc' } },
        statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        cancellation: true,
        issues: { include: { items: true }, orderBy: { createdAt: 'asc' } },
        delivery: {
          include: {
            partner: { select: { id: true, legalName: true, user: { select: { phone: true } } } },
            assignments: {
              orderBy: { offeredAt: 'asc' },
              include: { partner: { select: { id: true, legalName: true } } },
            },
            statusHistory: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                fromStatus: true,
                toStatus: true,
                actorType: true,
                actorId: true,
                flagged: true,
                distanceToTargetM: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!o) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    const providerOrders = o.payments.map((p) => p.providerOrderId).filter((x): x is string => !!x);
    const webhooks = providerOrders.length
      ? await this.prisma.$queryRaw<
          {
            id: string;
            provider: string;
            eventType: string;
            processingStatus: string;
            receivedAt: Date;
          }[]
        >`
          SELECT id, provider::text AS provider, event_type AS "eventType",
            processing_status::text AS "processingStatus", received_at AS "receivedAt"
          FROM payment_webhook_events
          WHERE payload::text LIKE ANY (${providerOrders.map((p) => `%${p}%`)})
          ORDER BY received_at ASC LIMIT 50`
      : [];
    const d = o.delivery;
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      refundStatus: o.refundStatus,
      failureReason: o.failureReason,
      paymentMethod: o.paymentMethod,
      amounts: {
        itemsSubtotal: o.itemsSubtotalAmount,
        discounts: o.discountTotalAmount,
        fees: o.feesTotalAmount,
        taxes: o.taxTotalAmount,
        tip: o.tipAmount,
        wallet: o.walletAppliedAmount,
        total: o.totalAmount,
        payable: o.payableAmount,
      },
      priceComponents: o.priceComponents.map((c) => ({
        type: c.type,
        code: c.code,
        label: c.label,
        amount: c.amount,
      })),
      customer: { id: o.user.id, name: o.user.fullName, phone: maskPhone(o.user.phone) },
      contact: { name: o.contactName, phone: maskPhone(o.contactPhone) },
      address: o.address,
      restaurant: { id: o.restaurant.id, name: o.restaurant.brandName },
      branch: o.branch,
      items: o.items.map((i) => ({
        id: i.id,
        name: i.itemName,
        variant: i.variantName,
        quantity: i.quantity,
        lineTotal: i.lineTotalAmount,
        options: i.options.map((op) => op.optionName),
      })),
      timestamps: {
        createdAt: o.createdAt,
        placedAt: o.placedAt,
        acceptedAt: o.acceptedAt,
        preparingAt: o.preparingAt,
        readyBy: o.readyBy,
        readyAt: o.readyAt,
        pickedUpAt: o.pickedUpAt,
        deliveredAt: o.deliveredAt,
        cancelledAt: o.cancelledAt,
        acceptExtendedUntil: o.acceptExtendedUntil,
      },
      payments: o.payments.map((p) => ({
        id: p.id,
        method: p.method,
        provider: p.provider,
        providerOrderId: p.providerOrderId,
        status: p.status,
        amount: p.amount,
        capturedAmount: p.capturedAmount,
        refundedAmount: p.refundedAmount,
        instrument: p.instrumentSummary,
        failureCode: p.failureCode,
        attempts: p.attempts.map((a) => ({
          id: a.id,
          providerPaymentId: a.providerPaymentId,
          status: a.status,
          amount: a.amount,
          methodDetail: a.methodDetail,
          errorCode: a.errorCode,
          createdAt: a.createdAt,
        })),
      })),
      webhookEvents: webhooks,
      refunds: o.refunds.map((r) => ({
        id: r.id,
        paymentId: r.paymentId,
        amount: r.amount,
        destination: r.destination,
        status: r.status,
        reasonCode: r.reasonCode,
        note: r.note,
        initiatorType: r.initiatorType,
        costBearer: r.costBearer,
        attempts: r.attempts,
        items: r.items,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
      cancellation: o.cancellation,
      issues: o.issues,
      delivery: d
        ? {
            id: d.id,
            status: d.status,
            escalated: d.escalated,
            searchRound: d.searchRound,
            noPartnerDeadline: d.noPartnerDeadline,
            deadlineExtended: d.deadlineExtended,
            proofType: d.proofType,
            failureReason: d.failureReason,
            partner: d.partner
              ? {
                  id: d.partner.id,
                  name: d.partner.legalName,
                  phone: maskPhone(d.partner.user.phone),
                }
              : null,
            assignments: d.assignments.map((a) => ({
              id: a.id,
              partner: { id: a.partner.id, name: a.partner.legalName },
              status: a.status,
              round: a.round,
              rank: a.rank,
              manual: a.manual,
              assignedBy: a.assignedBy,
              distanceToPickupM: a.distanceToPickupM,
              offeredAt: a.offeredAt,
              expiresAt: a.expiresAt,
              respondedAt: a.respondedAt,
              rejectReason: a.rejectReason,
            })),
            history: d.statusHistory,
          }
        : null,
      statusHistory: o.statusHistory.map((h) => ({
        from: h.fromStatus,
        to: h.toStatus,
        actorType: h.actorType,
        actorId: h.actorId,
        reason: h.reason,
        metadata: h.metadata,
        at: h.createdAt,
      })),
    };
  }

  /** API-ADM-062 ★ (FR-ADMIN-041, BR-ORDER-016): refund follows the fault (BR-REFUND-001). */
  async cancel(
    actor: AdminActor,
    id: string,
    input: { reasonCode: string; fault: CancellationFault; reason: string },
  ) {
    const before = await this.order(id);
    const result = await this.cancellation.cancel({
      orderId: id,
      actor: { type: 'ADMIN', id: actor.userId },
      reasonCode: input.reasonCode,
      note: input.reason,
      fault: input.fault,
    });
    await auditAs(this.audit, actor, {
      action: 'admin.order_cancelled',
      targetType: 'order',
      targetId: id,
      reason: input.reason,
      before: { status: before.status },
      after: {
        status: 'CANCELLED',
        reasonCode: input.reasonCode,
        fault: input.fault,
        refund: result.cancellation.refund.amount,
        fee: result.cancellation.fee,
      },
      sensitivity: 'HIGH',
    });
    return result;
  }

  /** API-ADM-063 ★ (T15 by A): with an evidence note; settles like a partner completion. */
  async markDelivered(
    actor: AdminActor,
    id: string,
    input: { reason: string; cashCollected?: boolean | undefined },
  ) {
    const before = await this.order(id);
    const result = await this.stages.completeByAdmin(actor.userId, id, {
      note: input.reason,
      cashCollected: input.cashCollected,
    });
    await auditAs(this.audit, actor, {
      action: 'admin.order_marked_delivered',
      targetType: 'order',
      targetId: id,
      reason: input.reason,
      before: { status: before.status },
      after: { status: 'DELIVERED', cashCollected: input.cashCollected ?? null },
      sensitivity: 'HIGH',
    });
    return result;
  }

  /** API-ADM-064 ★ (T16): failed after pickup; refund per cause (BR-REFUND-001). */
  async markFailed(
    actor: AdminActor,
    id: string,
    input: { cause: 'DELIVERY_FAILED' | 'CUSTOMER_UNREACHABLE'; reason: string },
  ) {
    const before = await this.order(id);
    const { refundIds } = await this.stages.failByAdmin(actor.userId, id, {
      cause: input.cause,
      note: input.reason,
    });
    for (const r of refundIds) await this.refunds.schedule(r);
    await auditAs(this.audit, actor, {
      action: 'admin.order_marked_failed',
      targetType: 'order',
      targetId: id,
      reason: input.reason,
      before: { status: before.status },
      after: { status: 'FAILED', cause: input.cause, refundIds },
      sensitivity: 'HIGH',
    });
    const refunds = await this.prisma.refund.findMany({
      where: { id: { in: refundIds } },
      select: { id: true, amount: true, destination: true, status: true },
    });
    return { orderId: id, status: 'FAILED' as const, failureReason: input.cause, refunds };
  }

  /** API-ADM-065 ★: the acceptance timeout moves out once, while the order waits for the restaurant. */
  async extendAcceptance(
    actor: AdminActor,
    id: string,
    input: { minutes: number; reason: string },
  ) {
    const timeout = await this.settings.get('order.acceptTimeoutSeconds');
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;
      const o = await tx.order.findUnique({ where: { id } });
      if (!o) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
      if (o.status !== 'PLACED')
        throw new AppError('ORDER_STATE_CONFLICT', {
          message: 'Only an order waiting for the restaurant to accept can be extended.',
          details: [{ code: 'CURRENT_STATUS', message: o.status }],
        });
      if (o.acceptExtendedUntil)
        throw new AppError('ORDER_STATE_CONFLICT', {
          message: 'The acceptance time has already been extended once.',
        });
      const due = new Date((o.placedAt ?? o.createdAt).getTime() + timeout * 1000);
      const from = due > this.clock.now() ? due : this.clock.now();
      const until = new Date(from.getTime() + input.minutes * 60_000);
      await tx.order.update({ where: { id }, data: { acceptExtendedUntil: until } });
      await auditAs(
        this.audit,
        actor,
        {
          action: 'admin.order_acceptance_extended',
          targetType: 'order',
          targetId: id,
          reason: input.reason,
          before: { acceptBy: due.toISOString() },
          after: { acceptBy: until.toISOString() },
          sensitivity: 'HIGH',
        },
        tx,
      );
      return { orderId: id, previousDeadline: due, acceptBy: until };
    });
    await this.timers.afterAcceptanceExtended(id, result.acceptBy);
    return result;
  }

  /** API-ADM-067 (FR-ADMIN-040): admin actions, order and delivery transitions, oldest first. */
  async auditTrail(id: string) {
    const o = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        refunds: { select: { id: true } },
        delivery: { select: { id: true } },
      },
    });
    if (!o) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    const targets = [o.id, ...o.refunds.map((r) => r.id), ...(o.delivery ? [o.delivery.id] : [])];
    const [audit, history, deliveryHistory] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { targetId: { in: targets } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
        include: { actor: { select: { id: true, fullName: true } } },
      }),
      this.prisma.orderStatusHistory.findMany({
        where: { orderId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      o.delivery
        ? this.prisma.deliveryStatusHistory.findMany({
            where: { deliveryId: o.delivery.id },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              fromStatus: true,
              toStatus: true,
              actorType: true,
              actorId: true,
              flagged: true,
              createdAt: true,
            },
          })
        : [],
    ]);
    return {
      orderId: o.id,
      number: o.number,
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        actor: a.actor,
        actorRoles: a.actorRoles,
        reason: a.reason,
        before: a.before,
        after: a.after,
        sensitivity: a.sensitivity,
        at: a.createdAt,
      })),
      statusHistory: history.map((h) => ({
        from: h.fromStatus,
        to: h.toStatus,
        actorType: h.actorType,
        actorId: h.actorId,
        reason: h.reason,
        metadata: h.metadata,
        at: h.createdAt,
      })),
      deliveryHistory: deliveryHistory.map((h) => ({
        from: h.fromStatus,
        to: h.toStatus,
        actorType: h.actorType,
        actorId: h.actorId,
        flagged: h.flagged,
        at: h.createdAt,
      })),
    };
  }
}
