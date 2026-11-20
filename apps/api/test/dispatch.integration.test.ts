import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import type { RecordingJobQueue } from '../src/platform/jobs';
import {
  branchId,
  createTestContext,
  integrationEnabled,
  parkActiveDeliveries,
  placeOrder,
  SAFFRON_STAFF,
  signInAs,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
const ids: Record<string, string> = {};

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
  (ctx.container.jobs as RecordingJobQueue).jobs.length = 0;
  // Deliveries left by other tests must not compete for the partners here.
  await parkActiveDeliveries(ctx);
  // Trips completed in other files change the idle/load ranking features.
  await ctx.prisma.partnerStats.updateMany({
    data: {
      acceptanceRateBps30d: 10_000,
      deliveriesToday: 0,
      lastDeliveryCompletedAt: null,
      consecutiveMissedOffers: 0,
    },
  });
  await ctx.prisma.partnerStats.updateMany({ data: { consecutiveMissedOffers: 0 } });
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

const key = () => ({ 'Idempotency-Key': uuidv7() });
const partnerRow = (phone: string) =>
  ctx.prisma.deliveryPartner.findFirstOrThrow({ where: { user: { phone } } });

/** Signs a seeded partner in and puts them online at a point. */
async function online(phone: string, at: { lat: number; lng: number }) {
  const s = await signInAs(ctx, phone, 'DELIVERY');
  const res = await s.browser.post(
    '/partner/me/online',
    { ...at, accuracyM: 10, recordedAt: ctx.clock.now().toISOString() },
    key(),
  );
  expect(res.status).toBe(200);
  return { ...s, partnerId: (await partnerRow(phone)).id };
}

/** A COD order accepted with a short prep time, so dispatch starts immediately; returns its delivery. */
async function acceptedOrder(paymentMethod: 'COD' | 'ONLINE' = 'COD') {
  const c = await placeOrder(ctx, {
    branchId: saffron,
    items: [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 1 }],
    paymentMethod,
  });
  const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
  expect(
    (await manager.browser.post(`/merchant/orders/${c.orderId}/accept`, { prepMinutes: 12 }, key()))
      .status,
  ).toBe(200);
  await ctx.container.outboxRelay.runOnce();
  const delivery = await ctx.prisma.delivery.findUniqueOrThrow({ where: { orderId: c.orderId } });
  expect(delivery).toMatchObject({
    status: 'PENDING',
    pickupCode: expect.stringMatching(/^\d{4}$/),
  });
  return { ...c, delivery };
}

const offersFor = (deliveryId: string) =>
  ctx.prisma.deliveryAssignment.findMany({ where: { deliveryId }, orderBy: { offeredAt: 'asc' } });

