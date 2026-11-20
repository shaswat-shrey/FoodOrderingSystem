import type { OutboxEvent, PrismaClient } from '@fos/db';
import type { OutboxRelay } from '../../platform/outbox-relay';
import type { NotificationService } from './notification.service';

const CUSTOMER_STATUS_KEYS: Record<string, string> = {
  'order.placed': 'order.placed',
  'order.accepted': 'order.accepted',
  'order.preparing': 'order.preparing',
  'order.ready_for_pickup': 'order.ready_for_pickup',
  'order.picked_up': 'order.picked_up',
  'order.delivered': 'order.delivered',
  'order.rejected': 'order.rejected',
};

const rupees = (paise: number) => (paise / 100).toFixed(2);

/**
 * Turns domain events into notifications (FR-NOTIF-010, EVENTS-AND-JOBS §3).
 * Every send uses the outbox event id, so a replayed event sends nothing twice.
 */
export function registerNotificationConsumers(
  relay: OutboxRelay,
  deps: { prisma: PrismaClient; notifications: NotificationService },
): void {
  const { prisma, notifications } = deps;

  const orderFacts = (orderId: string) =>
    prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        userId: true,
        status: true,
        failureReason: true,
        placedAt: true,
        restaurantId: true,
        branchId: true,
        branch: { select: { name: true, restaurant: { select: { brandName: true } } } },
        items: { select: { quantity: true } },
        cancellation: { select: { refundAmount: true, initiatorType: true } },
      },
    });

  /** Active members of the restaurant who work at this branch. */
  const branchStaff = async (restaurantId: string, branchId: string) =>
    (
      await prisma.restaurantMember.findMany({
        where: {
          restaurantId,
          status: 'ACTIVE',
          OR: [{ allBranches: true }, { branches: { some: { branchId } } }],
        },
        select: { userId: true },
      })
    ).map((m) => m.userId);

  const onOrderEvent = async (e: OutboxEvent) => {
    const o = await orderFacts(e.aggregateId);
    if (!o) return;
    const base = {
      number: o.number,
      orderId: o.id,
      restaurant: o.branch.restaurant.brandName,
    };
    const customerKey =
      e.eventType === 'order.failed'
        ? o.failureReason === 'PAYMENT_EXPIRED'
          ? 'order.payment_expired'
          : null
        : e.eventType === 'order.cancelled'
          ? 'order.cancelled'
          : (CUSTOMER_STATUS_KEYS[e.eventType] ?? null);
    if (customerKey) {
      const refund = o.cancellation?.refundAmount ?? 0;
      await notifications.notify({
        eventId: e.eventId,
        userId: o.userId,
        key: customerKey,
        vars: {
          ...base,
          refundText:
            refund > 0 ? `Rs. ${rupees(refund)} will be refunded.` : 'You have not been charged.',
        },
        data: { orderId: o.id, status: o.status },
      });
    }
    const staffKey =
      e.eventType === 'order.placed'
        ? 'restaurant.new_order'
        : e.eventType === 'order.accept_reminder'
          ? 'restaurant.accept_reminder'
          : e.eventType === 'order.cancelled' &&
              o.placedAt &&
              o.cancellation?.initiatorType !== 'RESTAURANT'
            ? 'restaurant.order_cancelled'
            : null;
    if (staffKey) {
      for (const userId of await branchStaff(o.restaurantId, o.branchId)) {
        await notifications.notify({
          eventId: e.eventId,
          userId,
          key: staffKey,
          vars: {
            number: o.number,
            orderId: o.id,
            branch: o.branch.name,
            itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
          },
          data: { orderId: o.id, branchId: o.branchId },
        });
      }
    }
  };

  relay
    .on('order.*', onOrderEvent)
    .on('refund.succeeded', async (e) => {
      const p = e.payload as { orderId?: string; amount?: number; destination?: string };
      if (!p.orderId || !p.amount) return;
      const order = await prisma.order.findUnique({
        where: { id: p.orderId },
        select: { id: true, number: true, userId: true },
      });
      if (!order) return;
      await notifications.notify({
        eventId: e.eventId,
        userId: order.userId,
        key: 'refund.succeeded',
        vars: {
          number: order.number,
          orderId: order.id,
          amount: rupees(p.amount),
          destinationText:
            p.destination === 'WALLET'
              ? 'is back in your wallet.'
              : 'is on its way to your original payment method (5–7 business days).',
        },
        data: { orderId: order.id },
      });
    })
    .on('ticket.created', async (e) => {
      const t = await prisma.supportTicket.findUnique({
        where: { id: e.aggregateId },
        select: { id: true, number: true, requesterId: true, requesterType: true },
      });
      if (t?.requesterType !== 'CUSTOMER') return;
      await notifications.notify({
        eventId: e.eventId,
        userId: t.requesterId,
        key: 'ticket.created',
        vars: { ticketNumber: t.number, ticketId: t.id },
      });
    });
}
