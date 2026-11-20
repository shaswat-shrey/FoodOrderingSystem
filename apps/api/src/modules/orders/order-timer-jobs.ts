import type { PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import type { Logger } from '../../platform/logger';
import { raiseOpsAlert } from '../../platform/ops-alerts';
import { writeOutbox } from '../../platform/outbox';
import type { OrderPaymentReactions } from './payment-reactions';
import { ORDER_JOBS, type OrderTimers } from './timers';
import type { OrderTransitions } from './transition.service';

/** Statuses whose timers the sweeper keeps alive (JOB-ORD-007). */
const TIMED = [
  'PAYMENT_PENDING',
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
] as const;

/** Raised by a transition that lost a race with another actor: the timer has nothing to do. */
function raced(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'ORDER_STATE_CONFLICT' || error.code === 'ORDER_INVALID_TRANSITION')
  );
}

/**
 * Handlers for the `orders` queue (EVENTS-AND-JOBS §3, JOB-ORD-001…007).
 * Every handler re-checks the order's status first, so late, duplicate or
 * re-created jobs are harmless. Acceptance timeout (T08b) is registered by the
 * cancellation module through `onAcceptTimeout`.
 */
export class OrderTimerJobs {
  /** Set by the cancellation module (T08b). */
  onAcceptTimeout: ((orderId: string) => Promise<void>) | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly transitions: OrderTransitions,
    private readonly reactions: OrderPaymentReactions,
    private readonly timers: OrderTimers,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async run(name: string, orderId: string): Promise<void> {
    switch (name) {
      case ORDER_JOBS.paymentTtl:
        await this.reactions.expirePayment(orderId);
        return;
      case ORDER_JOBS.acceptReminder:
        return this.acceptReminder(orderId);
      case ORDER_JOBS.acceptTimeout:
        if (!(await this.is(orderId, 'PLACED'))) return;
        if (!this.onAcceptTimeout) throw new Error('acceptance timeout handler not registered');
        await this.onAcceptTimeout(orderId);
        return;
      case ORDER_JOBS.autoPreparing:
        return this.autoPreparing(orderId);
      case ORDER_JOBS.prepDelay:
        return this.alertIf(
          orderId,
          'PREPARING',
          'ORDER_PREP_DELAYED',
          'WARNING',
          (n) => `Order ${n} is past its ready-by time.`,
        );
      case ORDER_JOBS.pickupDelay:
        return this.alertIf(
          orderId,
          'READY_FOR_PICKUP',
          'ORDER_PICKUP_DELAYED',
          'WARNING',
          (n, at) => {
            const minutes = at.readyAt
              ? Math.round((this.clock.now().getTime() - at.readyAt.getTime()) / 60_000)
              : 0;
            return `Order ${n} has waited ${minutes} min for pickup.`;
          },
        );
      case ORDER_JOBS.deliveryOverdue:
        return this.alertIf(
          orderId,
          'PICKED_UP',
          'ORDER_DELIVERY_OVERDUE',
          'CRITICAL',
          (n) => `Order ${n} is overdue for delivery.`,
        );
      default:
        throw new Error(`Unknown orders job: ${name}`);
    }
  }

  private async is(orderId: string, status: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    return order?.status === status;
  }

  /** JOB-ORD-002 reminder: an event the restaurant notification consumer turns into a nudge. */
  private async acceptReminder(orderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (order?.status !== 'PLACED') return;
      await writeOutbox(tx, {
        aggregateType: 'order',
        aggregateId: order.id,
        aggregateVersion: order.version,
        eventType: 'order.accept_reminder',
        payload: { orderId: order.id, branchId: order.branchId, number: order.number },
      });
    });
  }

  /** JOB-ORD-003: T09 by the system when the kitchen didn't mark it. */
  private async autoPreparing(orderId: string): Promise<void> {
    if (!(await this.is(orderId, 'ACCEPTED'))) return;
    try {
      const order = await this.prisma.$transaction(
        async (tx) =>
          (
            await this.transitions.apply(tx, {
              orderId,
              to: 'PREPARING',
              actor: { type: 'SYSTEM' },
              reason: 'Auto-preparing',
            })
          ).order,
      );
      await this.timers.afterPreparing(order);
    } catch (error) {
      if (!raced(error)) throw error;
    }
  }

  private async alertIf(
    orderId: string,
    status: string,
    type: string,
    severity: 'WARNING' | 'CRITICAL',
    message: (number: string, order: { readyAt: Date | null }) => string,
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, number: true, readyAt: true },
    });
    if (order?.status !== status) return;
    await raiseOpsAlert(this.prisma, {
      type,
      severity,
      message: message(order.number, order),
      refType: 'order',
      refId: orderId,
      dedupeKey: `${type}:${orderId}:${this.clock.now().toISOString().slice(0, 16)}`,
    });
  }

  /** JOB-ORD-007: re-creates timers for every open order (e.g. after a Redis flush). */
  async sweep(): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.order.findMany({
        where: { status: { in: [...TIMED] } },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const order of batch) await this.timers.resume(order);
      count += batch.length;
      if (batch.length < 500) break;
      cursor = batch.at(-1)!.id;
    }
    if (count > 0) this.logger.debug({ count }, 'order timers re-armed');
    return count;
  }
}