suite('dispatch (FR-DISP-001…009, DELIVERY-ASSIGNMENT-ALGORITHM)', () => {
  it('offers to the best-placed partner first and assigns on accept', async () => {
    const near = await online('+919000000401', { lat: 12.9355, lng: 77.6245 }); // ~70 m
    const far = await online('+919000000402', { lat: 12.95, lng: 77.635 }); // ~2 km
    const o = await acceptedOrder();
    expect((ctx.container.jobs as RecordingJobQueue).jobs).toContainEqual(
      expect.objectContaining({ name: 'dispatch-start', delayMs: 0 }),
    );
    await ctx.container.dispatch.start(o.delivery.id);

    const [first] = await offersFor(o.delivery.id);
    expect(first).toMatchObject({
      partnerId: near.partnerId,
      status: 'OFFERED',
      round: 1,
      rank: 1,
    });
    expect(first!.scoreBreakdown).toMatchObject({
      eta: expect.any(Number),
      distanceM: expect.any(Number),
    });
    const card = (await near.browser.get('/partner/offers/current')).body.data;
    expect(card).toMatchObject({
      offerId: first!.id,
      payment: { type: 'COD', collect: o.payable },
      restaurant: { name: 'Saffron Handi Biryani' },
    });
    expect((await far.browser.get('/partner/offers/current')).body.data).toBeNull();

    const accepted = await near.browser.post(`/partner/offers/${first!.id}/accept`, {}, key());
    expect(accepted.body.data).toMatchObject({ status: 'ASSIGNED' });
    expect(
      await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.delivery.id } }),
    ).toMatchObject({ partnerId: near.partnerId, status: 'ASSIGNED' });
    expect((await ctx.container.presence.get(near.partnerId))?.state).toBe('ON_DELIVERY');
    expect((await near.browser.get('/partner/me/availability')).body.data.activeDeliveryId).toBe(
      o.delivery.id,
    );
  });

  it('moves on after a rejection or an expiry and never re-offers to them (AC-DEL-004)', async () => {
    const a = await online('+919000000401', { lat: 12.9355, lng: 77.6245 });
    const b = await online('+919000000402', { lat: 12.938, lng: 77.627 });
    const c = await online('+919000000404', { lat: 12.945, lng: 77.63 });
    const o = await acceptedOrder();
    await ctx.container.dispatch.start(o.delivery.id);
    const [first] = await offersFor(o.delivery.id);
    expect(first!.partnerId).toBe(a.partnerId);
    await a.browser.post(`/partner/offers/${first!.id}/reject`, { reason: 'TOO_FAR' }, key());
    const second = (await offersFor(o.delivery.id))[1]!;
    expect(second).toMatchObject({ partnerId: b.partnerId, status: 'OFFERED' });
    expect((await ctx.container.presence.get(a.partnerId))?.state).toBe('ONLINE_IDLE');

    await ctx.container.dispatch.expire(second.id);
    const third = (await offersFor(o.delivery.id))[2]!;
    expect(third.partnerId).toBe(c.partnerId);
    expect(
      (await ctx.prisma.partnerStats.findUniqueOrThrow({ where: { partnerId: b.partnerId } }))
        .consecutiveMissedOffers,
    ).toBe(1);
    expect((await offersFor(o.delivery.id)).map((x) => x.partnerId)).toEqual([
      a.partnerId,
      b.partnerId,
      c.partnerId,
    ]);
  });

  it('lets exactly one of two simultaneous accepts win (AC-DEL-003)', async () => {
    const a = await online('+919000000401', { lat: 12.9355, lng: 77.6245 });
    const b = await online('+919000000402', { lat: 12.938, lng: 77.627 });
    const o = await acceptedOrder();
    await ctx.container.dispatch.start(o.delivery.id);
    const [offerA] = await offersFor(o.delivery.id);
    // Force a second live offer (escalation can do this in CORE).
    const offerB = await ctx.prisma.deliveryAssignment.create({
      data: {
        deliveryId: o.delivery.id,
        partnerId: b.partnerId,
        round: 1,
        rank: 2,
        score: 1,
        scoreBreakdown: {},
        distanceToPickupM: 500,
        offeredAt: ctx.clock.now(),
        expiresAt: new Date(ctx.clock.now().getTime() + 30_000),
      },
    });
    const [ra, rb] = await Promise.all([
      a.browser.post(`/partner/offers/${offerA!.id}/accept`, {}, key()),
      b.browser.post(`/partner/offers/${offerB.id}/accept`, {}, key()),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(
      await ctx.prisma.deliveryAssignment.count({
        where: { deliveryId: o.delivery.id, status: 'ACCEPTED' },
      }),
    ).toBe(1);
  });

  it('skips partners over the cash cap for COD and bicycles on long trips', async () => {
    const rich = await online('+919000000401', { lat: 12.9355, lng: 77.6245 });
    const ebike = await online('+919000000403', { lat: 12.9352, lng: 77.6243 });
    const ref = uuidv7();
    await ctx.prisma.$transaction((tx) =>
      ctx.container.ledger.post(tx, {
        type: 'COD_COLLECTION',
        referenceType: 'test',
        referenceId: ref,
        description: 'cash',
        entries: [
          {
            ownerType: 'PARTNER',
            ownerId: rich.partnerId,
            type: 'PARTNER_CASH_IN_HAND',
            amount: 290_000,
          },
          { ownerType: 'PLATFORM', ownerId: null, type: 'CASH_CLEARING', amount: -290_000 },
        ],
      }),
    );
    try {
      const o = await acceptedOrder('COD');
      const ranked = await ctx.container.dispatch.candidates(o.delivery, 1);
      // The rich partner would exceed ₹3,000 with this order; the e-bike is fine for a short drop.
      expect(ranked.map((r) => r.partnerId)).toEqual([ebike.partnerId]);
      expect(
        (await ctx.container.dispatch.candidates(o.delivery, 3)).map((r) => r.partnerId),
      ).toEqual([]); // no bicycles in round 3
    } finally {
      await ctx.prisma.$transaction((tx) =>
        ctx.container.ledger.post(tx, {
          type: 'CASH_DEPOSIT',
          referenceType: 'test',
          referenceId: ref,
          description: 'undo',
          entries: [
            {
              ownerType: 'PARTNER',
              ownerId: rich.partnerId,
              type: 'PARTNER_CASH_IN_HAND',
              amount: -290_000,
            },
            { ownerType: 'PLATFORM', ownerId: null, type: 'CASH_CLEARING', amount: 290_000 },
          ],
        }),
      );
    }
  });

  it('escalates when nobody is around and cancels the order at the deadline (AC-DEL-005)', async () => {
    const o = await acceptedOrder('COD');
    await ctx.container.dispatch.start(o.delivery.id);
    const d = await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.delivery.id } });
    expect(d).toMatchObject({ status: 'SEARCHING', escalated: true, searchRound: 3 });
    expect(
      await ctx.prisma.opsAlert.count({ where: { type: 'DISPATCH_ESCALATED', refId: d.id } }),
    ).toBe(1);
    expect((ctx.container.jobs as RecordingJobQueue).jobs.map((j) => j.name)).toContain(
      'dispatch-retry',
    );

    ctx.clock.set(new Date(d.noPartnerDeadline!.getTime() + 1_000));
    await ctx.container.dispatch.retry(d.id);
    expect(await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({
      status: 'CANCELLED',
    });
    expect(
      await ctx.prisma.orderCancellation.findUnique({ where: { orderId: o.orderId } }),
    ).toMatchObject({ reasonCode: 'NO_PARTNER', fault: 'PLATFORM' });
    await ctx.container.outboxRelay.runOnce();
    expect((await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
      'CANCELLED',
    );
  });

  it('withdraws the offer when the order is cancelled or the partner goes offline', async () => {
    const a = await online('+919000000401', { lat: 12.9355, lng: 77.6245 });
    const b = await online('+919000000402', { lat: 12.938, lng: 77.627 });
    const o = await acceptedOrder();
    await ctx.container.dispatch.start(o.delivery.id);
    expect((await offersFor(o.delivery.id))[0]!.partnerId).toBe(a.partnerId);
    await a.browser.post('/partner/me/offline', {}, key());
    const after = await offersFor(o.delivery.id);
    expect(after.map((x) => [x.partnerId, x.status])).toEqual([
      [a.partnerId, 'WITHDRAWN'],
      [b.partnerId, 'OFFERED'],
    ]);

    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    await manager.browser.post(
      `/merchant/orders/${o.orderId}/cancel`,
      { reason: 'KITCHEN_ISSUE', note: 'Gas ran out', confirm: true },
      key(),
    );
    await ctx.container.outboxRelay.runOnce();
    expect((await offersFor(o.delivery.id)).find((x) => x.partnerId === b.partnerId)!.status).toBe(
      'WITHDRAWN',
    );
    expect(
      (await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.delivery.id } })).status,
    ).toBe('CANCELLED');
    expect((await ctx.container.presence.get(b.partnerId))?.state).toBe('ONLINE_IDLE');
  });
});
