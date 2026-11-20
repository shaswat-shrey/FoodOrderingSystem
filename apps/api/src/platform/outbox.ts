import type { Prisma } from '@fos/db';
import { uuidv7 } from '@fos/shared';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Transactional outbox (ADR-010): written in the same transaction as the state
 * change, published later by the relay (Phase 7), so events are never lost or
 * emitted for rolled-back changes.
 */
export async function writeOutbox(
  tx: Prisma.TransactionClient,
  event: OutboxEventInput,
): Promise<string> {
  const eventId = uuidv7();
  await tx.outboxEvent.create({
    data: { eventId, ...event, payload: event.payload as Prisma.InputJsonValue },
  });
  return eventId;
}
