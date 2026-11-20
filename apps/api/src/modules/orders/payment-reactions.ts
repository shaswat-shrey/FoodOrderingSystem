import type { PrismaClient } from '@fos/db';
import type { Logger } from '../../platform/logger';
import type { PaymentsService, RefundService } from '../payments';
import type { OrderEffects } from './order-effects';
import type { OrderTimers } from './timers';
import type { OrderTransitions } from './transition.service';

/** How orders react to payment facts (T03, T04, E10). Idempotent: every step re-checks state. */
export class OrderPaymentReactions {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly transitions: OrderTransitions,
    private readonly effects: OrderEffects,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundService,
    private readonly timers: OrderTimers,
    private readonly logger: Logger,
  ) {}

  /** `payment.captured` → T03, or a refund for a second capture (E10). */
  async onCaptured(orderId: string, paymentId: string): Promise<void> {
    let placed = false;
    const refundIds: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const order = await this.transitions.lock(tx, orderId);
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (order.status === 'PAYMENT_PENDING') {
        const { order: updated } = await this.transitions.apply(tx, {
          orderId,
          to: 'PLACED',
          actor: { type: 'SYSTEM' },
          reason: 'Payment captured',
          metadata: { paymentId },
        });
        await this.effects.consume(tx, updated);
        placed = true;
        return;
      }
      // Already placed by an earlier capture: this one is a duplicate payment (E10).
      const earlier = await tx.payment.count({
        where: {
          orderId,
          id: { not: paymentId },
          status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          capturedAt: { lte: payment.capturedAt ?? new Date() },
        },
      });
      if (earlier > 0 && payment.refundedAmount === 0) {
        const pending = await tx.refund.count({
          where: { paymentId, reasonCode: 'DUPLICATE_PAYMENT' },
        });
        if (pending === 0) {
          const refund = await this.refunds.create(tx, {
            orderId,
            paymentId,
            amount: payment.capturedAmount,
            destination: 'SOURCE',
            reasonCode: 'DUPLICATE_PAYMENT',
            initiatorType: 'SYSTEM',
            costBearer: 'PLATFORM',
          });
          refundIds.push(refund.id);
        }
      }
    });
    if (placed) await this.timers.afterPlaced(orderId);
    for (const id of refundIds) await this.refunds.schedule(id);
  }

  /**
   * JOB-ORD-001: the payment window closed. Ask the provider first; if nothing
   * was captured, T04 → FAILED (PAYMENT_EXPIRED) and give everything back.
   */
  async expirePayment(orderId: string): Promise<'PLACED' | 'FAILED' | 'NOOP'> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (order?.status !== 'PAYMENT_PENDING') return 'NOOP';
    await this.payments.pollOrder(orderId); // throws (job retries) if the provider can't be asked
    const captured = await this.prisma.payment.findFirst({
      where: { orderId, status: 'CAPTURED' },
      orderBy: { capturedAt: 'asc' },
    });
    if (captured) {
      await this.onCaptured(orderId, captured.id);
      return 'PLACED';
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.transitions.lock(tx, orderId);
      if (locked.status !== 'PAYMENT_PENDING') return 'NOOP' as const;
      const { order: failed } = await this.transitions.apply(tx, {
        orderId,
        to: 'FAILED',
        failureReason: 'PAYMENT_EXPIRED',
        actor: { type: 'SYSTEM' },
        reason: 'Payment not completed in time',
      });
      await this.payments.closeOpenPayments(tx, orderId, 'EXPIRED');
      await this.effects.release(tx, failed, 'PAYMENT_PENDING', { restoreCoupon: true });
      return 'FAILED' as const;
    });
    if (result === 'FAILED') this.logger.info({ orderId }, 'order failed: payment window expired');
    return result;
  }

  /** `refund.succeeded` → orders.refund_status (derived from refund records). */
  async onRefundSucceeded(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;
    const [refunded, captured] = await Promise.all([
      this.prisma.refund.aggregate({
        where: { orderId, status: 'SUCCEEDED' },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: { orderId, method: 'ONLINE' },
        _sum: { capturedAmount: true },
      }),
    ]);
    const paid = (captured._sum.capturedAmount ?? 0) + order.walletAppliedAmount;
    const total = refunded._sum.amount ?? 0;
    const status = total <= 0 ? 'NONE' : total >= paid ? 'FULL' : 'PARTIAL';
    if (status !== order.refundStatus)
      await this.prisma.order.update({ where: { id: orderId }, data: { refundStatus: status } });
  }
}
