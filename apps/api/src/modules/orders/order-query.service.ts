import type { OrderStatus, Prisma, PrismaClient } from '@fos/db';
import { AppError } from '../../platform/http/errors';
import { decodeCursor, encodeCursor, queryFingerprint } from '../../platform/pagination';
import { TERMINAL } from './transitions';

export const STATUS_GROUPS = {
  ACTIVE: ['PAYMENT_PENDING', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP'],
  DELIVERED: ['DELIVERED'],
  CANCELLED: ['CANCELLED', 'REJECTED', 'FAILED'],
} as const satisfies Record<string, OrderStatus[]>;
export type StatusGroup = keyof typeof STATUS_GROUPS;

/** Customer-facing words for each status (FR-CORD-003 timeline). */
const LABEL: Record<OrderStatus, string> = {
  PAYMENT_PENDING: 'Waiting for payment',
  PLACED: 'Order placed',
  ACCEPTED: 'Restaurant accepted',
  PREPARING: 'Preparing your food',
  READY_FOR_PICKUP: 'Ready for pickup',
  PICKED_UP: 'On the way',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REJECTED: 'Restaurant couldn’t accept',
  FAILED: 'Order failed',
};

const summarySelect = {
  id: true,
  number: true,
  status: true,
  totalAmount: true,
  payableAmount: true,
  paymentMethod: true,
  refundStatus: true,
  createdAt: true,
  placedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  etaMinAt: true,
  etaMaxAt: true,
  branch: {
    select: {
      id: true,
      name: true,
      restaurant: { select: { id: true, brandName: true, logoFileId: true } },
    },
  },
  items: { select: { itemName: true, quantity: true }, orderBy: { id: 'asc' } },
} satisfies Prisma.OrderSelect;

type SummaryRow = Prisma.OrderGetPayload<{ select: typeof summarySelect }>;

function summary(o: SummaryRow) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    statusLabel: LABEL[o.status],
    restaurant: {
      id: o.branch.restaurant.id,
      name: o.branch.restaurant.brandName,
      logoFileId: o.branch.restaurant.logoFileId,
      branchId: o.branch.id,
      branchName: o.branch.name,
    },
    itemsSummary: o.items.map((i) => `${i.quantity} × ${i.itemName}`).join(', '),
    itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
    totalAmount: o.totalAmount,
    paymentMethod: o.paymentMethod,
    refundStatus: o.refundStatus,
    createdAt: o.createdAt,
    placedAt: o.placedAt,
    deliveredAt: o.deliveredAt,
    cancelledAt: o.cancelledAt,
    eta: o.etaMinAt && o.etaMaxAt ? { minAt: o.etaMinAt, maxAt: o.etaMaxAt } : null,
  };
}

/** Customer order reads (API-ORD-001…005, FR-CORD-001…003). Only the owner sees an order (404 otherwise). */
export class OrderQueryService {
  constructor(private readonly prisma: PrismaClient) {}

