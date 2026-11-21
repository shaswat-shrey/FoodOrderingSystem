import type { AlertStatus, OrderStatus, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { AuditService } from '../audit';
import { periodBounds, type PresenceStore } from '../partners';
import type { AdminActor, Page } from './admin.http';
import { auditAs, pageArgs, pageMeta } from './admin.http';

const ACTIVE_ORDER: OrderStatus[] = [
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
];
const ON_DELIVERY = ['ASSIGNED', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'] as const;

/**
 * The admin dashboard and operational alerts (FR-ADMIN-002, API-ADM-001…003).
 * "Today" is the India calendar day; money is paise.
 */
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly presence: PresenceStore,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** API-ADM-001: live and today metrics with the open-alert summary. */
  async dashboard() {
    const now = this.clock.now();
    const today = periodBounds('day', now).from;
    const db = this.prisma;
    const [
      usersTotal,
      usersNew,
      customers,
      restaurantsTotal,
      restaurantsActive,
      restaurantsPending,
      partnersTotal,
      partnersPending,
      online,
      onDelivery,
      activeByState,
      closedToday,
      gmv,
      revenue,
      refunds,
      payouts,
      draftBatches,
      alerts,
      escalated,
    ] = await Promise.all([
      db.user.count({ where: { status: { not: 'ANONYMIZED' } } }),
      db.user.count({ where: { createdAt: { gte: today } } }),
      db.user.count({
        where: { status: { not: 'ANONYMIZED' }, roles: { some: { role: { key: 'CUSTOMER' } } } },
      }),
      db.restaurant.count({ where: { onboardingStatus: 'APPROVED' } }),
      // Accepting orders now: an active, open, unpaused branch (BR-REST-001…003).
      db.restaurant.count({
        where: {
          onboardingStatus: 'APPROVED',
          status: 'ACTIVE',
          branches: {
            some: {
              status: 'ACTIVE',
              deletedAt: null,
              isOpenManual: true,
              OR: [{ pausedUntil: null }, { pausedUntil: { lte: now } }],
            },
          },
        },
      }),
      db.restaurant.count({ where: { onboardingStatus: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
      db.deliveryPartner.count({ where: { onboardingStatus: 'APPROVED' } }),
      db.deliveryPartner.count({
        where: { onboardingStatus: { in: ['SUBMITTED', 'UNDER_REVIEW'] } },
      }),
      // Online partners are live state; during a Redis outage the tile shows none.
      this.presence.online().catch(() => [] as string[]),
      db.delivery.count({ where: { status: { in: [...ON_DELIVERY] }, partnerId: { not: null } } }),
      db.order.groupBy({
        by: ['status'],
        where: { status: { in: ACTIVE_ORDER } },
        _count: { _all: true },
      }),
      db.$queryRaw<{ delivered: number; cancelled: number; rejected: number; failed: number }[]>`
        SELECT count(*) FILTER (WHERE status = 'DELIVERED' AND delivered_at >= ${today})::int AS delivered,
          count(*) FILTER (WHERE status = 'CANCELLED' AND cancelled_at >= ${today})::int AS cancelled,
          count(*) FILTER (WHERE status = 'REJECTED' AND cancelled_at >= ${today})::int AS rejected,
          count(*) FILTER (WHERE status = 'FAILED' AND failure_reason IN ('DELIVERY_FAILED', 'CUSTOMER_UNREACHABLE') AND updated_at >= ${today})::int AS failed
        FROM orders WHERE updated_at >= ${today}`,
      // GMV: what customers paid for orders delivered today (food, fees, taxes and tips).
      db.order.aggregate({
        where: { status: 'DELIVERED', deliveredAt: { gte: today } },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      // Platform revenue: today's credits to the commission and fee revenue accounts.
      db.$queryRaw<{ commission: bigint | null; fees: bigint | null }[]>`
        SELECT -sum(e.amount) FILTER (WHERE a.type = 'PLATFORM_REVENUE_COMMISSION') AS commission,
          -sum(e.amount) FILTER (WHERE a.type = 'PLATFORM_REVENUE_FEES') AS fees
        FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.owner_type = 'PLATFORM' AND a.type IN ('PLATFORM_REVENUE_COMMISSION', 'PLATFORM_REVENUE_FEES')
          AND e.created_at >= ${today}`,
      db.$queryRaw<
        {
          created: number;
          created_amount: bigint | null;
          succeeded_amount: bigint | null;
          pending: number;
        }[]
      >`
        SELECT count(*) FILTER (WHERE created_at >= ${today} AND status NOT IN ('CANCELLED'))::int AS created,
          sum(amount) FILTER (WHERE created_at >= ${today} AND status NOT IN ('CANCELLED')) AS created_amount,
          sum(amount) FILTER (WHERE status = 'SUCCEEDED' AND completed_at >= ${today}) AS succeeded_amount,
          count(*) FILTER (WHERE status IN ('REQUESTED', 'APPROVED', 'PROCESSING'))::int AS pending
        FROM refunds WHERE created_at >= ${today} OR status IN ('REQUESTED', 'APPROVED', 'PROCESSING') OR completed_at >= ${today}`,
      db.payout.aggregate({
        where: { status: 'PENDING' },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      db.payoutBatch.count({ where: { status: 'DRAFT' } }),
      db.opsAlert.groupBy({
        by: ['severity'],
        where: { status: 'OPEN' },
        _count: { _all: true },
      }),
      db.delivery.count({ where: { status: 'SEARCHING', escalated: true } }),
    ]);
    const bySeverity = Object.fromEntries(alerts.map((a) => [a.severity, a._count._all]));
    const openTypes = await db.opsAlert.groupBy({
      by: ['type'],
      where: { status: 'OPEN' },
      _count: { _all: true },
      orderBy: { _count: { type: 'desc' } },
      take: 10,
    });
    const c = closedToday[0]!;
    const commission = Number(revenue[0]?.commission ?? 0n);
    const fees = Number(revenue[0]?.fees ?? 0n);
    const r = refunds[0]!;
    return {
      asOf: now,
      today,
      users: { total: usersTotal, newToday: usersNew },
      customers: { total: customers },
      restaurants: {
        total: restaurantsTotal,
        activeNow: restaurantsActive,
        pendingApprovals: restaurantsPending,
      },
      partners: {
        total: partnersTotal,
        onlineNow: online.length,
        onDelivery,
        pendingApprovals: partnersPending,
      },
      orders: {
        active: Object.fromEntries(
          ACTIVE_ORDER.map((s) => [s, activeByState.find((g) => g.status === s)?._count._all ?? 0]),
        ),
        activeTotal: activeByState.reduce((sum, g) => sum + g._count._all, 0),
        completedToday: c.delivered,
        cancelledToday: c.cancelled,
        rejectedToday: c.rejected,
        failedToday: c.failed,
      },
      gmv: { today: gmv._sum.totalAmount ?? 0, orders: gmv._count._all },
      platformRevenue: { today: commission + fees, commission, fees },
      refunds: {
        createdToday: r.created,
        createdAmountToday: Number(r.created_amount ?? 0n),
        succeededAmountToday: Number(r.succeeded_amount ?? 0n),
        pending: r.pending,
      },
      payouts: {
        pendingLines: payouts._count._all,
        pendingAmount: Number(payouts._sum.amount ?? 0n),
        draftBatches,
      },
      alerts: {
        open: alerts.reduce((sum, a) => sum + a._count._all, 0),
        bySeverity: {
          CRITICAL: bySeverity.CRITICAL ?? 0,
          WARNING: bySeverity.WARNING ?? 0,
          INFO: bySeverity.INFO ?? 0,
        },
        byType: Object.fromEntries(openTypes.map((t) => [t.type, t._count._all])),
        unassignedDeliveries: escalated,
      },
    };
  }

  /** API-ADM-002: newest first; open ones by default. */
  async alerts(filter: Page & { status?: AlertStatus | undefined; type?: string | undefined }) {
    const where: Prisma.OpsAlertWhereInput = {
      status: filter.status ?? 'OPEN',
      ...(filter.type ? { type: filter.type } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.opsAlert.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(filter),
        include: { acknowledger: { select: { id: true, fullName: true } } },
      }),
      this.prisma.opsAlert.count({ where }),
    ]);
    return {
      items: rows.map((a) => ({
        id: a.id,
        type: a.type,
        severity: a.severity,
        status: a.status,
        message: a.message,
        ref: a.refType ? { type: a.refType, id: a.refId } : null,
        createdAt: a.createdAt,
        acknowledgedAt: a.acknowledgedAt,
        acknowledgedBy: a.acknowledger,
        resolvedAt: a.resolvedAt,
      })),
      meta: pageMeta(filter, total),
    };
  }

  /** API-ADM-003: acknowledge (someone is on it) or resolve (done). */
  async acknowledge(
    actor: AdminActor,
    id: string,
    input: { resolve: boolean; note?: string | undefined },
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops_alerts WHERE id = ${id}::uuid FOR UPDATE`;
      const a = await tx.opsAlert.findUnique({ where: { id } });
      if (!a) throw new AppError('NOT_FOUND', { message: "We couldn't find that alert." });
      if (a.status === 'RESOLVED' || (a.status === 'ACKNOWLEDGED' && !input.resolve))
        throw new AppError('CONFLICT_STALE_VERSION', {
          message: `This alert is already ${a.status.toLowerCase()}.`,
        });
      const to: AlertStatus = input.resolve ? 'RESOLVED' : 'ACKNOWLEDGED';
      const updated = await tx.opsAlert.update({
        where: { id },
        data: {
          status: to,
          acknowledgedBy: a.acknowledgedBy ?? actor.userId,
          acknowledgedAt: a.acknowledgedAt ?? now,
          ...(input.resolve ? { resolvedAt: now } : {}),
        },
      });
      await auditAs(
        this.audit,
        actor,
        {
          action: input.resolve ? 'admin.alert_resolved' : 'admin.alert_acknowledged',
          targetType: 'ops_alert',
          targetId: id,
          reason: input.note ?? null,
          before: { status: a.status },
          after: { status: to },
          sensitivity: 'NORMAL',
        },
        tx,
      );
      return {
        id: updated.id,
        status: updated.status,
        acknowledgedAt: updated.acknowledgedAt,
        resolvedAt: updated.resolvedAt,
      };
    });
  }
}
