import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  branchId,
  createTestContext,
  integrationEnabled,
  parkActiveDeliveries,
  placeOrder,
  pushes,
  SAFFRON_STAFF,
  signInAs,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
const ids: Record<string, string> = {};
const RIDER = '+919000000404';

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
  const rid = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } })).restaurantId;
  for (const i of await ctx.prisma.foodItem.findMany({ where: { restaurantId: rid } }))
    ids[i.name] = i.id;
  for (const o of await ctx.prisma.customizationOption.findMany({
    where: { group: { restaurantId: rid } },
  }))
    ids[o.name] = o.id;
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
  await parkActiveDeliveries(ctx);
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
  pushes(ctx).clear();
});

const key = () => ({ 'Idempotency-Key': uuidv7() });
const subject = (userId: string, app: 'CUSTOMER' | 'RESTAURANT' | 'DELIVERY' | 'ADMIN') => ({
  userId,
  sessionId: 's',
  app,
});

async function order() {
  return placeOrder(ctx, {
    branchId: saffron,
    items: [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 1 }],
    paymentMethod: 'COD',
  });
}

suite('room policy (SRS §13.3, FR-RT-010)', () => {
  it('lets each audience into its own rooms only', async () => {
    const o = await order();
    const rooms = ctx.container.rooms;
    expect(
      await rooms.authorize(subject(o.userId, 'CUSTOMER'), { type: 'order', id: o.orderId }),
    ).toBe(`order:${o.orderId}`);
    const stranger = await order();
    expect(
      await rooms.authorize(subject(stranger.userId, 'CUSTOMER'), { type: 'order', id: o.orderId }),
    ).toBeNull();
    expect(
      await rooms.authorize(subject(o.userId, 'CUSTOMER'), { type: 'order', id: uuidv7() }),
    ).toBeNull();

    const manager = await ctx.prisma.user.findFirstOrThrow({
      where: { phone: SAFFRON_STAFF.manager },
    });
    const kitchen = await ctx.prisma.user.findFirstOrThrow({
      where: { phone: SAFFRON_STAFF.kitchen },
    });
    expect(
      await rooms.authorize(subject(manager.id, 'RESTAURANT'), {
        type: 'branch-orders',
        id: saffron,
      }),
    ).toBe(`branch:${saffron}:orders`);
    // The kitchen sees the KDS, not the priced order queue.
    expect(
      await rooms.authorize(subject(kitchen.id, 'RESTAURANT'), {
        type: 'branch-orders',
        id: saffron,
      }),
    ).toBeNull();
    expect(
      await rooms.authorize(subject(kitchen.id, 'RESTAURANT'), { type: 'branch-kds', id: saffron }),
    ).toBe(`branch:${saffron}:kds`);
    const otherBranch = (
      await ctx.prisma.branch.findFirstOrThrow({
        where: { restaurant: { brandName: { not: 'Saffron Handi Biryani' } } },
      })
    ).id;
    expect(
      await rooms.authorize(subject(manager.id, 'RESTAURANT'), {
        type: 'branch-orders',
        id: otherBranch,
      }),
    ).toBeNull();
    expect(await rooms.autoRooms(subject(manager.id, 'RESTAURANT'))).toContain(
      `branch:${saffron}:status`,
    );
    // Customers can't ask for admin rooms.
    expect(await rooms.authorize(subject(o.userId, 'ADMIN'), { type: 'ops' })).toBeNull();
  });
});

