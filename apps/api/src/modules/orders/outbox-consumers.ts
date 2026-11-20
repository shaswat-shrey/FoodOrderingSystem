import type { OutboxRelay } from '../../platform/outbox-relay';
import type { OrderPaymentReactions } from './payment-reactions';

const orderIdOf = (payload: unknown): string => {
  const id = (payload as { orderId?: unknown } | null)?.orderId;
  if (typeof id !== 'string') throw new Error('event payload has no orderId');
  return id;
};

/** Order reactions to payment facts, delivered by the outbox relay. */
export function registerOrderConsumers(relay: OutboxRelay, reactions: OrderPaymentReactions): void {
  relay
    .on('payment.captured', (e) => reactions.onCaptured(orderIdOf(e.payload), e.aggregateId))
    .on('refund.succeeded', (e) => reactions.onRefundSucceeded(orderIdOf(e.payload)));
}
