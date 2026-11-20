import type { PrismaClient } from '@fos/db';
import { Prisma } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { localParts, zonedInstant } from '../catalog';

const TZ = 'Asia/Kolkata';

interface Range {
  from: Date;
  to: Date;
}

const n = (v: unknown) => Number(v ?? 0);
const avg = (sum: number, count: number) => (count ? Math.round(sum / count) : null);

/**
 * Restaurant analytics from real orders only (FR-RANL-001…003, API-RANL-001…004, 007).
 * Amounts in paise; "food value" = items subtotal after discounts.
 */
export class RestaurantAnalyticsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  private today(): Range {
    const p = localParts(this.clock.now(), TZ);
    const from = zonedInstant(p.year, p.month, p.day, 0, TZ);
    return { from, to: new Date(from.getTime() + 86_400_000) };
  }

  private branchFilter(restaurantId: string, branchIds: string[] | null) {
    return branchIds
      ? Prisma.sql`o.restaurant_id = ${restaurantId}::uuid AND o.branch_id = ANY(${branchIds}::uuid[])`
      : Prisma.sql`o.restaurant_id = ${restaurantId}::uuid`;
  }

  /** API-RANL-001: today at a glance. */
  async dashboard(restaurantId: string, branchIds: string[] | null) {
    const { from, to } = this.today();
    const where = this.branchFilter(restaurantId, branchIds);
    const [row] = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT
        count(*) FILTER (WHERE o.status = 'PLACED') AS new,
        count(*) FILTER (WHERE o.status IN ('ACCEPTED','PREPARING')) AS preparing,
        count(*) FILTER (WHERE o.status = 'READY_FOR_PICKUP') AS ready,
        count(*) FILTER (WHERE o.status = 'PICKED_UP') AS picked_up,
        count(*) FILTER (WHERE o.status = 'DELIVERED') AS delivered,
        count(*) FILTER (WHERE o.status IN ('CANCELLED','FAILED')) AS cancelled,
        count(*) FILTER (WHERE o.status = 'REJECTED') AS rejected,
        coalesce(sum(o.items_subtotal_amount - o.discount_total_amount) FILTER (WHERE o.status NOT IN ('CANCELLED','REJECTED','FAILED')), 0) AS food_value,
        coalesce(sum(o.items_subtotal_amount - o.discount_total_amount) FILTER (WHERE o.status = 'DELIVERED'), 0) AS delivered_value,
        count(*) FILTER (WHERE o.accepted_at IS NOT NULL) AS accepted,
        coalesce(sum(extract(epoch FROM o.accepted_at - o.placed_at)) FILTER (WHERE o.accepted_at IS NOT NULL), 0) AS accept_seconds,
        count(*) FILTER (WHERE o.ready_at IS NOT NULL AND o.accepted_at IS NOT NULL) AS prepared,
        coalesce(sum(extract(epoch FROM o.ready_at - o.accepted_at)) FILTER (WHERE o.ready_at IS NOT NULL AND o.accepted_at IS NOT NULL), 0) AS prep_seconds
      FROM orders o
      WHERE ${where} AND o.placed_at >= ${from} AND o.placed_at < ${to}`;
    // Net payable: what settlement actually credited the restaurant today.
    const [net] = await this.prisma.$queryRaw<{ net: bigint | null }[]>`
      SELECT -sum(e.amount)::bigint AS net
      FROM ledger_entries e
      JOIN ledger_accounts a ON a.id = e.account_id
      JOIN ledger_transactions t ON t.id = e.transaction_id
      JOIN orders o ON o.id = t.reference_id
      WHERE t.type = 'ORDER_SETTLEMENT' AND t.reference_type = 'order' AND a.type = 'RESTAURANT_PAYABLE'
        AND ${where} AND o.placed_at >= ${from} AND o.placed_at < ${to}`;
    const r = row ?? {};
    const decided = n(r.accepted) + n(r.rejected);
    const ratings = await this.prisma.branch.findMany({
      where: { restaurantId, ...(branchIds ? { id: { in: branchIds } } : {}), deletedAt: null },
      select: { ratingAvgBps: true, ratingCount: true },
    });
    const rated = ratings.filter((b) => b.ratingCount > 0);
    const ratingCount = rated.reduce((s, b) => s + b.ratingCount, 0);
    return {
      date: from,
      orders: {
        new: n(r.new),
        preparing: n(r.preparing),
        ready: n(r.ready),
        pickedUp: n(r.picked_up),
        delivered: n(r.delivered),
        cancelled: n(r.cancelled),
        rejected: n(r.rejected),
      },
      revenue: {
        foodValue: n(r.food_value),
        deliveredValue: n(r.delivered_value),
        netPayable: n(net?.net),
      },
      averageOrderValue: avg(n(r.delivered_value), n(r.delivered)),
      acceptanceRate: decided ? Math.round((n(r.accepted) / decided) * 1000) / 10 : null,
      avgAcceptSeconds: avg(n(r.accept_seconds), n(r.accepted)),
      avgPrepSeconds: avg(n(r.prep_seconds), n(r.prepared)),
      rating: ratingCount
        ? {
            average:
              Math.round(
                rated.reduce((s, b) => s + (b.ratingAvgBps ?? 0) * b.ratingCount, 0) / ratingCount,
              ) / 100,
            count: ratingCount,
          }
        : null,
    };
  }

  /** API-RANL-002: series by day/week/month in IST, with the previous period to compare. */
  async sales(
    restaurantId: string,
    branchIds: string[] | null,
    opts: { from: Date; to: Date; granularity: 'day' | 'week' | 'month' },
  ) {
    const where = this.branchFilter(restaurantId, branchIds);
    const series = async (from: Date, to: Date) =>
      this.prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT date_trunc(${opts.granularity}, o.placed_at AT TIME ZONE ${TZ}) AS bucket,
          count(*) AS orders,
          count(*) FILTER (WHERE o.status = 'DELIVERED') AS delivered,
          count(*) FILTER (WHERE o.status IN ('CANCELLED','FAILED')) AS cancelled,
          count(*) FILTER (WHERE o.status = 'REJECTED') AS rejected,
          coalesce(sum(o.items_subtotal_amount - o.discount_total_amount) FILTER (WHERE o.status = 'DELIVERED'), 0) AS revenue,
          count(DISTINCT o.user_id) FILTER (WHERE o.status = 'DELIVERED') AS customers,
          count(DISTINCT o.user_id) FILTER (WHERE o.status = 'DELIVERED' AND NOT EXISTS (
            SELECT 1 FROM orders p WHERE p.user_id = o.user_id AND p.restaurant_id = o.restaurant_id
              AND p.status = 'DELIVERED' AND p.placed_at < ${from})) AS new_customers
        FROM orders o
        WHERE ${where} AND o.placed_at >= ${from} AND o.placed_at < ${to}
        GROUP BY 1 ORDER BY 1`;
    const shape = (rows: Record<string, unknown>[]) =>
      rows.map((r) => ({
        bucket: (r.bucket as Date).toISOString().slice(0, 10),
        orders: n(r.orders),
        delivered: n(r.delivered),
        revenue: n(r.revenue),
        averageOrderValue: avg(n(r.revenue), n(r.delivered)),
        cancellationRate: n(r.orders) ? Math.round((n(r.cancelled) / n(r.orders)) * 1000) / 10 : 0,
        rejectionRate: n(r.orders) ? Math.round((n(r.rejected) / n(r.orders)) * 1000) / 10 : 0,
        newCustomers: n(r.new_customers),
        repeatCustomers: n(r.customers) - n(r.new_customers),
      }));
    const span = opts.to.getTime() - opts.from.getTime();
    const current = shape(await series(opts.from, opts.to));
    const previous = shape(await series(new Date(opts.from.getTime() - span), opts.from));
    const total = (rows: ReturnType<typeof shape>) => ({
      orders: rows.reduce((s, r) => s + r.orders, 0),
      delivered: rows.reduce((s, r) => s + r.delivered, 0),
      revenue: rows.reduce((s, r) => s + r.revenue, 0),
    });
    return {
      granularity: opts.granularity,
      series: current,
      totals: total(current),
      previousTotals: total(previous),
    };
  }

  /** API-RANL-003: top dishes by quantity and revenue (delivered orders). */
  async items(restaurantId: string, branchIds: string[] | null, range: Range) {
    const where = this.branchFilter(restaurantId, branchIds);
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT i.food_item_id AS id, max(i.item_name) AS name, sum(i.quantity) AS quantity, sum(i.line_total_amount) AS revenue
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE ${where} AND o.status = 'DELIVERED' AND o.placed_at >= ${range.from} AND o.placed_at < ${range.to}
      GROUP BY i.food_item_id ORDER BY sum(i.quantity) DESC, sum(i.line_total_amount) DESC LIMIT 20`;
    return rows.map((r) => ({
      foodItemId: r.id as string,
      name: r.name as string,
      quantity: n(r.quantity),
      revenue: n(r.revenue),
    }));
  }

  /** API-RANL-004: sales by (current) category. */
  async categories(restaurantId: string, branchIds: string[] | null, range: Range) {
    const where = this.branchFilter(restaurantId, branchIds);
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT c.id, c.name, sum(i.quantity) AS quantity, sum(i.line_total_amount) AS revenue
      FROM order_items i JOIN orders o ON o.id = i.order_id
        JOIN food_items f ON f.id = i.food_item_id JOIN menu_categories c ON c.id = f.category_id
      WHERE ${where} AND o.status = 'DELIVERED' AND o.placed_at >= ${range.from} AND o.placed_at < ${range.to}
      GROUP BY c.id, c.name ORDER BY sum(i.line_total_amount) DESC`;
    return rows.map((r) => ({
      categoryId: r.id as string,
      name: r.name as string,
      quantity: n(r.quantity),
      revenue: n(r.revenue),
    }));
  }

  /** API-RANL-007: acceptance, prep and cancellation performance. */
  async operations(restaurantId: string, branchIds: string[] | null, range: Range) {
    const where = this.branchFilter(restaurantId, branchIds);
    const [r] = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*) AS orders,
        count(*) FILTER (WHERE o.accepted_at IS NOT NULL) AS accepted,
        count(*) FILTER (WHERE o.status = 'REJECTED') AS rejected,
        count(*) FILTER (WHERE c.reason_code = 'ACCEPT_TIMEOUT') AS timeouts,
        count(*) FILTER (WHERE o.status = 'CANCELLED' AND c.fault = 'RESTAURANT' AND c.reason_code <> 'ACCEPT_TIMEOUT') AS restaurant_cancelled,
        coalesce(avg(extract(epoch FROM o.accepted_at - o.placed_at)), 0) AS accept_seconds,
        coalesce(avg(extract(epoch FROM o.ready_at - o.accepted_at)), 0) AS prep_seconds,
        count(*) FILTER (WHERE o.ready_at IS NOT NULL AND o.ready_by IS NOT NULL AND o.ready_at > o.ready_by) AS late
      FROM orders o LEFT JOIN order_cancellations c ON c.order_id = o.id
      WHERE ${where} AND o.placed_at >= ${range.from} AND o.placed_at < ${range.to}`;
    const row = r ?? {};
    const orders = n(row.orders);
    const pct = (v: number) => (orders ? Math.round((v / orders) * 1000) / 10 : 0);
    return {
      orders,
      acceptanceRate: pct(n(row.accepted)),
      rejectionRate: pct(n(row.rejected)),
      timeoutRate: pct(n(row.timeouts)),
      restaurantCancellationRate: pct(n(row.restaurant_cancelled)),
      avgAcceptSeconds: Math.round(n(row.accept_seconds)),
      avgPrepSeconds: Math.round(n(row.prep_seconds)),
      lateReadyRate: pct(n(row.late)),
    };
  }
}
