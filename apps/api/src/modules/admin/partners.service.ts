import type {
  AccountStatus,
  OnboardingStatus,
  OnlineSessionEndReason,
  PartnerDocumentType,
  Prisma,
  PrismaClient,
} from '@fos/db';
import { uuidv7 } from '@fos/shared';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import type { AuditService } from '../audit';
import type { LedgerService } from '../ledger';
import type {
  PartnerAvailabilityService,
  PartnerFinanceService,
  PartnerOnboardingService,
  PresenceStore,
} from '../partners';
import type { AdminActor, Page } from './admin.http';
import { maskPhone, pageArgs, pageMeta } from './admin.http';
import type { PartnerOffliner } from './users.service';

type Tx = Prisma.TransactionClient;

/** Bound on one earnings adjustment (₹10,000); maker-checker above ₹1,000 is CORE (BR-ADMIN-003). */
export const MAX_EARNING_ADJUSTMENT = 1_000_000;

const cashAccount = (partnerId: string) => ({
  ownerType: 'PARTNER' as const,
  ownerId: partnerId,
  type: 'PARTNER_CASH_IN_HAND' as const,
});
const payableAccount = (partnerId: string) => ({
  ownerType: 'PARTNER' as const,
  ownerId: partnerId,
  type: 'PARTNER_PAYABLE' as const,
});

/** Delivery-partner applications and management (FR-ADMIN-030/031, FR-EARN-004/005, API-ADM-041…054). */
export class AdminPartnersService implements PartnerOffliner {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly onboarding: PartnerOnboardingService,
    private readonly availability: PartnerAvailabilityService,
    private readonly finance: PartnerFinanceService,
    private readonly presence: PresenceStore,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  private record(
    actor: AdminActor,
    entry: {
      action: string;
      targetId: string;
      reason?: string | null;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      sensitivity?: 'NORMAL' | 'HIGH';
      targetType?: string;
    },
    tx?: Tx,
  ) {
    return this.audit.record(
      {
        action: entry.action,
        targetType: entry.targetType ?? 'partner',
        targetId: entry.targetId,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        sessionId: actor.sessionId,
        reason: entry.reason ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        sensitivity: entry.sensitivity ?? 'HIGH',
      },
      tx,
    );
  }

  private async partner(id: string) {
    const p = await this.prisma.deliveryPartner.findUnique({ where: { id } });
    if (!p) throw new AppError('NOT_FOUND', { message: "We couldn't find that partner." });
    return p;
  }

  private async approved(id: string) {
    const p = await this.partner(id);
    if (p.onboardingStatus !== 'APPROVED')
      throw new AppError('APPLICATION_STATE_CONFLICT', {
        message: 'This partner hasn’t been approved yet.',
      });
    return p;
  }

  /* ---------------- applications (API-ADM-041…045) ---------------- */

  /** API-ADM-041: oldest first (default: submitted or under review). */
  async applications(
    filter: Page & { status?: OnboardingStatus | undefined; zone?: string | undefined },
  ) {
    const where: Prisma.DeliveryPartnerWhereInput = {
      onboardingStatus: filter.status ?? { in: ['SUBMITTED', 'UNDER_REVIEW'] },
      ...(filter.zone ? { homeZoneId: filter.zone } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.deliveryPartner.findMany({
        where,
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(filter),
        select: {
          id: true,
          legalName: true,
          onboardingStatus: true,
          submissionCount: true,
          createdAt: true,
          updatedAt: true,
          homeZone: { select: { id: true, name: true } },
          vehicles: { where: { isActive: true, deletedAt: null }, select: { type: true } },
          user: { select: { id: true, phone: true } },
        },
      }),
      this.prisma.deliveryPartner.count({ where }),
    ]);
    return {
      items: rows.map((p) => ({
        id: p.id,
        userId: p.user.id,
        legalName: p.legalName,
        phone: maskPhone(p.user.phone),
        status: p.onboardingStatus,
        submissionCount: p.submissionCount,
        zone: p.homeZone,
        vehicleType: p.vehicles[0]?.type ?? null,
        createdAt: p.createdAt,
        waitingSince: p.updatedAt,
      })),
      meta: pageMeta(filter, total),
    };
  }