suite('pushes from the outbox (SRS §13.5)', () => {
  it('tells the customer, the restaurant (priced and kitchen views) and ops about a new order', async () => {
    const o = await order();
    await ctx.container.outboxRelay.runOnce();
    const p = pushes(ctx);
    expect(p.of('order.created')[0]).toMatchObject({
      app: 'CUSTOMER',
      rooms: [`user:${o.userId}`],
    });
    const fresh = p.of('order.new');
    const queue = fresh.find((x) => x.rooms.includes(`branch:${saffron}:orders`))!;
    const kds = fresh.find((x) => x.rooms.includes(`branch:${saffron}:kds`))!;
    expect(queue.data).toMatchObject({
      id: o.orderId,
      paymentMethod: 'COD',
      items: [{ name: 'Paneer Biryani', quantity: 1 }],
    });
    expect(kds.data).not.toHaveProperty('paymentMethod');
    // §13.4: the restaurant never gets the customer's contact details.
    expect(JSON.stringify(fresh)).not.toMatch(/\+91|contactPhone/);
    expect(p.of('ops.order_activity')[0]?.rooms).toContain('admin:ops');

    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    await manager.browser.post(`/merchant/orders/${o.orderId}/accept`, { prepMinutes: 12 }, key());
    p.clear();
    await ctx.container.outboxRelay.runOnce();
    const status = p.of('order.status_changed')[0]!;
    expect(status).toMatchObject({
      app: 'CUSTOMER',
      rooms: [`order:${o.orderId}`, `user:${o.userId}`],
    });
    expect(status.data).toMatchObject({ from: 'PLACED', to: 'ACCEPTED' });
    expect(status.envelope).toMatchObject({
      event: 'order.status_changed',
      aggregate: { type: 'order', id: o.orderId },
    });
    expect(p.of('order.updated')[0]?.data).toMatchObject({ status: 'ACCEPTED' });
  });

  it('runs a delivery live: offer, assignment room, tracking with throttle, stale and offer expiry', async () => {
    const r = await signInAs(ctx, RIDER, 'DELIVERY');
    await r.browser.post(
      '/partner/me/online',
      { lat: 12.9355, lng: 77.6245, accuracyM: 10, recordedAt: ctx.clock.now().toISOString() },
      key(),
    );
    const partnerId = (
      await ctx.prisma.deliveryPartner.findFirstOrThrow({ where: { user: { phone: RIDER } } })
    ).id;
    const o = await order();
    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    await manager.browser.post(`/merchant/orders/${o.orderId}/accept`, { prepMinutes: 12 }, key());
    await ctx.container.outboxRelay.runOnce();
    const d = await ctx.prisma.delivery.findUniqueOrThrow({ where: { orderId: o.orderId } });
    const p = pushes(ctx);
    p.clear();
    await ctx.container.dispatch.start(d.id);
    await ctx.container.outboxRelay.runOnce();
    const offer = p.of('offer.created')[0]!;
    expect(offer).toMatchObject({ app: 'DELIVERY', rooms: [`partner:${partnerId}`] });
    // The customer sees "Finding a delivery partner" as dispatch starts.
    expect(p.of('delivery.status_changed')).toContainEqual(
      expect.objectContaining({
        app: 'CUSTOMER',
        rooms: [`order:${o.orderId}`],
        data: expect.objectContaining({ status: 'SEARCHING' }),
      }),
    );
    expect(offer.data).toMatchObject({ deliveryId: d.id, payment: { type: 'COD' } });

    await r.browser.post(`/partner/offers/${offer.data.offerId as string}/accept`, {}, key());
    await ctx.container.outboxRelay.runOnce();
    expect(p.rooms).toContainEqual({
      op: 'join',
      app: 'DELIVERY',
      target: `partner:${partnerId}`,
      room: `delivery:${d.id}`,
    });
    expect(
      p
        .of('delivery.partner_assigned')
        .map((x) => x.app)
        .sort(),
    ).toEqual(['CUSTOMER', 'RESTAURANT']);
    expect(p.of('delivery.partner_assigned')[0]?.data).toMatchObject({
      partner: { firstName: expect.any(String) },
    });
    expect(p.of('assignment.confirmed')[0]?.data).toMatchObject({ deliveryId: d.id });

    // Location fan-out to the customer, at most every 3 s (FR-TRK-006).
    p.clear();
    ctx.clock.advance(5_000);
    await r.browser.post('/partner/me/locations', {
      points: [
        { lat: 12.9356, lng: 77.6246, accuracyM: 8, recordedAt: ctx.clock.now().toISOString() },
      ],
    });
    ctx.clock.advance(1_000);
    await r.browser.post('/partner/me/locations', {
      points: [
        { lat: 12.9357, lng: 77.6247, accuracyM: 8, recordedAt: ctx.clock.now().toISOString() },
      ],
    });
    const track = p.of('tracking.location');
    expect(track).toHaveLength(1);
    expect(track[0]).toMatchObject({
      app: 'CUSTOMER',
      rooms: [`order:${o.orderId}`],
      data: { lat: 12.9356, stale: false },
    });

    // FR-TRK-005: silent for over a minute → "Location updating…" once.
    ctx.clock.advance(2 * 60_000);
    await ctx.container.liveTracking.sweepStale();
    await ctx.container.liveTracking.sweepStale();
    expect(p.of('tracking.stale')).toHaveLength(1);

    // Unassign → the partner leaves the room and the customer is told.
    p.clear();
    const fresh = await signInAs(ctx, RIDER, 'DELIVERY');
    await fresh.browser.post(
      `/partner/deliveries/${d.id}/unassign`,
      { reason: 'VEHICLE_BREAKDOWN' },
      key(),
    );
    await ctx.container.outboxRelay.runOnce();
    expect(p.of('delivery.partner_unassigned')[0]?.rooms).toEqual([`order:${o.orderId}`]);
    expect(p.of('assignment.revoked')[0]?.rooms).toEqual([`partner:${partnerId}`]);
    expect(p.rooms).toContainEqual({
      op: 'leave',
      app: 'DELIVERY',
      target: `partner:${partnerId}`,
      room: `delivery:${d.id}`,
    });
  });

  it('closes an unanswered offer on the partner screen (EVT-DP-002)', async () => {
    const r = await signInAs(ctx, RIDER, 'DELIVERY');
    await r.browser.post(
      '/partner/me/online',
      { lat: 12.9355, lng: 77.6245, accuracyM: 10, recordedAt: ctx.clock.now().toISOString() },
      key(),
    );
    const o = await order();
    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    await manager.browser.post(`/merchant/orders/${o.orderId}/accept`, { prepMinutes: 12 }, key());
    await ctx.container.outboxRelay.runOnce();
    const d = await ctx.prisma.delivery.findUniqueOrThrow({ where: { orderId: o.orderId } });
    await ctx.container.dispatch.start(d.id);
    const a = await ctx.prisma.deliveryAssignment.findFirstOrThrow({
      where: { deliveryId: d.id, status: 'OFFERED' },
    });
    pushes(ctx).clear();
    await ctx.container.dispatch.expire(a.id);
    expect(pushes(ctx).of('offer.expired')[0]).toMatchObject({ data: { offerId: a.id } });
    // offer:ack records when the card was shown (diagnostics).
    const next = await ctx.prisma.deliveryAssignment.findFirst({
      where: { deliveryId: d.id, status: 'OFFERED' },
    });
    if (next) {
      const owner = await ctx.prisma.deliveryPartner.findUniqueOrThrow({
        where: { id: next.partnerId },
      });
      await ctx.container.partnerSocket.offerAck(owner.userId, next.id);
      expect(
        (await ctx.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: next.id } }))
          .displayedAt,
      ).not.toBeNull();
    }
  });
});
