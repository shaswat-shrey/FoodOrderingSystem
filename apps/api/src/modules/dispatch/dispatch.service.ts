import { randomInt, randomUUID } from 'node:crypto';
import type { Delivery, Prisma, PrismaClient } from '@fos/db';
import type { Redis } from 'ioredis';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { JobQueue } from '../../platform/jobs';
import type { Logger } from '../../platform/logger';
import { raiseOpsAlert } from '../../platform/ops-alerts';
import { writeOutbox } from '../../platform/outbox';
import type { SettingsService } from '../config';
import { haversineM } from '../geo';
import type { LedgerService } from '../ledger';
import type { PartnerAvailabilityService, PresenceStore } from '../partners';
import { lockDelivery, moveDelivery } from './delivery-state';
import {
  dispatchStart,
  noPartnerDeadline,
  rank,
  type CandidateFeatures,
  type Scored,
} from './ranking';

type Tx = Prisma.TransactionClient;

export const DISPATCH_JOBS = {
  start: 'dispatch-start',
  offerTimeout: 'offer-timeout',
  retry: 'dispatch-retry',
} as const;

const SLOW_VEHICLES = new Set(['BICYCLE', 'E_BIKE']);
const BICYCLE_KMPH = 12;
const RESPONDED = ['REJECTED', 'RELEASED', 'ACCEPTED', 'REVOKED'] as const;
const EXPIRED_COOLDOWN_MS = 5 * 60_000; // BR-DEL-004
const RETRY_SECONDS = 60; // BR-DEL-003

interface Context {
  delivery: Delivery;
  zoneId: string;
  branch: { lat: number; lng: number };
  drop: { lat: number; lng: number } | null;
  readyBy: Date | null;
  cod: number;
}

/**
 * Sequential-offer dispatch (SRS §12, DELIVERY-ASSIGNMENT-ALGORITHM): one
 * offer at a time to the best eligible partner, rounds of growing radius,
 * escalation, exactly-once acceptance under row locks and partial unique
 * indexes. Every step is idempotent so jobs may repeat.
 */
export class DispatchService {
  /** Set by earnings: pay the partner for a cancelled trip (BR-EARN-007). */
  onCompensate:
    | ((tx: Tx, delivery: Delivery, stage: 'BEFORE_PICKUP' | 'AFTER_PICKUP') => Promise<void>)
    | null = null;
  /** Set by orders: cancel an order nobody would deliver (BR-DEL-003). */
  onNoPartner: ((orderId: string) => Promise<void>) | null = null;
  /** EVT-DP-002/003: an offer the partner may be looking at is gone. */
  onOfferClosed:
    | ((
        partnerId: string,
        offerId: string,
        reason: 'EXPIRED' | 'ORDER_CANCELLED' | 'PARTNER_OFFLINE',
      ) => Promise<void>)
    | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly presence: PresenceStore,
    private readonly availability: PartnerAvailabilityService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly jobs: JobQueue,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  private now() {
    return this.clock.now();
  }

  private schedule(name: string, data: Record<string, unknown>, jobId: string, at?: Date) {
    const delayMs = at ? Math.max(0, at.getTime() - this.now().getTime()) : 0;
    return this.jobs
      .enqueue('dispatch', name, data, { jobId, delayMs })
      .catch((error: unknown) =>
        this.logger.warn({ err: error, job: name, jobId }, 'could not schedule dispatch job'),
      );
  }

  /* ----------------------------- delivery creation ----------------------------- */

