import type { CancellationFault, Order, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { raiseOpsAlert } from '../../platform/ops-alerts';
import { writeOutbox } from '../../platform/outbox';
import type { SettingsService } from '../config';
import type { LedgerService } from '../ledger';
import type { PaymentsService, RefundService } from '../payments';
import {
  allocate,
  customerTerms,
  quoteIdFor,
  quoteVersion,
  type Allocation,
  type CustomerTerms,
  type Paid,
} from './cancellation-policy';
import type { OrderEffects } from './order-effects';
import { OrderSettlement } from './settlement';
import type { OrderTransitions } from './transition.service';
import type { OrderActor } from './transitions';

type Tx = Prisma.TransactionClient;

export const CUSTOMER_REASONS = [
  'CHANGED_MIND',
  'ORDERED_BY_MISTAKE',
  'DELAY',
  'ADDRESS_ISSUE',
  'PAYMENT_ISSUE',
  'OTHER',
] as const;

/** Statuses before the restaurant accepted: the coupon always comes back (BR-COUPON-006). */
const BEFORE_ACCEPT = new Set(['PAYMENT_PENDING', 'PLACED']);
/** The kitchen has spent effort: a platform/partner-fault cancellation compensates the restaurant. */
const FOOD_MADE = new Set(['PREPARING', 'READY_FOR_PICKUP']);
const SUPPORT_LINK = '/support';

export interface CancelInput {
  orderId: string;
  actor: { type: OrderActor; id?: string | null };
  reasonCode: string;
  note?: string | null;
  /** Required for every initiator except the customer (BR-ORDER-016). */
  fault?: CancellationFault;
  /** Customer cancellations must echo the preview's quote (FR-ORDER-020). */
  quoteId?: string;
  /** T07: a restaurant rejection ends in REJECTED with the same full refund. */
  to?: 'CANCELLED' | 'REJECTED';
}

export interface CancellationResult {
  order: { id: string; status: 'CANCELLED' };
  cancellation: {
    fee: number;
    fault: CancellationFault;
    refund: {
      amount: number;
      toSource: number;
      toWallet: number;
      walletReleased: number;
      status: 'NONE' | 'PENDING';
    };
  };
}

/**
 * Order cancellation for every initiator (SRS §10.5, T05/T08/T10/T12/T14):
 * terms, fee, split refunds, ledger, coupon/wallet/stock, history and events,
 * all in one transaction under the order row lock (FR-ORDER-023).
 */
export class OrderCancellationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly transitions: OrderTransitions,
    private readonly effects: OrderEffects,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly secret: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /* ----------------------------- money ----------------------------- */

  private async paid(db: Tx | PrismaClient, order: Order): Promise<Paid> {
    const captured = await db.payment.findMany({
      where: {
        orderId: order.id,
        method: 'ONLINE',
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
      },
      orderBy: { capturedAt: 'asc' },
    });
    const open = await db.refund.groupBy({
      by: ['paymentId'],
      where: { orderId: order.id, status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } },
      _sum: { amount: true },
    });
    const pending = new Map(open.map((r) => [r.paymentId, r._sum.amount ?? 0]));
    const online = captured
      .map((p) => ({
        paymentId: p.id,
        amount: p.capturedAmount - p.refundedAmount - (pending.get(p.id) ?? 0),
      }))
      .filter((p) => p.amount > 0);
    const wallet =
      order.walletAppliedAmount > 0 && (await this.effects.walletDebited(db as Tx, order.id))
        ? order.walletAppliedAmount
        : 0;
    return { online, wallet, tip: order.tipAmount };
  }

  private async foodValue(db: Tx | PrismaClient, order: Order) {
    const packaging = await db.orderPriceComponent.aggregate({
      where: { orderId: order.id, type: 'PACKAGING' },
      _sum: { amount: true },
    });
    return {
      food: Math.max(0, order.itemsSubtotalAmount - order.discountTotalAmount),
      packaging: packaging._sum.amount ?? 0,
    };
  }

  private async terms(db: Tx | PrismaClient, order: Order) {
    const { food, packaging } = await this.foodValue(db, order);
    const terms = customerTerms({
      status: order.status,
      acceptedAt: order.acceptedAt,
      foodValue: food,
      packaging,
      now: this.clock.now(),
      freeWindowSeconds: await this.settings.get('cancellation.freeWindowAfterAcceptSeconds'),
      acceptedFeeBps: await this.settings.get('cancellation.acceptedFeeBps'),
    });
    const allocation = allocate(await this.paid(db, order), terms.policyFee);
    return { terms, allocation, food };
  }

  private quote(order: Order, a: Allocation): string {
    return quoteIdFor(this.secret, {
      orderId: order.id,
      version: order.version,
      fee: a.fee,
      refund: a.total,
    });
  }

  private notAllowed(terms: CustomerTerms): AppError {
    const message =
      terms.reason === 'ORDER_CLOSED'
        ? 'This order is already closed.'
        : "Your order is already on its way out of the kitchen, so it can't be cancelled here. Contact support for help.";
    return new AppError('CANCELLATION_NOT_ALLOWED', {
      message,
      details: [{ code: terms.reason!, message: SUPPORT_LINK, path: 'supportLink' }],
    });
  }

  /* ----------------------------- customer ----------------------------- */

  /** API-ORD-006 (FR-ORDER-020). */
  async preview(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId } });
    if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    const { terms, allocation } = await this.terms(this.prisma, order);
    const walletHeld =
      order.walletAppliedAmount > 0 &&
      allocation.toWallet === 0 &&
      order.status === 'PAYMENT_PENDING'
        ? order.walletAppliedAmount
        : 0;
    return {
      orderId: order.id,
      status: order.status,
      allowed: terms.allowed,
      ...(terms.allowed ? {} : { reason: terms.reason, supportLink: SUPPORT_LINK }),
      quoteId: terms.allowed ? this.quote(order, allocation) : null,
      fee: allocation.fee,
      refund: {
        amount: allocation.total,
        toSource: allocation.toSource.reduce((s, r) => s + r.amount, 0),
        toWallet: allocation.toWallet,
        walletReleased: walletHeld,
        expectation: 'Original method: 5–7 business days. Wallet: instant.', // BR-REFUND-005
      },
      freeUntil: terms.freeUntil && terms.freeUntil > this.clock.now() ? terms.freeUntil : null,
      reasons: CUSTOMER_REASONS,
    };
  }

  /** API-ORD-007. */
  async cancelByCustomer(
    userId: string,
    orderId: string,
    input: { quoteId: string; reasonCode: string; note?: string | null },
  ): Promise<CancellationResult> {
    const owned = await this.prisma.order.count({ where: { id: orderId, userId } });
    if (!owned) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    return this.cancel({
      orderId,
      actor: { type: 'CUSTOMER', id: userId },
      reasonCode: input.reasonCode,
      note: input.note ?? null,
      quoteId: input.quoteId,
    });
  }

  /** API-PAY-005 (FR-PAY-016): the customer abandons an unpaid order (T05). */
  async abandonPayment(userId: string, paymentId: string): Promise<CancellationResult> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, order: { userId } },
      include: { order: { select: { id: true, status: true } } },
    });
    if (!payment) throw new AppError('NOT_FOUND', { message: "We couldn't find that payment." });
    if (payment.order.status !== 'PAYMENT_PENDING') {
      throw new AppError('ORDER_STATE_CONFLICT', {
        message: 'This order is no longer waiting for payment.',
      });
    }
    // A capture we haven't heard about yet must win over the abandon (T05 guard).
    await this.payments.pollOrder(payment.orderId).catch((error: unknown) => {
      this.logger.warn({ err: error, paymentId }, 'provider check before abandon failed');
    });
    return this.cancel({
      orderId: payment.orderId,
      actor: { type: 'CUSTOMER', id: userId },
      reasonCode: 'PAYMENT_ISSUE',
    });
  }

  /* ----------------------------- every initiator ----------------------------- */

  async cancel(input: CancelInput): Promise<CancellationResult> {
    const refundIds: string[] = [];
    let pausedBranch = false;
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.transitions.lock(tx, input.orderId);
      const customer = input.actor.type === 'CUSTOMER';
      if (order.status === 'PAYMENT_PENDING') {
        const captured = await tx.payment.count({
          where: { orderId: order.id, status: 'CAPTURED' },
        });
        if (captured > 0) {
          throw new AppError('ORDER_STATE_CONFLICT', {
            message: 'Your payment just went through, so the order is being placed.',
          });
        }
      }

      const { terms, allocation: customerAllocation, food } = await this.terms(tx, order);
      let allocation: Allocation;
      let fault: CancellationFault;
      if (customer) {
        if (!terms.allowed) {
          if (terms.reason === 'ORDER_CLOSED')
            throw new AppError('ORDER_STATE_CONFLICT', {
              message: 'This order is already closed.',
            });
          throw this.notAllowed(terms);
        }
        if (
          input.quoteId !== undefined &&
          input.quoteId !== this.quote(order, customerAllocation)
        ) {
          // FR-ORDER-023: the order moved on since the preview → 409; only the terms changed → 422.
          if (quoteVersion(input.quoteId) !== (order.version & 0xffff))
            throw new AppError('ORDER_STATE_CONFLICT', {
              message: 'This order was just updated. Please review the cancellation terms again.',
              details: [{ code: 'STATUS', message: order.status, path: 'status' }],
            });
          throw new AppError('CANCELLATION_QUOTE_STALE', {
            details: [{ code: 'STATUS', message: order.status, path: 'status' }],
          });
        }
        allocation = customerAllocation;
        fault = 'CUSTOMER';
      } else {
        if (!input.fault) throw new Error('fault is required for non-customer cancellations');
        // Everyone but the customer cancels with a full refund (BR-REFUND-001), unless ops
        // attributes the cancellation to the customer: then the customer's policy fee applies.
        allocation = allocate(
          await this.paid(tx, order),
          input.fault === 'CUSTOMER' ? terms.policyFee : 0,
        );
        fault = input.fault;
      }

      const previous = order.status;
      const { order: cancelled } = await this.transitions.apply(tx, {
        orderId: order.id,
        to: input.to ?? 'CANCELLED',
        actor: { type: input.actor.type, id: input.actor.id ?? null },
        reason: input.reasonCode,
        metadata: { fault, fee: allocation.fee, refund: allocation.total },
      });

      if (previous === 'PAYMENT_PENDING')
        await this.payments.closeOpenPayments(tx, order.id, 'CANCELLED');
      // COD that was never collected.
      await tx.payment.updateMany({
        where: { orderId: order.id, method: 'COD', status: 'PENDING' },
        data: { status: 'CANCELLED', version: { increment: 1 } },
      });

      const restoreCoupon = BEFORE_ACCEPT.has(previous) || fault !== 'CUSTOMER';
      const { walletReleased } = await this.effects.release(tx, cancelled, previous, {
        restoreCoupon,
      });

      for (const r of allocation.toSource) {
        const refund = await this.refunds.create(tx, {
          orderId: order.id,
          paymentId: r.paymentId,
          amount: r.amount,
          destination: 'SOURCE',
          reasonCode: `CANCELLED_${fault}`,
          initiatorType: input.actor.type,
          initiatorId: input.actor.id ?? null,
          costBearer: fault === 'RESTAURANT' ? 'RESTAURANT' : 'PLATFORM',
        });
        refundIds.push(refund.id);
      }
      if (allocation.toWallet > 0) {
        const refund = await this.refunds.create(tx, {
          orderId: order.id,
          paymentId: null,
          amount: allocation.toWallet,
          destination: 'WALLET',
          reasonCode: `CANCELLED_${fault}`,
          initiatorType: input.actor.type,
          initiatorId: input.actor.id ?? null,
          costBearer: fault === 'RESTAURANT' ? 'RESTAURANT' : 'PLATFORM',
        });
        refundIds.push(refund.id);
      }

      // The fee compensates the restaurant (T10a/T12a); it leaves the order's liability.
      if (allocation.fee > 0) {
        await this.ledger.post(tx, {
          type: 'CANCELLATION_FEE',
          referenceType: 'order',
          referenceId: order.id,
          description: `Cancellation fee for order ${order.number}`,
          entries: [
            {
              ownerType: 'ORDER',
              ownerId: order.id,
              type: 'CUSTOMER_ORDER_LIABILITY',
              amount: allocation.fee,
            },
            {
              ownerType: 'RESTAURANT',
              ownerId: order.restaurantId,
              type: 'RESTAURANT_PAYABLE',
              amount: -allocation.fee,
            },
          ],
        });
      }
      // T14 and platform/partner-fault cancellations after cooking: the platform pays for the food.
      if (FOOD_MADE.has(previous) && (fault === 'PLATFORM' || fault === 'PARTNER') && food > 0) {
        await this.ledger.post(tx, {
          type: 'ADJUSTMENT',
          referenceType: 'order_cancellation',
          referenceId: order.id,
          description: `Food compensation for cancelled order ${order.number}`,
          entries: [
            { ownerType: 'PLATFORM', ownerId: null, type: 'PLATFORM_REFUND_EXPENSE', amount: food },
            {
              ownerType: 'RESTAURANT',
              ownerId: order.restaurantId,
              type: 'RESTAURANT_PAYABLE',
              amount: -food,
            },
          ],
        });
      }

      await tx.orderCancellation.create({
        data: {
          orderId: order.id,
          initiatorType: input.actor.type,
          initiatorId: input.actor.id ?? null,
          reasonCode: input.reasonCode,
          note: input.note ?? null,
          fault,
          feeAmount: allocation.fee,
          refundAmount: allocation.total,
          quoteId: customer ? this.quote(order, allocation) : null,
        },
      });
      if (refundIds.length > 0)
        await tx.order.update({ where: { id: order.id }, data: { refundStatus: 'PENDING' } });

      if (input.reasonCode === 'ACCEPT_TIMEOUT') pausedBranch = await this.missedOrder(tx, order);

      return {
        order: { id: order.id, status: 'CANCELLED' as const },
        cancellation: {
          fee: allocation.fee,
          fault,
          refund: {
            amount: allocation.total,
            toSource: allocation.toSource.reduce((s, r) => s + r.amount, 0),
            toWallet: allocation.toWallet,
            walletReleased: walletReleased ? order.walletAppliedAmount : 0,
            status: refundIds.length > 0 ? ('PENDING' as const) : ('NONE' as const),
          },
        },
      };
    });
    for (const id of refundIds) await this.refunds.schedule(id);
    if (pausedBranch)
      this.logger.warn({ orderId: input.orderId }, 'branch auto-paused (BR-REST-009)');
    return result;
  }

  /**
   * T16 money (BR-REFUND-001), in the caller's transaction. Customer unreachable
   * on a prepaid order: the restaurant and platform are paid as if delivered and
   * only the tip goes back. A partner/platform failure: everything paid goes back
   * and the platform pays the restaurant for the food. COD collected nothing, so
   * any wallet part goes back and the platform pays for the food. Partner-fault
   * costs stay with the platform until a dispute review (FR-REFUND-009).
   * Returns the refunds to submit after commit.
   */
  async failedDelivery(
    tx: Tx,
    order: Order,
    cause: 'DELIVERY_FAILED' | 'CUSTOMER_UNREACHABLE',
    actor: { type: OrderActor; id?: string | null },
  ): Promise<string[]> {
    const paid = await this.paid(tx, order);
    const { food } = await this.foodValue(tx, order);
    const keep = cause === 'CUSTOMER_UNREACHABLE' && order.paymentMethod !== 'COD';
    if (keep) {
      await new OrderSettlement(this.ledger).settle(tx, order);
      // The tip leaves the liability now, so its refund (charged to the platform once settled) nets to zero.
      if (order.tipAmount > 0)
        await this.ledger.post(tx, {
          type: 'ADJUSTMENT',
          referenceType: 'order_failure',
          referenceId: order.id,
          description: `Tip returned for undelivered order ${order.number}`,
          entries: [
            {
              ownerType: 'ORDER',
              ownerId: order.id,
              type: 'CUSTOMER_ORDER_LIABILITY',
              amount: order.tipAmount,
            },
            {
              ownerType: 'PLATFORM',
              ownerId: null,
              type: 'PLATFORM_REFUND_EXPENSE',
              amount: -order.tipAmount,
            },
          ],
        });
    } else if (food > 0) {
      await this.ledger.post(tx, {
        type: 'ADJUSTMENT',
        referenceType: 'order_failure',
        referenceId: order.id,
        description: `Food compensation for undelivered order ${order.number}`,
        entries: [
          { ownerType: 'PLATFORM', ownerId: null, type: 'PLATFORM_REFUND_EXPENSE', amount: food },
          {
            ownerType: 'RESTAURANT',
            ownerId: order.restaurantId,
            type: 'RESTAURANT_PAYABLE',
            amount: -food,
          },
        ],
      });
    }
    const total = paid.online.reduce((s, p) => s + p.amount, 0) + paid.wallet;
    const allocation = allocate(paid, keep ? total - paid.tip : 0);
    const refundIds: string[] = [];
    const base = {
      orderId: order.id,
      reasonCode: `FAILED_${cause}`,
      initiatorType: actor.type,
      initiatorId: actor.id ?? null,
      costBearer: 'PLATFORM' as const,
    };
    for (const r of allocation.toSource) {
      const refund = await this.refunds.create(tx, {
        ...base,
        paymentId: r.paymentId,
        amount: r.amount,
        destination: 'SOURCE',
      });
      refundIds.push(refund.id);
    }
    if (allocation.toWallet > 0) {
      const refund = await this.refunds.create(tx, {
        ...base,
        paymentId: null,
        amount: allocation.toWallet,
        destination: 'WALLET',
      });
      refundIds.push(refund.id);
    }
    if (refundIds.length > 0)
      await tx.order.update({ where: { id: order.id }, data: { refundStatus: 'PENDING' } });
    return refundIds;
  }

  /** JOB-ORD-002 timeout (T08b): full refund, fault RESTAURANT. */
  async acceptTimeout(orderId: string): Promise<void> {
    try {
      await this.cancel({
        orderId,
        actor: { type: 'SYSTEM' },
        reasonCode: 'ACCEPT_TIMEOUT',
        fault: 'RESTAURANT',
      });
    } catch (error) {
      // Accepted or cancelled meanwhile: nothing to do.
      if (
        error instanceof AppError &&
        (error.code === 'ORDER_STATE_CONFLICT' || error.code === 'ORDER_INVALID_TRANSITION')
      )
        return;
      throw error;
    }
  }

  /**
   * BR-REST-009: N consecutive acceptance timeouts pause the branch. "Consecutive"
   * means the branch's last N orders that left PLACED all timed out.
   */
  private async missedOrder(tx: Tx, order: Order): Promise<boolean> {
    const threshold = await this.settings.get('restaurant.missedOrderPauseThreshold');
    const recent = await tx.order.findMany({
      where: {
        branchId: order.branchId,
        placedAt: { not: null },
        status: { notIn: ['PAYMENT_PENDING', 'PLACED'] },
      },
      orderBy: { placedAt: 'desc' },
      take: threshold,
      select: { id: true, cancellation: { select: { reasonCode: true } } },
    });
    if (
      recent.length < threshold ||
      !recent.every((o) => o.cancellation?.reasonCode === 'ACCEPT_TIMEOUT')
    )
      return false;
    const minutes = await this.settings.get('restaurant.missedOrderPauseMinutes');
    const until = new Date(this.clock.now().getTime() + minutes * 60_000);
    const branch = await tx.branch.update({
      where: { id: order.branchId },
      data: {
        pausedUntil: until,
        pauseReason: `Auto-paused after ${threshold} missed orders`,
        menuVersion: { increment: 1 },
      },
    });
    await writeOutbox(tx, {
      aggregateType: 'branch',
      aggregateId: branch.id,
      aggregateVersion: branch.menuVersion,
      eventType: 'branch.auto_paused',
      payload: { branchId: branch.id, pausedUntil: until.toISOString(), missedOrders: threshold },
    });
    await raiseOpsAlert(tx, {
      type: 'BRANCH_AUTO_PAUSED',
      severity: 'WARNING',
      refType: 'branch',
      refId: branch.id,
      message: `${branch.name} paused until ${until.toISOString()} after ${threshold} missed orders.`,
      dedupeKey: `branch-paused:${branch.id}:${until.toISOString().slice(0, 16)}`,
    });
    return true;
  }
}