  /** API-ORD-001: newest first, keyset-paginated. */
  async history(
    userId: string,
    opts: {
      status?: StatusGroup | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    const context = queryFingerprint(['orders', userId, opts.status, opts.from, opts.to]);
    const after = opts.cursor ? decodeCursor(opts.cursor, context) : null;
    const rows = await this.prisma.order.findMany({
      where: {
        userId,
        ...(opts.status ? { status: { in: [...STATUS_GROUPS[opts.status]] } } : {}),
        ...(opts.from || opts.to
          ? {
              createdAt: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lt: opts.to } : {}),
              },
            }
          : {}),
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after[0] as number) } },
                { createdAt: new Date(after[0] as number), id: { lt: after[1] as string } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      select: summarySelect,
    });
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      items: page.map(summary),
      nextCursor:
        rows.length > opts.limit && last
          ? encodeCursor(context, [last.createdAt.getTime(), last.id])
          : null,
    };
  }

  /** API-ORD-002: the "Track order" banner. */
  async active(userId: string) {
    const rows = await this.prisma.order.findMany({
      where: { userId, status: { in: [...STATUS_GROUPS.ACTIVE] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: summarySelect,
    });
    return rows.map(summary);
  }

  private async owned<T extends Prisma.OrderSelect>(userId: string, orderId: string, select: T) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId }, select });
    if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    return order;
  }

  /** API-ORD-004: lightweight polling fallback. */
  async status(userId: string, orderId: string) {
    const o = await this.owned(userId, orderId, {
      id: true,
      status: true,
      version: true,
      refundStatus: true,
      etaMinAt: true,
      etaMaxAt: true,
      updatedAt: true,
    });
    return {
      id: o.id,
      status: o.status,
      statusLabel: LABEL[o.status],
      version: o.version,
      refundStatus: o.refundStatus,
      terminal: TERMINAL.has(o.status),
      eta: o.etaMinAt && o.etaMaxAt ? { minAt: o.etaMinAt, maxAt: o.etaMaxAt } : null,
      updatedAt: o.updatedAt,
    };
  }

  /** API-ORD-005 */
  async timeline(userId: string, orderId: string) {
    await this.owned(userId, orderId, { id: true });
    return this.history_(orderId);
  }

  private async history_(orderId: string) {
    const rows = await this.prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((h) => ({
      status: h.toStatus,
      label: LABEL[h.toStatus],
      at: h.createdAt,
      by: h.actorType,
      // Internal reasons (fault, ops notes) are not shown to customers.
    }));
  }

  /** API-ORD-003 (FR-CORD-003): the immutable snapshot as charged. */
  async details(userId: string, orderId: string) {
    const o = await this.owned(userId, orderId, {
      ...summarySelect,
      version: true,
      itemsSubtotalAmount: true,
      discountTotalAmount: true,
      taxTotalAmount: true,
      tipAmount: true,
      walletAppliedAmount: true,
      deliveryInstructions: true,
      cookingInstructions: true,
      contactName: true,
      contactPhone: true,
      items: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          foodItemId: true,
          itemName: true,
          variantName: true,
          dietaryMarker: true,
          unitPriceAmount: true,
          optionsAmount: true,
          itemDiscountAmount: true,
          quantity: true,
          lineTotalAmount: true,
          instructions: true,
          options: { select: { groupName: true, optionName: true, priceDeltaAmount: true } },
        },
      },
      priceComponents: {
        orderBy: { id: 'asc' },
        select: { type: true, label: true, amount: true, code: true },
      },
      address: {
        select: {
          line1: true,
          line2: true,
          landmark: true,
          area: true,
          city: true,
          state: true,
          pincode: true,
        },
      },
      payments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          method: true,
          status: true,
          amount: true,
          capturedAmount: true,
          refundedAmount: true,
          instrumentSummary: true,
        },
      },
      refunds: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          amount: true,
          destination: true,
          status: true,
          createdAt: true,
          completedAt: true,
        },
      },
      cancellation: {
        select: { reasonCode: true, feeAmount: true, refundAmount: true, createdAt: true },
      },
      invoices: { select: { id: true }, take: 1 },
      reviews: { select: { id: true }, take: 1 },
    });
    return {
      ...summary(o),
      version: o.version,
      items: o.items,
      breakdown: {
        components: o.priceComponents,
        itemsSubtotal: o.itemsSubtotalAmount,
        discountTotal: o.discountTotalAmount,
        taxTotal: o.taxTotalAmount,
        tip: o.tipAmount,
        walletApplied: o.walletAppliedAmount,
        total: o.totalAmount,
        payable: o.payableAmount,
      },
      address: o.address,
      contact: { name: o.contactName, phone: o.contactPhone },
      deliveryInstructions: o.deliveryInstructions,
      cookingInstructions: o.cookingInstructions,
      payments: o.payments,
      refunds: o.refunds,
      cancellation: o.cancellation,
      timeline: await this.history_(o.id),
      invoiceAvailable: o.status === 'DELIVERED',
      reviewed: o.reviews.length > 0,
      // Partner card arrives with the delivery module (Phase 9).
      partner: null,
    };
  }

  /** API-ORD-010 (FR-ORDER-031): instructions and contact phone until pickup. */
  async updateDeliveryDetails(
    userId: string,
    orderId: string,
    body: { deliveryInstructions?: string | null | undefined; contactPhone?: string | undefined },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: OrderStatus }[]>`
        SELECT status FROM orders WHERE id = ${orderId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
      if (!locked) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
      if (
        !(STATUS_GROUPS.ACTIVE as readonly string[]).includes(locked.status) ||
        locked.status === 'PICKED_UP'
      ) {
        throw new AppError('ORDER_STATE_CONFLICT', {
          message: 'Delivery details can only be changed before the order is picked up.',
        });
      }
      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          ...(body.deliveryInstructions !== undefined
            ? { deliveryInstructions: body.deliveryInstructions }
            : {}),
          ...(body.contactPhone !== undefined ? { contactPhone: body.contactPhone } : {}),
          version: { increment: 1 },
        },
        select: { id: true, version: true, deliveryInstructions: true, contactPhone: true },
      });
      return updated;
    });
  }
}
