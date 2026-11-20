import type { PrismaClient } from '@fos/db';
import type { OutboxRelay } from '../../platform/outbox-relay';
import type { InvoiceService } from './invoice.service';
import type { OrderPaymentReactions } from './payment-reactions';

const orderIdOf = (payload: unknown): string => {
  const id = (payload as { orderId?: unknown } | null)?.orderId;
  if (typeof id !== 'string') throw new Error('event payload has no orderId');
  return id;
};

/** Order reactions to payment facts and its own milestones, delivered by the outbox relay. */
export function registerOrderConsumers(
  relay: OutboxRelay,
  deps: { prisma: PrismaClient; reactions: OrderPaymentReactions; invoices: InvoiceService },
): void {
  relay
    .on('payment.captured', (e) => deps.reactions.onCaptured(orderIdOf(e.payload), e.aggregateId))
    .on('refund.succeeded', (e) => deps.reactions.onRefundSucceeded(orderIdOf(e.payload)))
    // FR-CORD-009: the invoice number is fixed when the order is delivered.
    .on('order.delivered', async (e) => {
      await deps.prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: e.aggregateId },
          select: { id: true, status: true },
        });
        if (order?.status === 'DELIVERED') await deps.invoices.issue(tx, order);
      });
    });
}
