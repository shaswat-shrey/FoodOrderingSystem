import type { CostBearer, OrderIssueType, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { SettingsService } from '../config';
import type { RefundService } from '../payments';
import type { SupportService } from '../support';

/** Issue types where the customer may ask for the affected items' value back (FR-CORD-011). */
const ITEM_REFUNDABLE = new Set<OrderIssueType>([
  'MISSING_ITEM',
  'WRONG_ITEM',
  'QUALITY',
  'SPILLAGE',
]);
/** Who pays for an item refund (FR-REFUND-009): spillage happens in transit. */
const COST_BEARER: Partial<Record<OrderIssueType, CostBearer>> = {
  MISSING_ITEM: 'RESTAURANT',
  WRONG_ITEM: 'RESTAURANT',
  QUALITY: 'RESTAURANT',
  SPILLAGE: 'PARTNER',
};
const ACTIVE = new Set([
  'PAYMENT_PENDING',
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
]);

export interface ReportInput {
  type: OrderIssueType;
  description: string;
  items?: { orderItemId: string; quantity: number }[] | undefined;
  requestRefund?: boolean | undefined;
  photoFileIds?: string[] | undefined;
}

/**
 * Order issue reports (FR-CORD-010…012, API-ORD-011…013). Each report opens a
 * linked support ticket; item refunds within BR-REFUND-006 limits are approved
 * at once to the wallet, everything else waits for support.
 */
export class OrderIssueService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly support: SupportService,
    private readonly refunds: RefundService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /** BR-REFUND-001: affected items' value plus their share of packaging and food/packaging taxes, net of order discounts. */
  private itemRefundValue(
    order: { itemsSubtotalAmount: number },
    components: { type: string; amount: number; code: string | null }[],
    affected: number,
  ): number {
    if (order.itemsSubtotalAmount <= 0) return 0;
    const sum = (pred: (c: { type: string; code: string | null }) => boolean) =>
      components.filter(pred).reduce((s, c) => s + c.amount, 0);
    const discounts = sum((c) => ['ITEM_DISCOUNT', 'PROMOTION', 'COUPON'].includes(c.type));
    const packaging = sum((c) => c.type === 'PACKAGING');
    const foodTax = sum((c) => c.type === 'TAX' && (c.code === 'FOOD' || c.code === 'PACKAGING'));
    const foodPaid = order.itemsSubtotalAmount - discounts + packaging + foodTax;
    return Math.round((affected * foodPaid) / order.itemsSubtotalAmount);
  }

  /** BR-REFUND-006 eligibility: small amount, few recent approvals, established account. */
  private async autoApprovable(userId: string, amount: number): Promise<boolean> {
    const [max, perWindow, minDays, user] = await Promise.all([
      this.settings.get('refund.autoApproveMaxAmount'),
      this.settings.get('refund.autoApproveMaxPer90Days'),
      this.settings.get('refund.autoApproveMinAccountDays'),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
    ]);
    if (amount <= 0 || amount > max) return false;
    const now = this.clock.now().getTime();
    if (now - user.createdAt.getTime() < minDays * 86_400_000) return false;
    const recent = await this.prisma.orderIssue.count({
      where: {
        order: { userId },
        status: { in: ['APPROVED', 'RESOLVED'] },
        requestedRefundAmount: { gt: 0 },
        createdAt: { gte: new Date(now - 90 * 86_400_000) },
      },
    });
    return recent < perWindow;
  }

  /** API-ORD-011 */
  async report(userId: string, orderId: string, input: ReportInput) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        items: { select: { id: true, quantity: true, lineTotalAmount: true, itemName: true } },
        priceComponents: { select: { type: true, amount: true, code: true } },
      },
    });
    if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });

    // BR-SUP-002: any active order, or within the window after delivery.
    const windowMs = (await this.settings.get('support.issueWindowHours')) * 3_600_000;
    const delivered =
      order.status === 'DELIVERED' &&
      order.deliveredAt !== null &&
      this.clock.now().getTime() - order.deliveredAt.getTime() <= windowMs;
    if (!ACTIVE.has(order.status) && !delivered) throw new AppError('ISSUE_WINDOW_CLOSED');
    if (input.type === 'NOT_DELIVERED')
      throw new AppError('VALIDATION_ERROR', {
        message: 'Use “Not delivered” on the order to report a missing delivery.',
      });

    // Selected items must be on the order, within what wasn't already reported.
    const items = input.items ?? [];
    const reported = await this.prisma.orderIssueItem.groupBy({
      by: ['orderItemId'],
      where: { issue: { orderId, status: { not: 'REJECTED' } } },
      _sum: { quantity: true },
    });
    const already = new Map(reported.map((r) => [r.orderItemId, r._sum.quantity ?? 0]));
    let affected = 0;
    const values: number[] = [];
    for (const sel of items) {
      const line = order.items.find((i) => i.id === sel.orderItemId);
      if (!line || sel.quantity > line.quantity - (already.get(line.id) ?? 0))
        throw new AppError('ISSUE_ITEMS_INVALID');
      const value = Math.round((line.lineTotalAmount * sel.quantity) / line.quantity);
      values.push(value);
      affected += value;
    }
    const wantsRefund = Boolean(input.requestRefund) && ITEM_REFUNDABLE.has(input.type);
    if (wantsRefund && items.length === 0)
      throw new AppError('ISSUE_ITEMS_INVALID', { message: 'Choose the items the refund is for.' });

    // Never more than is still refundable (BR-REFUND-002).
    const [captured, refunded] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { orderId, method: 'ONLINE' },
        _sum: { capturedAmount: true },
      }),
      this.prisma.refund.aggregate({
        where: { orderId, status: { notIn: ['FAILED', 'CANCELLED'] } },
        _sum: { amount: true },
      }),
    ]);
    const refundable = Math.max(
      0,
      (captured._sum.capturedAmount ?? 0) + order.walletAppliedAmount - (refunded._sum.amount ?? 0),
    );
    const requested = wantsRefund
      ? Math.min(refundable, this.itemRefundValue(order, order.priceComponents, affected))
      : 0;
    const auto =
      requested > 0 &&
      order.status === 'DELIVERED' &&
      (await this.autoApprovable(userId, requested));

    const refundIds: string[] = [];
    const issue = await this.prisma.$transaction(async (tx) => {
      const ticket = await this.support.createIn(
        tx,
        { userId, app: 'CUSTOMER' },
        {
          category: 'ORDER_ISSUE',
          subject: `${input.type.replace(/_/g, ' ').toLowerCase()} — order ${order.number}`,
          description: input.description,
          orderId,
          attachmentFileIds: input.photoFileIds,
          ...(auto
            ? {
                systemNote: `Refund of Rs. ${(requested / 100).toFixed(2)} approved automatically to your wallet.`,
              }
            : {}),
        },
      );
      const created = await tx.orderIssue.create({
        data: {
          orderId,
          type: input.type,
          description: input.description,
          status: auto ? 'APPROVED' : 'OPEN',
          ticketId: ticket.id,
          requestedRefundAmount: requested,
          ...(auto ? { resolution: 'Auto-approved (BR-REFUND-006)' } : {}),
          createdAt: this.clock.now(),
          items: {
            create: items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
          },
          photos: { create: (input.photoFileIds ?? []).map((fileId) => ({ fileId })) },
        },
        include: { items: true },
      });
      if (auto) {
        const refund = await this.refunds.create(tx, {
          orderId,
          paymentId: null,
          amount: requested,
          destination: 'WALLET',
          reasonCode: `ISSUE_${input.type}`,
          note: `Issue ${created.id}`,
          initiatorType: 'SYSTEM',
          costBearer: COST_BEARER[input.type] ?? 'PLATFORM',
        });
        // Split the refund across the lines by value; the last line takes the rounding.
        let left = requested;
        await tx.refundItem.createMany({
          data: items.map((i, idx) => {
            const amount =
              idx === items.length - 1 ? left : Math.round((requested * values[idx]!) / affected);
            left -= amount;
            return {
              refundId: refund.id,
              orderItemId: i.orderItemId,
              quantity: i.quantity,
              amount,
            };
          }),
        });
        refundIds.push(refund.id);
        await tx.supportTicket.update({
          where: { id: ticket.id },
          data: { status: 'RESOLVED', resolvedAt: this.clock.now() },
        });
      }
      return { ...created, ticketNumber: ticket.number };
    });
    for (const id of refundIds) await this.refunds.schedule(id);
    return this.view(issue, refundIds.length > 0);
  }

  /** API-ORD-013 (FR-CORD-012): within an hour of "delivered", once per order, urgent. */
  async notDelivered(userId: string, orderId: string, description: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId } });
    if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    const windowMs = (await this.settings.get('support.notDeliveredWindowMinutes')) * 60_000;
    if (
      order.status !== 'DELIVERED' ||
      !order.deliveredAt ||
      this.clock.now().getTime() - order.deliveredAt.getTime() > windowMs
    )
      throw new AppError('ISSUE_WINDOW_CLOSED');
    const existing = await this.prisma.orderIssue.findFirst({
      where: { orderId, type: 'NOT_DELIVERED' },
      include: { items: true, ticket: { select: { number: true } } },
    });
    if (existing)
      return this.view({ ...existing, ticketNumber: existing.ticket?.number ?? null }, false);
    const issue = await this.prisma.$transaction(async (tx) => {
      const ticket = await this.support.createIn(
        tx,
        { userId, app: 'CUSTOMER' },
        {
          category: 'DELIVERY',
          subject: `Order ${order.number} not received`,
          description,
          orderId,
          priority: 'URGENT',
        },
      );
      const created = await tx.orderIssue.create({
        data: {
          orderId,
          type: 'NOT_DELIVERED',
          description,
          ticketId: ticket.id,
          createdAt: this.clock.now(),
        },
        include: { items: true },
      });
      return { ...created, ticketNumber: ticket.number };
    });
    return this.view(issue, false);
  }

  /** API-ORD-012 */
  async list(userId: string, orderId: string) {
    const owned = await this.prisma.order.count({ where: { id: orderId, userId } });
    if (!owned) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    const rows = await this.prisma.orderIssue.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      include: { items: true, ticket: { select: { number: true } } },
    });
    return rows.map((r) => this.view({ ...r, ticketNumber: r.ticket?.number ?? null }, false));
  }

  private view(
    i: {
      id: string;
      type: OrderIssueType;
      status: string;
      description: string;
      requestedRefundAmount: number;
      resolution: string | null;
      ticketId: string | null;
      ticketNumber: string | null;
      createdAt: Date;
      items: { orderItemId: string; quantity: number }[];
    },
    refunded: boolean,
  ) {
    return {
      id: i.id,
      type: i.type,
      status: i.status,
      description: i.description,
      items: i.items.map((x) => ({ orderItemId: x.orderItemId, quantity: x.quantity })),
      refund:
        i.requestedRefundAmount > 0
          ? {
              amount: i.requestedRefundAmount,
              status: i.status === 'APPROVED' || refunded ? 'APPROVED' : 'UNDER_REVIEW',
              destination: 'WALLET',
            }
          : null,
      resolution: i.resolution,
      ticket: i.ticketId ? { id: i.ticketId, number: i.ticketNumber } : null,
      createdAt: i.createdAt,
    };
  }
}
