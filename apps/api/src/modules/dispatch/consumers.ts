import type { OutboxRelay } from '../../platform/outbox-relay';
import type { DispatchService } from './dispatch.service';

/** Deliveries follow their order (T06 → D01; cancellation/rejection → delivery ends). */
export function registerDispatchConsumers(relay: OutboxRelay, dispatch: DispatchService): void {
  relay
    .on('order.accepted', async (e) => {
      await dispatch.createFor(e.aggregateId);
    })
    .on('order.cancelled', (e) => dispatch.cancelForOrder(e.aggregateId))
    .on('order.rejected', (e) => dispatch.cancelForOrder(e.aggregateId));
}
