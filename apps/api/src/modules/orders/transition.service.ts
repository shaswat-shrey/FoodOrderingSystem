import type { Order, OrderFailureReason, OrderStatus, Prisma } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { writeOutbox } from '../../platform/outbox';
import {
  eventFor,
  findTransition,
  STATUS_TIMESTAMP,
  TERMINAL,
  type OrderActor,
  type TransitionRule,
} from './transitions';

type Tx = Prisma.TransactionClient;

export interface TransitionInput {
  orderId: string;
  to: OrderStatus;
  actor: { type: OrderActor; id?: string | null };
  /** Optimistic check from the client (FR-ORDER-023). */
  expectedVersion?: number;
  reason?: string;
  failureReason?: OrderFailureReason;
  metadata?: Record<string, unknown>;
  /** Extra columns to set in the same update (e.g. readyBy, prepMinutes). */
  patch?: Prisma.OrderUncheckedUpdateInput;
}

/**
 * The only way an order's status changes (SRS §10.3): row lock, version check,
 * allowed actor, timestamps, immutable history row(s), outbox event — all in
 * the caller's transaction, so side effects commit or roll back together.
 */
export class OrderTransitions {
  constructor(private readonly clock: Clock) {}

  async lock(tx: Tx, orderId: string): Promise<Order> {
    const [row] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    if (!row) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  }

  async apply(
    tx: Tx,
    input: TransitionInput,
  ): Promise<{ order: Order; rule: TransitionRule; previous: Order }> {
    const order = await this.lock(tx, input.orderId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== order.version) {
      throw new AppError('ORDER_STATE_CONFLICT', {
        details: [{ code: 'CURRENT_STATUS', message: order.status }],
      });
    }
    const rule = findTransition(order.status, input.to, input.actor.type);
    if (!rule) {
      throw new AppError(
        TERMINAL.has(order.status) || order.status !== input.to
          ? 'ORDER_INVALID_TRANSITION'
          : 'ORDER_STATE_CONFLICT',
        {
          message: `This order is ${order.status.toLowerCase().replace(/_/g, ' ')} and can't move to ${input.to.toLowerCase().replace(/_/g, ' ')}.`,
          details: [{ code: 'CURRENT_STATUS', message: order.status }],
        },
      );
    }
    if (input.to === 'FAILED' && !input.failureReason)
      throw new Error('FAILED transitions need a failure reason');

    const now = this.clock.now();
    // T13c: handover before "ready" records both steps (SRS §10.3).
    const steps: OrderStatus[] =
      rule.id === 'T13c' ? ['READY_FOR_PICKUP', 'PICKED_UP'] : [input.to];
    const stamps: Prisma.OrderUncheckedUpdateInput = {};
    for (const s of steps) {
      const column = STATUS_TIMESTAMP[s];
      if (column) stamps[column] = now;
    }
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        ...input.patch,
        ...stamps,
        status: input.to,
        ...(input.to === 'FAILED' ? { failureReason: input.failureReason } : {}),
        version: { increment: 1 },
      },
    });
    let from: OrderStatus = order.status;
    for (const s of steps) {
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: from,
          toStatus: s,
          actorType: input.actor.type,
          actorId: input.actor.id ?? null,
          reason: input.reason?.slice(0, 300) ?? null,
          metadata: { transition: rule.id, ...(input.metadata ?? {}) } as Prisma.InputJsonValue,
        },
      });
      from = s;
    }
    await writeOutbox(tx, {
      aggregateType: 'order',
      aggregateId: order.id,
      aggregateVersion: updated.version,
      eventType: eventFor(input.to),
      payload: {
        orderId: order.id,
        userId: order.userId,
        branchId: order.branchId,
        from: order.status,
        to: input.to,
        transition: rule.id,
        actorType: input.actor.type,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    return { order: updated, rule, previous: order };
  }
}