  /** D01 on order acceptance (FR-DISP-001). Idempotent per order. */
  async createFor(orderId: string): Promise<Delivery | null> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (
      !order ||
      !order.acceptedAt ||
      !['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status)
    )
      return null;
    const existing = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (existing) return existing;
    const startsAt = dispatchStart({
      acceptedAt: order.acceptedAt,
      readyBy: order.readyBy,
      prepMinutes: order.prepMinutes,
      travelMinutes: await this.settings.get('dispatch.travelToRestaurantMinutes'),
      leadBufferMinutes: await this.settings.get('dispatch.leadBufferMinutes'),
    });
    const deadline = noPartnerDeadline({
      acceptedAt: order.acceptedAt,
      readyBy: order.readyBy,
      afterReadyMinutes: await this.settings.get('dispatch.noPartnerAfterReadyMinutes'),
      afterAcceptMinutes: await this.settings.get('dispatch.noPartnerAfterAcceptMinutes'),
    });
    const [drop] = await this.prisma.$queryRaw<{ m: number }[]>`
      SELECT ST_Distance(b.location, a.location)::int AS m FROM order_addresses a JOIN branches b ON b.id = ${order.branchId}::uuid
      WHERE a.order_id = ${orderId}::uuid`;
    const delivery = await this.prisma.delivery
      .create({
        data: {
          orderId,
          branchId: order.branchId,
          status: 'PENDING',
          dispatchStartsAt: startsAt,
          noPartnerDeadline: deadline,
          pickupCode: String(randomInt(0, 10_000)).padStart(4, '0'),
          distanceDropM: drop?.m ?? null,
        },
      })
      .catch(async (error: unknown) => {
        // Two consumers raced: the other one created it.
        const again = await this.prisma.delivery.findUnique({ where: { orderId } });
        if (again) return again;
        throw error;
      });
    await this.schedule(
      DISPATCH_JOBS.start,
      { deliveryId: delivery.id },
      `dispatch-start-${delivery.id}`,
      startsAt,
    );
    return delivery;
  }

  /** JOB-DISP-001: D02, then the first offer. */
  async start(deliveryId: string): Promise<void> {
    const started = await this.prisma.$transaction(async (tx) => {
      const d = await lockDelivery(tx, deliveryId);
      if (d.status !== 'PENDING') return false;
      await moveDelivery(tx, d, 'SEARCHING', {
        actor: { type: 'SYSTEM' },
        now: this.now(),
        patch: { searchRound: 1 },
      });
      return true;
    });
    if (started) await this.next(deliveryId);
  }

  /* ----------------------------- candidates ----------------------------- */