  /** API-ADM-042: the application as submitted (PAN, Aadhaar and bank masked). */
  async application(id: string) {
    const p = await this.prisma.deliveryPartner.findUnique({
      where: { id },
      include: { user: { select: { id: true, fullName: true, phone: true } } },
    });
    if (!p) throw new AppError('NOT_FOUND', { message: "We couldn't find that partner." });
    const view = await this.onboarding.view(p.userId);
    return {
      ...view!,
      user: { id: p.user.id, fullName: p.user.fullName, phone: maskPhone(p.user.phone) },
      submissionCount: p.submissionCount,
      rejectedReason: p.rejectedReason,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /** API-ADM-043…045 */
  async decide(
    actor: AdminActor,
    id: string,
    input: {
      decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
      reason?: string | undefined;
      documentNotes?: Partial<Record<PartnerDocumentType, string>> | undefined;
    },
  ) {
    await this.partner(id);
    await this.onboarding.decide(
      actor.userId,
      id,
      {
        decision: input.decision,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.documentNotes ? { documentNotes: input.documentNotes } : {}),
      },
      { sessionId: actor.sessionId, actorRoles: actor.roles },
    );
    return this.application(id);
  }

  /** API-ADM-054 ★ */
  verifyVehicle(
    actor: AdminActor,
    vehicleId: string,
    input: { decision: 'VERIFIED' | 'REJECTED'; reason: string },
  ) {
    return this.onboarding.verifyVehicle(actor.userId, vehicleId, input, {
      sessionId: actor.sessionId,
      actorRoles: actor.roles,
    });
  }

  /* ---------------- partners (API-ADM-046…053) ---------------- */

  /** API-ADM-046: approved partners; `online` reads the live presence set. */
  async list(
    filter: Page & {
      status?: AccountStatus | undefined;
      online?: boolean | undefined;
      zone?: string | undefined;
      q?: string | undefined;
    },
  ) {
    const q = filter.q?.trim();
    const online = filter.online === undefined ? null : await this.presence.online();
    const where: Prisma.DeliveryPartnerWhereInput = {
      onboardingStatus: 'APPROVED',
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.zone ? { homeZoneId: filter.zone } : {}),
      ...(online ? (filter.online ? { id: { in: online } } : { id: { notIn: online } }) : {}),
      ...(q
        ? {
            OR: [
              { legalName: { contains: q, mode: 'insensitive' } },
              { user: { fullName: { contains: q, mode: 'insensitive' } } },
              { user: { phone: { contains: q.replace(/[\s-]/g, '') } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.deliveryPartner.findMany({
        where,
        orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
        ...pageArgs(filter),
        select: {
          id: true,
          legalName: true,
          status: true,
          homeZone: { select: { id: true, name: true } },
          user: { select: { id: true, phone: true } },
          stats: { select: { ratingAvgBps: true, ratingCount: true, deliveriesToday: true } },
        },
      }),
      this.prisma.deliveryPartner.count({ where }),
    ]);
    const live = await Promise.all(rows.map((p) => this.presence.get(p.id)));
    return {
      items: rows.map((p, i) => ({
        id: p.id,
        userId: p.user.id,
        legalName: p.legalName,
        phone: maskPhone(p.user.phone),
        status: p.status,
        zone: p.homeZone,
        availability: live[i]?.state ?? 'OFFLINE',
        rating: p.stats?.ratingCount
          ? { average: (p.stats.ratingAvgBps ?? 0) / 100, count: p.stats.ratingCount }
          : null,
        deliveriesToday: p.stats?.deliveriesToday ?? 0,
      })),
      meta: pageMeta(filter, total),
    };
  }

  /** API-ADM-047: partner 360 — status, live position, active delivery, money and performance. */
  async detail(id: string) {
    const p = await this.approved(id);
    const [profile, live, active, cashInHand, payable, performance, recentDeliveries] =
      await Promise.all([
        this.application(id),
        this.presence.get(id),
        this.availability.activeDelivery(id),
        this.availability.cashInHand(id),
        this.ledger.balance(this.prisma, payableAccount(id)),
        this.finance.performance(p.userId),
        this.prisma.delivery.findMany({
          where: { partnerId: id },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            status: true,
            createdAt: true,
            deliveredAt: true,
            order: { select: { id: true, number: true } },
          },
        }),
      ]);
    return {
      ...profile,
      accountStatus: p.status,
      presence: live
        ? {
            state: live.state,
            zoneId: live.zoneId,
            location: live.state === 'OFFLINE' ? null : { lat: live.lat, lng: live.lng },
            at: new Date(live.at),
            offlineAfterCurrent: live.offlineAfterCurrent,
          }
        : { state: 'OFFLINE' },
      activeDelivery: active
        ? { id: active.id, orderId: active.orderId, status: active.status }
        : null,
      cashInHand,
      earningsBalance: payable,
      performance,
      recentDeliveries,
    };
  }

  /**
   * Takes a partner off dispatch now; with a delivery in progress they finish it
   * first (FR-AUTH-040: the active delivery is completed or reassigned by ops).
   */
  private async takeOffline(partnerId: string, reason: OnlineSessionEndReason) {
    if (await this.availability.activeDelivery(partnerId)) {
      const live = await this.presence.get(partnerId);
      if (live && live.state !== 'OFFLINE')
        await this.presence.put({ ...live, offlineAfterCurrent: true });
      return { offline: false, offlineAfterCurrentDelivery: true };
    }
    await this.availability.setOffline(partnerId, reason);
    return { offline: true, offlineAfterCurrentDelivery: false };
  }

  /** A suspended user who is also a partner leaves dispatch (FR-AUTH-040). */
  async forceOfflineForUser(userId: string, reason: 'SUSPENDED') {
    const p = await this.prisma.deliveryPartner.findUnique({
      where: { userId },
      select: { id: true, onboardingStatus: true },
    });
    if (p?.onboardingStatus === 'APPROVED') await this.takeOffline(p.id, reason);
  }

  private async setStatus(actor: AdminActor, id: string, to: AccountStatus, reason: string) {
    const p = await this.approved(id);
    const from: AccountStatus = to === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
    if (p.status !== from)
      throw new AppError('ACCOUNT_STATE_CONFLICT', {
        message:
          to === 'SUSPENDED'
            ? 'This partner is already suspended.'
            : 'This partner isn’t suspended.',
      });
    await this.prisma.$transaction(async (tx) => {
      await tx.deliveryPartner.update({ where: { id }, data: { status: to } });
      await writeOutbox(tx, {
        aggregateType: 'partner',
        aggregateId: id,
        aggregateVersion: p.submissionCount,
        eventType: to === 'SUSPENDED' ? 'partner.suspended' : 'partner.unsuspended',
        payload: { partnerId: id, userId: p.userId },
      });
      await this.record(
        actor,
        {
          action: to === 'SUSPENDED' ? 'admin.partner_suspended' : 'admin.partner_unsuspended',
          targetId: id,
          reason,
          before: { status: p.status },
          after: { status: to },
        },
        tx,
      );
    });
  }

  /** API-ADM-048 ★: no new offers; offline now (or after the current delivery). */
  async suspend(actor: AdminActor, id: string, reason: string) {
    await this.setStatus(actor, id, 'SUSPENDED', reason);
    const offline = await this.takeOffline(id, 'SUSPENDED');
    return { id, status: 'SUSPENDED' as const, ...offline };
  }

  /** API-ADM-049 ★ */
  async unsuspend(actor: AdminActor, id: string, reason: string) {
    await this.setStatus(actor, id, 'ACTIVE', reason);
    return { id, status: 'ACTIVE' as const };
  }

  /** API-ADM-050 ★ */
  async forceOffline(actor: AdminActor, id: string, reason: string) {
    await this.approved(id);
    const live = await this.presence.get(id);
    const result = await this.takeOffline(id, 'ADMIN_FORCED');
    await this.record(actor, {
      action: 'admin.partner_forced_offline',
      targetId: id,
      reason,
      before: { state: live?.state ?? 'OFFLINE' },
      after: result,
    });
    return { id, ...result };
  }

  /** API-ADM-051 ★ (FR-EARN-005): cash handed over lowers the partner's cash in hand. */
  async recordCashDeposit(
    actor: AdminActor,
    id: string,
    input: {
      amount: number;
      method: 'HUB' | 'UPI' | 'BANK';
      reference?: string | undefined;
      reason: string;
    },
  ) {
    await this.approved(id);
    const depositId = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const account = await this.ledger.account(tx, cashAccount(id));
      await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE id = ${account.id}::uuid FOR UPDATE`;
      const held = await this.ledger.balance(tx, cashAccount(id));
      if (input.amount > held)
        throw new AppError('VALIDATION_ERROR', {
          message: 'This is more than the cash the partner holds.',
          details: [{ path: 'amount', code: 'EXCEEDS_CASH_IN_HAND', message: String(held) }],
        });
      await this.ledger.post(tx, {
        type: 'CASH_DEPOSIT',
        referenceType: 'cash_deposit',
        referenceId: depositId,
        description: `Cash deposited (${input.method.toLowerCase()})`,
        createdBy: actor.userId,
        entries: [
          { ownerType: 'PLATFORM', ownerId: null, type: 'CASH_CLEARING', amount: input.amount },
          { ...cashAccount(id), amount: -input.amount },
        ],
      });
      await this.record(
        actor,
        {
          action: 'admin.partner_cash_deposit',
          targetId: id,
          reason: input.reason,
          before: { cashInHand: held },
          after: {
            depositId,
            amount: input.amount,
            method: input.method,
            reference: input.reference ?? null,
          },
        },
        tx,
      );
    });
    return { depositId, amount: input.amount, cashInHand: await this.availability.cashInHand(id) };
  }

  /** API-ADM-052 ★ (FR-EARN-004): + credits the partner, − debits; shown in their statement. */
  async adjustEarnings(
    actor: AdminActor,
    id: string,
    input: { amount: number; note?: string | undefined; reason: string },
  ) {
    const p = await this.approved(id);
    if (p.userId === actor.userId)
      throw new AppError('FORBIDDEN', { message: 'You can’t adjust your own earnings.' });
    const adjustmentId = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.post(tx, {
        type: 'ADJUSTMENT',
        referenceType: 'earning_adjustment',
        referenceId: adjustmentId,
        description:
          input.note ?? (input.amount > 0 ? 'Earnings adjustment' : 'Earnings deduction'),
        createdBy: actor.userId,
        entries: [
          {
            ownerType: 'PLATFORM',
            ownerId: null,
            type: 'PLATFORM_DELIVERY_COST',
            amount: input.amount,
          },
          { ...payableAccount(id), amount: -input.amount },
        ],
      });
      await this.record(
        actor,
        {
          action: 'admin.partner_earnings_adjusted',
          targetId: id,
          reason: input.reason,
          after: { adjustmentId, amount: input.amount, note: input.note ?? null },
        },
        tx,
      );
    });
    return {
      adjustmentId,
      amount: input.amount,
      earningsBalance: await this.ledger.balance(this.prisma, payableAccount(id)),
    };
  }

  /** API-ADM-053 (FR-ADMIN-040): the recorded trail of one delivery; every view is audited. */
  async locationTrail(actor: AdminActor, id: string, deliveryId: string) {
    await this.partner(id);
    const d = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, partnerId: id },
      select: { id: true, status: true, orderId: true },
    });
    if (!d) throw new AppError('NOT_FOUND', { message: "We couldn't find that delivery." });
    const points = await this.prisma.$queryRaw<
      {
        lat: number;
        lng: number;
        accuracyM: number;
        heading: number | null;
        speedKmh: number | null;
        recordedAt: Date;
      }[]
    >`
      SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, accuracy_m AS "accuracyM",
        heading, speed_kmh AS "speedKmh", recorded_at AS "recordedAt"
      FROM delivery_locations
      WHERE delivery_id = ${deliveryId}::uuid AND partner_id = ${id}::uuid
      ORDER BY recorded_at ASC
      LIMIT 5000`;
    await this.record(actor, {
      action: 'admin.partner_location_viewed',
      targetId: id,
      after: { deliveryId, points: points.length },
    });
    return { partnerId: id, deliveryId, status: d.status, orderId: d.orderId, points };
  }
}
