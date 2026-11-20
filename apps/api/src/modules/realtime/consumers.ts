import type { OutboxEvent, PrismaClient } from '@fos/db';
import type { ClientApp } from '@fos/shared';
import type { OutboxRelay } from '../../platform/outbox-relay';
import type { Realtime } from '../../platform/realtime/publisher';

/** The part of dispatch the projections need (kept structural). */
export interface OfferCards {
  offerView(assignmentId: string): Promise<Record<string, unknown> | null>;
}

export interface RealtimeConsumerDeps {
  prisma: PrismaClient;
  realtime: Realtime;
  offers: OfferCards;
}

type Payload = Record<string, unknown>;
const str = (p: Payload, k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
const ENDED_ORDER = ['CANCELLED', 'REJECTED', 'FAILED'];
const LIVE_DELIVERY = ['ASSIGNED', 'AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER'];

/**
 * SRS §13.5: domain events from the outbox become per-audience socket events.
 * Each audience gets its own projection (§13.4): the restaurant never sees the
 * customer's phone, the customer sees the partner's first name only, and so on.
 * The outbox event id is reused, so a retried relay batch is de-duplicated by clients.
 */
export function registerRealtimeConsumers(relay: OutboxRelay, deps: RealtimeConsumerDeps): void {
  const { prisma, realtime } = deps;
  const push = (
    e: OutboxEvent,
    app: ClientApp,
    rooms: string[],
    event: string,
    data: Payload,
    aggregate = { type: e.aggregateType, id: e.aggregateId, version: e.aggregateVersion },
  ) =>
    realtime.push({
      app,
      rooms,
      event,
      data,
      aggregate,
      eventId: e.eventId,
      occurredAt: e.createdAt,
    });

  const orderFacts = (orderId: string) =>
    prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        status: true,
        version: true,
        userId: true,
        branchId: true,
        placedAt: true,
        readyBy: true,
        etaMinAt: true,
        etaMaxAt: true,
        paymentMethod: true,
        payableAmount: true,
        cookingInstructions: true,
        branch: { select: { zoneId: true } },
        items: {
          select: {
            itemName: true,
            variantName: true,
            quantity: true,
            options: { select: { optionName: true } },
          },
        },
        delivery: { select: { id: true, status: true, partnerId: true } },
      },
    });

  /* ------------------------------ orders ------------------------------ */

  relay.on('order.created', async (e) => {
    const p = e.payload as Payload;
    const userId = str(p, 'userId');
    const o = await orderFacts(e.aggregateId);
    if (!userId || !o) return;
    await push(e, 'CUSTOMER', [`user:${userId}`], 'order.created', {
      orderId: o.id,
      number: o.number,
      status: o.status,
      payable: o.payableAmount,
    });
  });

  relay.on('order.*', async (e) => {
    const p = e.payload as Payload;
    const to = str(p, 'to');
    if (!to) return; // not a transition (created, reminders, extensions are handled below)
    const o = await orderFacts(e.aggregateId);
    if (!o) return;
    const from = str(p, 'from');
    const reason = str(p, 'reason');
    const at = e.createdAt.toISOString();
    const eta = o.etaMinAt && o.etaMaxAt ? { min: o.etaMinAt, max: o.etaMaxAt } : null;
    const ended = ENDED_ORDER.includes(to);

    // Customer (EVT-ORD-002/003).
    const customerRooms = [`order:${o.id}`, `user:${o.userId}`];
    await push(e, 'CUSTOMER', customerRooms, 'order.status_changed', {
      orderId: o.id,
      from,
      to,
      at,
      eta,
      ...(reason ? { reason } : {}),
    });
    if (ended)
      await push(e, 'CUSTOMER', customerRooms, 'order.cancelled', {
        orderId: o.id,
        status: to,
        reason,
        initiator: str(p, 'actorType'),
      });

    // Restaurant (EVT-REST-001…003, 007). The kitchen projection carries no prices.
    const branchRooms = [
      `branch:${o.branchId}:orders`,
      `branch:${o.branchId}:kds`,
      `order:${o.id}`,
    ];
    const items = o.items.map((i) => ({
      name: i.variantName ? `${i.itemName} (${i.variantName})` : i.itemName,
      quantity: i.quantity,
      options: i.options.map((x) => x.optionName),
    }));
    if (to === 'PLACED') {
      await push(e, 'RESTAURANT', [`branch:${o.branchId}:orders`], 'order.new', {
        id: o.id,
        number: o.number,
        status: to,
        placedAt: o.placedAt,
        paymentMethod: o.paymentMethod,
        items,
        instructions: o.cookingInstructions,
      });
      await push(e, 'RESTAURANT', [`branch:${o.branchId}:kds`], 'order.new', {
        id: o.id,
        number: o.number,
        status: to,
        placedAt: o.placedAt,
        items,
        instructions: o.cookingInstructions,
      });
    } else if (from && from !== 'PAYMENT_PENDING') {
      if (ended)
        await push(e, 'RESTAURANT', branchRooms, 'order.cancelled', {
          id: o.id,
          reason,
          initiator: str(p, 'actorType'),
          stopPreparation: true,
        });
      else
        await push(
          e,
          'RESTAURANT',
          branchRooms,
          to === 'PICKED_UP' ? 'delivery.picked_up' : 'order.updated',
          {
            id: o.id,
            orderId: o.id,
            status: to,
            version: o.version,
            readyBy: o.readyBy,
            at,
          },
        );
    }

    // Assigned partner (EVT-DP-010/011).
    if (o.delivery?.partnerId && LIVE_DELIVERY.includes(o.delivery.status)) {
      const room = [`delivery:${o.delivery.id}`];
      if (to === 'READY_FOR_PICKUP')
        await push(e, 'DELIVERY', room, 'order.ready', { orderId: o.id, readyAt: at });
      if (ended) await push(e, 'DELIVERY', room, 'order.cancelled', { orderId: o.id, reason });
    }

    // Operations feed (EVT-ADM-001).
    await push(e, 'ADMIN', ['admin:ops', `admin:zone:${o.branch.zoneId}`], 'ops.order_activity', {
      orderId: o.id,
      number: o.number,
      zoneId: o.branch.zoneId,
      status: to,
      at,
    });
  });

  relay.on('order.accept_reminder', async (e) => {
    const p = e.payload as Payload;
    const branchId = str(p, 'branchId');
    if (branchId)
      await push(e, 'RESTAURANT', [`branch:${branchId}:orders`], 'order.accept_reminder', {
        id: e.aggregateId,
        number: str(p, 'number'),
      });
  });

  relay.on('order.prep_extended', async (e) => {
    const o = await orderFacts(e.aggregateId);
    if (!o) return;
    const minutes = (e.payload as Payload).minutes;
    if (o.delivery && LIVE_DELIVERY.includes(o.delivery.status))
      await push(e, 'DELIVERY', [`delivery:${o.delivery.id}`], 'order.prep_delayed', {
        orderId: o.id,
        newReadyBy: o.readyBy,
      });
    await push(e, 'CUSTOMER', [`order:${o.id}`], 'order.eta_updated', {
      eta: o.etaMinAt && o.etaMaxAt ? { min: o.etaMinAt, max: o.etaMaxAt } : null,
      reason: 'PREP_DELAY',
      minutes,
    });
    await push(
      e,
      'RESTAURANT',
      [`branch:${o.branchId}:orders`, `branch:${o.branchId}:kds`],
      'order.updated',
      {
        id: o.id,
        status: o.status,
        version: o.version,
        readyBy: o.readyBy,
      },
    );
  });

  /* ---------------------------- payments ----------------------------- */

  relay.on('payment.*', async (e) => {
    const orderId = str(e.payload as Payload, 'orderId');
    if (!orderId) return;
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true } });
    if (!o) return;
    await push(e, 'CUSTOMER', [`user:${o.userId}`], 'payment.status_changed', {
      paymentId: e.aggregateId,
      orderId,
      status: e.eventType.split('.')[1]!.toUpperCase(),
    });
  });

  relay.on('refund.succeeded', async (e) => {
    const p = e.payload as Payload;
    const orderId = str(p, 'orderId');
    if (!orderId) return;
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true } });
    if (!o) return;
    await push(e, 'CUSTOMER', [`user:${o.userId}`, `order:${orderId}`], 'refund.status_changed', {
      refundId: e.aggregateId,
      orderId,
      amount: p.amount,
      destination: p.destination,
      status: 'SUCCEEDED',
    });
  });

  /* --------------------------- deliveries ---------------------------- */

  const partnerCard = (partnerId: string) =>
    prisma.deliveryPartner.findUnique({
      where: { id: partnerId },
      select: {
        user: { select: { fullName: true } },
        vehicles: { where: { isActive: true, deletedAt: null }, select: { type: true } },
        stats: { select: { ratingAvgBps: true } },
      },
    });

  relay.on('delivery.offer_created', async (e) => {
    const p = e.payload as Payload;
    const partnerId = str(p, 'partnerId');
    const assignmentId = str(p, 'assignmentId');
    if (!partnerId || !assignmentId) return;
    const card = await deps.offers.offerView(assignmentId);
    if (card) await push(e, 'DELIVERY', [`partner:${partnerId}`], 'offer.created', card);
  });

  relay.on('delivery.*', async (e) => {
    const p = e.payload as Payload;
    const to = str(p, 'to');
    const orderId = str(p, 'orderId');
    if (!to || !orderId) return;
    const deliveryId = e.aggregateId;
    const partnerId = str(p, 'partnerId');
    const previous = str(p, 'previousPartnerId');
    const at = e.createdAt.toISOString();
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { branchId: true },
    });
    if (!order) return;
    const orderRoom = [`order:${orderId}`];
    const branchRoom = [`branch:${order.branchId}:orders`];

    if (to === 'ASSIGNED' && partnerId) {
      const c = await partnerCard(partnerId);
      const card = c && {
        firstName: c.user.fullName.split(/\s+/)[0],
        vehicleType: c.vehicles[0]?.type ?? null,
        rating: c.stats?.ratingAvgBps ? c.stats.ratingAvgBps / 100 : null,
      };
      await push(e, 'CUSTOMER', orderRoom, 'delivery.partner_assigned', { orderId, partner: card });
      await push(e, 'RESTAURANT', branchRoom, 'delivery.partner_assigned', {
        orderId,
        partner: card,
      });
      await realtime.join('DELIVERY', `partner:${partnerId}`, `delivery:${deliveryId}`);
      await push(e, 'DELIVERY', [`partner:${partnerId}`], 'assignment.confirmed', {
        deliveryId,
        orderId,
      });
      return;
    }
    if (to === 'SEARCHING' && previous) {
      // Released or unassigned (D08): the old partner leaves, the customer waits for a new one.
      await push(e, 'CUSTOMER', orderRoom, 'delivery.partner_unassigned', {
        orderId,
        reason: 'REASSIGNING',
      });
      await push(e, 'DELIVERY', [`partner:${previous}`], 'assignment.revoked', {
        deliveryId,
        reason: str(p, 'reason') ?? 'RELEASED',
      });
      await realtime.leave('DELIVERY', `partner:${previous}`, `delivery:${deliveryId}`);
      return;
    }
    if (
      ['AT_RESTAURANT', 'EN_ROUTE_TO_CUSTOMER', 'AT_CUSTOMER', 'DELIVERED', 'FAILED'].includes(to)
    )
      await push(e, 'CUSTOMER', orderRoom, 'delivery.status_changed', { orderId, status: to, at });
    if (to === 'AT_RESTAURANT' && partnerId) {
      const c = await partnerCard(partnerId);
      await push(e, 'RESTAURANT', branchRoom, 'delivery.partner_arrived', {
        orderId,
        partner: c ? c.user.fullName.split(/\s+/)[0] : null,
      });
    }
    if (['DELIVERED', 'FAILED', 'CANCELLED'].includes(to)) {
      const who = partnerId ?? previous;
      if (who) {
        await realtime.leave('DELIVERY', `partner:${who}`, `delivery:${deliveryId}`);
        if (to === 'DELIVERED') {
          const earning = await prisma.partnerEarning.findUnique({
            where: { deliveryId },
            select: {
              totalAmount: true,
              tipAmount: true,
              baseAmount: true,
              distanceAmount: true,
              waitAmount: true,
              surgeAmount: true,
            },
          });
          await push(e, 'DELIVERY', [`partner:${who}`], 'earnings.updated', {
            deliveryId,
            last: earning,
          });
        }
        if (to === 'CANCELLED')
          await push(e, 'DELIVERY', [`partner:${who}`], 'assignment.revoked', {
            deliveryId,
            reason: 'ORDER_CANCELLED',
          });
      }
    }
  });

  /* --------------------------- restaurants --------------------------- */

  relay.on('branch.*', async (e) => {
    const branchId = str(e.payload as Payload, 'branchId') ?? e.aggregateId;
    const b = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, zoneId: true, pausedUntil: true },
    });
    if (!b) return;
    const data = {
      branchId,
      change: e.eventType.split('.')[1],
      pausedUntil: b.pausedUntil,
      ...(e.payload as Payload),
    };
    await push(
      e,
      'RESTAURANT',
      [`branch:${branchId}:status`, `branch:${branchId}:orders`],
      'branch.status_changed',
      data,
    );
    await push(e, 'ADMIN', [`admin:zone:${b.zoneId}`], 'restaurant.activity', data);
  });

  /* ------------------------------ admin ------------------------------ */

  const approval = (type: string) => async (e: OutboxEvent) => {
    await push(e, 'ADMIN', ['admin:ops'], 'ops.approval_requested', { type, id: e.aggregateId });
  };
  relay.on('restaurant.application_submitted', approval('RESTAURANT'));
  relay.on('restaurant.change_requested', approval('RESTAURANT_CHANGE'));
  relay.on('partner.application_submitted', approval('PARTNER'));
  relay.on('ticket.*', async (e) => {
    const p = e.payload as Payload;
    await push(e, 'ADMIN', ['admin:ops'], 'support.ticket_updated', {
      ticketId: str(p, 'ticketId') ?? e.aggregateId,
      change: e.eventType.split('.')[1],
      priority: p.priority ?? null,
    });
  });
}