  private async context(delivery: Delivery): Promise<Context> {
    const [row] = await this.prisma.$queryRaw<
      { zone_id: string; blat: number; blng: number; dlat: number | null; dlng: number | null }[]
    >`
      SELECT b.zone_id, ST_Y(b.location::geometry) AS blat, ST_X(b.location::geometry) AS blng,
        ST_Y(a.location::geometry) AS dlat, ST_X(a.location::geometry) AS dlng
      FROM branches b LEFT JOIN order_addresses a ON a.order_id = ${delivery.orderId}::uuid
      WHERE b.id = ${delivery.branchId}::uuid`;
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: delivery.orderId },
      select: { readyBy: true, paymentMethod: true, payableAmount: true },
    });
    return {
      delivery,
      zoneId: row!.zone_id,
      branch: { lat: Number(row!.blat), lng: Number(row!.blng) },
      drop: row!.dlat !== null ? { lat: Number(row!.dlat), lng: Number(row!.dlng) } : null,
      readyBy: order.readyBy,
      cod: order.paymentMethod === 'COD' ? order.payableAmount : 0,
    };
  }

  /** Partners this delivery must not be offered to (BR-DEL-004). */
  private async exclusions(delivery: Delivery): Promise<Set<string>> {
    const rows = await this.prisma.deliveryAssignment.findMany({
      where: { deliveryId: delivery.id, status: { in: [...RESPONDED, 'EXPIRED', 'OFFERED'] } },
      select: { partnerId: true, status: true, expiresAt: true },
    });
    const now = this.now().getTime();
    return new Set(
      rows
        .filter(
          (r) =>
            !(
              r.status === 'EXPIRED' &&
              delivery.escalated &&
              now - r.expiresAt.getTime() > EXPIRED_COOLDOWN_MS
            ),
        )
        .map((r) => r.partnerId),
    );
  }

  /** FR-DISP-002 / BR-DEL-001: eligible partners for the current round, ranked. */
  async candidates(delivery: Delivery, round: number): Promise<Scored[]> {
    const ctx = await this.context(delivery);
    const radii = await this.settings.get('dispatch.roundRadiiM');
    const radius = radii[Math.min(round, radii.length) - 1]!;
    const near = await this.presence.near(ctx.zoneId, ctx.branch, radius);
    if (!near.length) return [];
    const excluded = await this.exclusions(delivery);
    const now = this.now().getTime();
    const maxAge = (await this.settings.get('partner.locationMaxAgeSeconds')) * 1000;
    const maxAcc = await this.settings.get('partner.locationMaxAccuracyM');
    const cap = await this.settings.get('partner.cashCapAmount');
    const bikePickup = await this.settings.get('dispatch.bicycleMaxPickupM');
    const bikeDrop = await this.settings.get('dispatch.bicycleMaxDropM');
    const roadFactor = await this.settings.get('geo.roadFactor');
    const kmph = await this.settings.get('geo.motorbikeKmph');
    const dropM = ctx.drop ? haversineM(ctx.branch, ctx.drop) * roadFactor : 0;
    const ids = near.map((n) => n.partnerId).filter((id) => !excluded.has(id));
    const partners = await this.prisma.deliveryPartner.findMany({
      where: { id: { in: ids }, status: 'ACTIVE', onboardingStatus: 'APPROVED' },
      include: { stats: true },
    });
    const features: CandidateFeatures[] = [];
    for (const n of near) {
      const p = partners.find((x) => x.id === n.partnerId);
      if (!p) continue;
      const live = await this.presence.get(p.id);
      if (
        !live ||
        live.state !== 'ONLINE_IDLE' ||
        now - live.at > maxAge ||
        live.accuracyM > maxAcc
      )
        continue;
      const slow = SLOW_VEHICLES.has(live.vehicle);
      // BR-DEL-017 / FR-DISP-005: bicycles only on short trips, never in the last round.
      if (slow && (n.distanceM > bikePickup || dropM > bikeDrop || round >= radii.length)) continue;
      if (
        ctx.cod > 0 &&
        (!p.codEnabled || (await this.availability.cashInHand(p.id)) + ctx.cod > cap)
      )
        continue;
      const etaMinutes = ((n.distanceM * roadFactor) / 1000 / (slow ? BICYCLE_KMPH : kmph)) * 60;
      features.push({
        partnerId: p.id,
        distanceM: n.distanceM,
        etaMinutes,
        minutesUntilReady: ctx.readyBy ? (ctx.readyBy.getTime() - now) / 60_000 : 0,
        idleMinutes: p.stats?.lastDeliveryCompletedAt
          ? (now - p.stats.lastDeliveryCompletedAt.getTime()) / 60_000
          : null,
        acceptanceRate: (p.stats?.acceptanceRateBps30d ?? 10_000) / 10_000,
        rating: p.stats?.ratingAvgBps ? p.stats.ratingAvgBps / 100 : null,
        deliveriesToday: p.stats?.deliveriesToday ?? 0,
      });
    }
    return rank(features);
  }

  /* ----------------------------- the offer loop ----------------------------- */

  /** Single-flight per delivery (§6): one dispatcher at a time. */
  private async withLock<T>(deliveryId: string, fn: () => Promise<T>): Promise<T | null> {
    const token = randomUUID();
    const key = `dispatch:${deliveryId}`;
    if ((await this.redis.set(key, token, 'PX', 10_000, 'NX')) !== 'OK') return null;
    try {
      return await fn();
    } finally {
      const held = await this.redis.get(key);
      if (held === token) await this.redis.del(key);
    }
  }

  /** Offer to the next best partner, move to the next round, or escalate. */
  async next(deliveryId: string): Promise<'OFFERED' | 'ESCALATED' | 'IDLE' | 'BUSY'> {
    const out = await this.withLock(deliveryId, async () => {
      for (;;) {
        const d = await this.prisma.delivery.findUnique({ where: { id: deliveryId } });
        if (!d || d.status !== 'SEARCHING') return 'IDLE' as const;
        if (
          await this.prisma.deliveryAssignment.count({ where: { deliveryId, status: 'OFFERED' } })
        )
          return 'IDLE' as const;
        if (d.noPartnerDeadline && this.now() >= d.noPartnerDeadline) {
          await this.onNoPartner?.(d.orderId);
          return 'IDLE' as const;
        }
        const radii = await this.settings.get('dispatch.roundRadiiM');
        const perRound = await this.settings.get('dispatch.offersPerRound');
        const round = Math.max(1, d.searchRound);
        const offered = await this.prisma.deliveryAssignment.count({
          where: { deliveryId, round },
        });
        const ranked = offered < perRound || d.escalated ? await this.candidates(d, round) : [];
        for (const c of ranked) {
          if (await this.offer(d, c, round)) return 'OFFERED' as const;
        }
        if (round < radii.length) {
          await this.prisma.delivery.update({
            where: { id: deliveryId },
            data: { searchRound: round + 1 },
          });
          continue;
        }
        if (!d.escalated) {
          await this.prisma.delivery.update({
            where: { id: deliveryId },
            data: { escalated: true },
          });
          await raiseOpsAlert(this.prisma, {
            type: 'DISPATCH_ESCALATED',
            severity: 'CRITICAL',
            refType: 'delivery',
            refId: deliveryId,
            message: 'No delivery partner accepted after three rounds.',
            dedupeKey: `escalated:${deliveryId}`,
          });
        }
        // Re-search every minute at the largest radius (BR-DEL-003).
        await this.schedule(
          DISPATCH_JOBS.retry,
          { deliveryId },
          `dispatch-retry-${deliveryId}-${Math.floor(this.now().getTime() / 1000)}`,
          new Date(this.now().getTime() + RETRY_SECONDS * 1000),
        );
        return 'ESCALATED' as const;
      }
    });
    if (out === null) {
      // Another dispatcher holds this delivery; check back shortly.
      await this.schedule(
        DISPATCH_JOBS.retry,
        { deliveryId },
        `dispatch-retry-${deliveryId}-${Math.floor(this.now().getTime() / 1000)}`,
        new Date(this.now().getTime() + 2_000),
      );
      return 'BUSY';
    }
    return out;
  }

  /** Creates one offer; false when the partner was taken meanwhile. */
  private async offer(d: Delivery, c: Scored, round: number): Promise<boolean> {
    const timeout = await this.settings.get('dispatch.offerTimeoutSeconds');
    if (!(await this.presence.claimOfferSlot(c.partnerId, timeout + 5))) return false;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + timeout * 1000);
    try {
      const a = await this.prisma.$transaction(async (tx) => {
        const created = await tx.deliveryAssignment.create({
          data: {
            deliveryId: d.id,
            partnerId: c.partnerId,
            round,
            rank: (await tx.deliveryAssignment.count({ where: { deliveryId: d.id, round } })) + 1,
            score: Math.round(c.score * 10_000),
            scoreBreakdown: {
              ...c.breakdown,
              distanceM: c.distanceM,
              etaMinutes: Math.round(c.etaMinutes * 10) / 10,
            },
            distanceToPickupM: c.distanceM,
            offeredAt: now,
            expiresAt,
          },
        });
        await writeOutbox(tx, {
          aggregateType: 'delivery',
          aggregateId: d.id,
          aggregateVersion: d.version,
          eventType: 'delivery.offer_created',
          payload: {
            deliveryId: d.id,
            assignmentId: created.id,
            partnerId: c.partnerId,
            expiresAt: expiresAt.toISOString(),
          },
        });
        return created;
      });
      await this.presence.setState(c.partnerId, 'OFFERED');
      await this.schedule(
        DISPATCH_JOBS.offerTimeout,
        { assignmentId: a.id },
        `offer-timeout-${a.id}`,
        expiresAt,
      );
      return true;
    } catch (error) {
      // The partial unique index says the partner already holds an offer.
      await this.presence.releaseOfferSlot(c.partnerId);
      this.logger.debug({ err: error, partnerId: c.partnerId }, 'offer not created');
      return false;
    }
  }

  /* ----------------------------- partner responses ----------------------------- */

  private async partnerId(userId: string) {
    const p = await this.prisma.deliveryPartner.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!p) throw new AppError('FORBIDDEN');
    return p.id;
  }

  /** API-DPDEL-001: the open offer, if any (reconnect recovery). */
  async currentOffer(userId: string) {
    const partnerId = await this.partnerId(userId);
    const open = await this.prisma.deliveryAssignment.findFirst({
      where: { partnerId, status: 'OFFERED', expiresAt: { gt: this.now() } },
      select: { id: true },
    });
    return open ? this.offerView(open.id) : null;
  }

  /** The offer card (EVT-DP-001 and API-DPDEL-001 share it). */
  async offerView(assignmentId: string) {
    const a = await this.prisma.deliveryAssignment.findFirst({
      where: { id: assignmentId, status: 'OFFERED' },
      include: {
        delivery: {
          include: {
            order: {
              select: {
                number: true,
                paymentMethod: true,
                payableAmount: true,
                items: { select: { quantity: true } },
              },
            },
            branch: {
              select: { name: true, area: true, restaurant: { select: { brandName: true } } },
            },
          },
        },
      },
    });
    if (!a) return null;
    const drop = await this.prisma.orderAddress.findUnique({
      where: { orderId: a.delivery.orderId },
      select: { area: true },
    });
    return {
      offerId: a.id,
      deliveryId: a.deliveryId,
      expiresAt: a.expiresAt,
      serverTime: this.now(),
      restaurant: {
        name: a.delivery.branch.restaurant.brandName,
        branch: a.delivery.branch.name,
        area: a.delivery.branch.area,
        distanceKm: Math.round(a.distanceToPickupM / 100) / 10,
      },
      drop: {
        area: drop?.area ?? null,
        distanceKm: a.delivery.distanceDropM
          ? Math.round(a.delivery.distanceDropM / 100) / 10
          : null,
      },
      items: a.delivery.order.items.reduce((s, i) => s + i.quantity, 0),
      payment:
        a.delivery.order.paymentMethod === 'COD'
          ? { type: 'COD', collect: a.delivery.order.payableAmount }
          : { type: 'PREPAID' },
    };
  }

  /** API-DPDEL-002 (FR-DISP-006, AC-DEL-003): exactly one partner wins. */
  async accept(userId: string, offerId: string) {
    const partnerId = await this.partnerId(userId);
    const a0 = await this.prisma.deliveryAssignment.findUnique({ where: { id: offerId } });
    if (!a0 || a0.partnerId !== partnerId)
      throw new AppError('NOT_FOUND', { message: "We couldn't find that offer." });
    const token = randomUUID();
    const lockKey = `lock:delivery:${a0.deliveryId}`;
    if ((await this.redis.set(lockKey, token, 'PX', 5_000, 'NX')) !== 'OK')
      throw new AppError('OFFER_NOT_AVAILABLE', { retryable: true });
    try {
      const delivery = await this.prisma.$transaction(async (tx) => {
        const d = await lockDelivery(tx, a0.deliveryId);
        await tx.$queryRaw`SELECT id FROM delivery_assignments WHERE id = ${offerId}::uuid FOR UPDATE`;
        const a = await tx.deliveryAssignment.findUniqueOrThrow({ where: { id: offerId } });
        if (
          d.status !== 'SEARCHING' ||
          d.partnerId ||
          a.status !== 'OFFERED' ||
          a.expiresAt <= this.now()
        )
          throw new AppError('OFFER_NOT_AVAILABLE');
        const p = await tx.deliveryPartner.findUniqueOrThrow({
          where: { id: partnerId },
          select: { status: true },
        });
        if (p.status !== 'ACTIVE') throw new AppError('FORBIDDEN');
        await tx.deliveryAssignment.update({
          where: { id: offerId },
          data: { status: 'ACCEPTED', respondedAt: this.now() },
        });
        const moved = await moveDelivery(tx, d, 'ASSIGNED', {
          actor: { type: 'PARTNER', id: userId },
          now: this.now(),
          patch: { partnerId, distancePickupM: a.distanceToPickupM },
        });
        await tx.partnerStats.update({
          where: { partnerId },
          data: { consecutiveMissedOffers: 0 },
        });
        return moved;
      });
      await this.presence.setState(partnerId, 'ON_DELIVERY');
      await this.presence.releaseOfferSlot(partnerId);
      await this.refreshAcceptance(partnerId);
      return delivery;
    } finally {
      if ((await this.redis.get(lockKey)) === token) await this.redis.del(lockKey);
    }
  }

  /** API-DPDEL-003 (FR-DEL-003) */
  async reject(userId: string, offerId: string, reason?: string) {
    const partnerId = await this.partnerId(userId);
    const a = await this.prisma.deliveryAssignment.findUnique({ where: { id: offerId } });
    if (!a || a.partnerId !== partnerId)
      throw new AppError('NOT_FOUND', { message: "We couldn't find that offer." });
    const { count } = await this.prisma.deliveryAssignment.updateMany({
      where: { id: offerId, status: 'OFFERED' },
      data: { status: 'REJECTED', respondedAt: this.now(), rejectReason: reason ?? null },
    });
    if (!count) throw new AppError('OFFER_NOT_AVAILABLE');
    await this.backToIdle(partnerId);
    await this.refreshAcceptance(partnerId);
    await this.next(a.deliveryId);
  }

  /** JOB-DISP-002 (FR-DEL-004): unanswered offers expire; three in a row → offline (BR-DEL-006). */
  async expire(assignmentId: string) {
    const a = await this.prisma.deliveryAssignment.findUnique({ where: { id: assignmentId } });
    if (!a) return;
    const { count } = await this.prisma.deliveryAssignment.updateMany({
      where: { id: assignmentId, status: 'OFFERED' },
      data: { status: 'EXPIRED' },
    });
    if (count) {
      const stats = await this.prisma.partnerStats.update({
        where: { partnerId: a.partnerId },
        data: { consecutiveMissedOffers: { increment: 1 } },
      });
      await this.presence.releaseOfferSlot(a.partnerId);
      await this.onOfferClosed?.(a.partnerId, a.id, 'EXPIRED');
      if (stats.consecutiveMissedOffers >= (await this.settings.get('partner.missedOffersOffline')))
        await this.availability.setOffline(a.partnerId, 'AUTO_MISSED_OFFERS');
      else await this.backToIdle(a.partnerId);
      await this.refreshAcceptance(a.partnerId);
    }
    await this.next(a.deliveryId);
  }

  /** The partner left (offline, suspended) while holding an offer: WITHDRAWN, next candidate. */
  async withdrawFor(partnerId: string) {
    const open = await this.prisma.deliveryAssignment.findMany({
      where: { partnerId, status: 'OFFERED' },
    });
    for (const a of open) {
      const { count } = await this.prisma.deliveryAssignment.updateMany({
        where: { id: a.id, status: 'OFFERED' },
        data: { status: 'WITHDRAWN' },
      });
      await this.presence.releaseOfferSlot(partnerId);
      if (count) await this.onOfferClosed?.(partnerId, a.id, 'PARTNER_OFFLINE');
      await this.next(a.deliveryId);
    }
  }

  /** A partner became free: waiting deliveries in their zone get another try. */
  async partnerIdle(partnerId: string) {
    const live = await this.presence.get(partnerId);
    if (!live?.zoneId) return;
    const waiting = await this.prisma.delivery.findMany({
      where: {
        status: 'SEARCHING',
        branch: { zoneId: live.zoneId },
        assignments: { none: { status: 'OFFERED' } },
      },
      orderBy: [{ escalated: 'desc' }, { createdAt: 'asc' }],
      take: 5,
      select: { id: true },
    });
    for (const d of waiting)
      if (
        (await this.next(d.id)) === 'OFFERED' &&
        (await this.presence.get(partnerId))?.state !== 'ONLINE_IDLE'
      )
        break;
  }

  private async backToIdle(partnerId: string) {
    const live = await this.presence.get(partnerId);
    if (!live || live.state === 'OFFLINE') return;
    if (live.offlineAfterCurrent) return this.availability.setOffline(partnerId, 'MANUAL');
    await this.presence.put({ ...live, state: 'ONLINE_IDLE' });
    await this.prisma.deliveryPartner.update({
      where: { id: partnerId },
      data: { availabilityState: 'ONLINE_IDLE' },
    });
  }

  /** BR-DEL-005: accepted / (accepted + rejected + expired) over 30 days. */
  private async refreshAcceptance(partnerId: string) {
    const since = new Date(this.now().getTime() - 30 * 86_400_000);
    const rows = await this.prisma.deliveryAssignment.groupBy({
      by: ['status'],
      where: {
        partnerId,
        offeredAt: { gte: since },
        manual: false,
        status: { in: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'RELEASED'] },
      },
      _count: { _all: true },
    });
    const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
    const accepted = n('ACCEPTED') + n('RELEASED');
    const total = accepted + n('REJECTED') + n('EXPIRED');
    await this.prisma.partnerStats.update({
      where: { partnerId },
      data: { acceptanceRateBps30d: total ? Math.round((accepted / total) * 10_000) : 10_000 },
    });
  }

  /* ----------------------------- release and cancellation ----------------------------- */

  /**
   * FR-DEL-035 / FR-DISP-014: before pickup the partner is unassigned
   * (RELEASED) and the delivery searches again, first in line.
   */
  async release(
    deliveryId: string,
    reason: string,
    actor: { type: 'PARTNER' | 'SYSTEM' | 'ADMIN'; id?: string | null },
  ) {
    const partnerId = await this.prisma.$transaction(async (tx) => {
      const d = await lockDelivery(tx, deliveryId);
      if (!['ASSIGNED', 'AT_RESTAURANT'].includes(d.status) || !d.partnerId)
        throw new AppError('ORDER_STATE_CONFLICT', {
          message: 'This delivery can’t be released now. Contact support.',
        });
      await tx.deliveryAssignment.updateMany({
        where: { deliveryId, partnerId: d.partnerId, status: 'ACCEPTED' },
        data: { status: 'RELEASED', rejectReason: reason.slice(0, 200) },
      });
      await moveDelivery(tx, d, 'SEARCHING', {
        actor,
        now: this.now(),
        patch: { partnerId: null, assignedAt: null, arrivedRestaurantAt: null },
      });
      return d.partnerId;
    });
    await this.backToIdle(partnerId);
    await this.refreshAcceptance(partnerId);
    await this.next(deliveryId);
  }

  /**
   * The order was cancelled or rejected: open offers are withdrawn, the
   * delivery ends, an assigned partner is freed and compensated (BR-EARN-007).
   */
  async cancelForOrder(orderId: string) {
    const d0 = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (!d0) return;
    let freed: string | null = null;
    let withdrawn: { id: string; partnerId: string }[] = [];
    await this.prisma.$transaction(async (tx) => {
      const d = await lockDelivery(tx, d0.id);
      if (['DELIVERED', 'FAILED', 'CANCELLED'].includes(d.status)) return;
      const offers = await tx.deliveryAssignment.findMany({
        where: { deliveryId: d.id, status: 'OFFERED' },
      });
      await tx.deliveryAssignment.updateMany({
        where: { deliveryId: d.id, status: 'OFFERED' },
        data: { status: 'WITHDRAWN' },
      });
      withdrawn = offers;
      for (const o of offers) {
        await this.presence.releaseOfferSlot(o.partnerId);
        freed = o.partnerId;
      }
      if (['EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'].includes(d.status)) {
        // After pickup the order can't be cancelled (T16 handles failure); nothing to do here.
        return;
      }
      await moveDelivery(tx, d, 'CANCELLED', { actor: { type: 'SYSTEM' }, now: this.now() });
      if (d.partnerId) {
        freed = d.partnerId;
        await this.onCompensate?.(tx, d, 'BEFORE_PICKUP');
      }
    });
    for (const o of withdrawn) await this.onOfferClosed?.(o.partnerId, o.id, 'ORDER_CANCELLED');
    if (freed) await this.backToIdle(freed);
  }

  /** JOB-DISP-003: escalated searches retry every minute until found or the deadline passes. */
  async retry(deliveryId: string) {
    await this.next(deliveryId);
  }

  /** JOB-ORD-007-style self-healing: searches with no open offer and no pending timer get a nudge. */
  async sweep(): Promise<number> {
    const stuck = await this.prisma.delivery.findMany({
      where: {
        OR: [
          { status: 'SEARCHING', assignments: { none: { status: 'OFFERED' } } },
          { status: 'PENDING', dispatchStartsAt: { lte: this.now() } },
        ],
      },
      select: { id: true, status: true },
      take: 200,
    });
    for (const d of stuck) {
      if (d.status === 'PENDING') await this.start(d.id);
      else await this.next(d.id);
    }
    // Offers whose timeout job was lost.
    const late = await this.prisma.deliveryAssignment.findMany({
      where: { status: 'OFFERED', expiresAt: { lt: new Date(this.now().getTime() - 5_000) } },
      select: { id: true },
      take: 200,
    });
    for (const a of late) await this.expire(a.id);
    return stuck.length + late.length;
  }
}
