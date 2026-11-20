import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { deliveryCode } from '../src/modules/orders';
import {
  branchId,
  createTestContext,
  integrationEnabled,
  parkActiveDeliveries,
  placeOrder,
  SAFFRON_STAFF,
  signInAs,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
const ids: Record<string, string> = {};
const RIDER = '+919000000403';

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
});

const key = () => ({ 'Idempotency-Key': uuidv7() });

/** An order accepted by Saffron and taken by RIDER; `deliver()` finishes the trip. */
async function onTheWay() {
  const r = await signInAs(ctx, RIDER, 'DELIVERY');
  await r.browser.post(
    '/partner/me/online',
    { lat: 12.9355, lng: 77.6245, accuracyM: 10, recordedAt: ctx.clock.now().toISOString() },
    key(),
  );
  const c = await placeOrder(ctx, {
    branchId: saffron,
    items: [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 1 }],
    paymentMethod: 'COD',
  });
  const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
  await manager.browser.post(`/merchant/orders/${c.orderId}/accept`, { prepMinutes: 12 }, key());
  await ctx.container.outboxRelay.runOnce();
  const d = await ctx.prisma.delivery.findUniqueOrThrow({ where: { orderId: c.orderId } });
  const before = (await c.browser.get(`/orders/${c.orderId}/tracking`)).body.data;
  await ctx.container.dispatch.start(d.id);
  const offer = (await r.browser.get('/partner/offers/current')).body.data;
  await r.browser.post(`/partner/offers/${offer.offerId}/accept`, {}, key());
  const deliver = async () => {
    await manager.browser.post(`/merchant/orders/${c.orderId}/ready`, {}, key());
    const rr = await signInAs(ctx, RIDER, 'DELIVERY');
    await rr.browser.post(`/partner/deliveries/${d.id}/picked-up`, {}, key());
    const otp = deliveryCode(ctx.container.env.AUTH_HMAC_SECRET, c.orderId);
    const done = await rr.browser.post(
      `/partner/deliveries/${d.id}/complete`,
      { method: 'OTP', otp, cashCollected: true },
      key(),
    );
    expect(done.status).toBe(200);
  };
  return { ...c, deliveryId: d.id, before, rider: r, manager, deliver };
}

suite('order tracking (API-TRK-001/002, FR-CORD-004…006, BR-DEL-012)', () => {
  it('shares the partner and their location only between assignment and delivery', async () => {
    const o = await onTheWay();
    expect(o.before).toMatchObject({
      status: 'ACCEPTED',
      partner: null,
      location: null,
      deliveryCode: null,
      live: false,
      restaurant: { lat: expect.any(Number), lng: expect.any(Number) },
      destination: { lat: expect.any(Number) },
    });

    const live = (await o.browser.get(`/orders/${o.orderId}/tracking`)).body.data;
    expect(live).toMatchObject({
      live: true,
      delivery: { status: 'ASSIGNED' },
      partner: { firstName: expect.any(String), vehicleType: 'E_BIKE' },
      location: { lat: 12.9355, lng: 77.6245, stale: false },
      deliveryCode: deliveryCode(ctx.container.env.AUTH_HMAC_SECRET, o.orderId),
    });
    expect(JSON.stringify(live.partner)).not.toMatch(/\+91|phone/i);

    ctx.clock.advance(90_000);
    const poll = (await o.browser.get(`/orders/${o.orderId}/tracking/location`)).body.data;
    expect(poll).toMatchObject({ status: 'ASSIGNED', location: { stale: true, ageSeconds: 90 } });

    const stranger = await signUpCustomer(ctx);
    expect((await stranger.browser.get(`/orders/${o.orderId}/tracking`)).status).toBe(404);

    await o.deliver();
    const done = (await o.browser.get(`/orders/${o.orderId}/tracking`)).body.data;
    expect(done).toMatchObject({
      status: 'DELIVERED',
      live: false,
      location: null,
      partner: null,
      deliveryCode: null,
    });
  });
});

suite('reviews (API-REV-001…005, API-RREV-001…004, BR-REVIEW-001…006)', () => {
  it('rates a delivered order once, cleans the text and updates the averages', async () => {
    const o = await onTheWay();
    const early = await o.browser.post(
      `/orders/${o.orderId}/reviews`,
      { restaurant: { rating: 5 } },
      key(),
    );
    expect(early.body.error.code).toBe('REVIEW_NOT_ALLOWED');
    await o.deliver();

    const branchBefore = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
    const res = await o.browser.post(
      `/orders/${o.orderId}/reviews`,
      {
        restaurant: {
          rating: 4,
          text: 'Great biryani, call me on 9876543210',
          tags: ['TASTE', 'VALUE'],
        },
        partner: { rating: 5, tags: ['POLITE', 'ON_TIME'], text: 'Quick!' },
      },
      key(),
    );
    expect(res.status).toBe(201);
    const [restaurant, partner] = res.body.data;
    expect(restaurant).toMatchObject({
      target: 'RESTAURANT',
      text: 'Great biryani, call me on [removed]',
      tags: ['TASTE', 'VALUE'],
      editable: true,
    });
    expect(partner).toMatchObject({ target: 'PARTNER', rating: 5 });
    const again = await o.browser.post(
      `/orders/${o.orderId}/reviews`,
      { partner: { rating: 1 } },
      key(),
    );
    expect(again.body.error.code).toBe('REVIEW_ALREADY_SUBMITTED');

    await ctx.container.outboxRelay.runOnce();
    const branchAfter = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
    expect(branchAfter.ratingCount).toBe(branchBefore.ratingCount + 1);
    const rider = await signInAs(ctx, RIDER, 'DELIVERY');
    const ratings = (await rider.browser.get('/partner/me/ratings')).body.data;
    expect(ratings).toMatchObject({
      average: 5,
      count: 1,
      tags: { POLITE: 1, ON_TIME: 1 },
      comments: [],
    });
    expect(JSON.stringify(ratings)).not.toContain(o.orderId);

    // Edit inside 48 h, not after; delete any time.
    const edited = await o.browser.patch(
      `/reviews/${restaurant.id}`,
      { rating: 3, tags: ['PORTION'] },
      key(),
    );
    expect(edited.body.data).toMatchObject({ rating: 3, tags: ['PORTION'] });
    expect((await o.browser.get('/me/reviews')).body.data[0]).toMatchObject({
      orderNumber: expect.any(String),
    });
    ctx.clock.advance(49 * 3_600_000);
    const late = await signInAs(ctx, o.phone, 'CUSTOMER');
    expect(
      (await late.browser.patch(`/reviews/${restaurant.id}`, { rating: 5 }, key())).body.error.code,
    ).toBe('REVIEW_EDIT_WINDOW_CLOSED');
    expect((await late.browser.delete(`/reviews/${partner.id}`, key())).status).toBe(200);
    await ctx.container.outboxRelay.runOnce();
    expect(
      (
        await ctx.prisma.partnerStats.findFirstOrThrow({
          where: { partner: { user: { phone: RIDER } } },
        })
      ).ratingCount,
    ).toBe(0);
  });

  it('lets the restaurant read and answer once, and hides a review after three reports', async () => {
    const o = await onTheWay();
    await o.deliver();
    const created = await o.browser.post(
      `/orders/${o.orderId}/reviews`,
      { restaurant: { rating: 1, text: 'Cold' } },
      key(),
    );
    const reviewId = created.body.data[0].id as string;
    await ctx.container.outboxRelay.runOnce();
    const countBefore = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
      .ratingCount;

    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    const list = await manager.browser.get(
      `/merchant/branches/${saffron}/reviews?rating=1&responded=false`,
    );
    expect(list.body.data.find((r: { id: string }) => r.id === reviewId)).toMatchObject({
      text: 'Cold',
      author: expect.any(String),
      response: null,
    });
    const kitchen = await signInAs(ctx, SAFFRON_STAFF.kitchen);
    expect(
      (
        await kitchen.browser.post(
          `/merchant/reviews/${reviewId}/response`,
          { text: 'Sorry' },
          key(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await manager.browser.post(
          `/merchant/reviews/${reviewId}/response`,
          { text: 'Sorry, we will fix it' },
          key(),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await manager.browser.post(
          `/merchant/reviews/${reviewId}/response`,
          { text: 'Again' },
          key(),
        )
      ).body.error.code,
    ).toBe('REVIEW_ALREADY_SUBMITTED');
    expect(
      (
        await manager.browser.patch(
          `/merchant/reviews/${reviewId}/response`,
          { text: 'Sorry — refund sent' },
          key(),
        )
      ).body.data,
    ).toMatchObject({ text: 'Sorry — refund sent' });

    // Any signed-in user may report, from any app; a reporter counts once.
    const rider = await signInAs(ctx, RIDER, 'DELIVERY');
    for (const b of [rider.browser, rider.browser, kitchen.browser])
      await b.post(`/reviews/${reviewId}/reports`, { reason: 'FAKE' }, key());
    expect(await ctx.prisma.reviewReport.count({ where: { reviewId } })).toBe(2);
    expect((await ctx.prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
      'PUBLISHED',
    );
    const third = await manager.browser.post(
      `/merchant/reviews/${reviewId}/reports`,
      { reason: 'FAKE' },
      key(),
    );
    expect(third.body.data).toEqual({ reported: true, hidden: true });
    await ctx.container.outboxRelay.runOnce();
    expect(
      (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } })).ratingCount,
    ).toBe(countBefore - 1);
  });

  it('closes reviews seven days after delivery', async () => {
    const o = await onTheWay();
    await o.deliver();
    ctx.clock.advance(8 * 86_400_000);
    const late = await signInAs(ctx, o.phone, 'CUSTOMER');
    expect(
      (
        await late.browser.post(
          `/orders/${o.orderId}/reviews`,
          { restaurant: { rating: 5 } },
          key(),
        )
      ).body.error.code,
    ).toBe('REVIEW_NOT_ALLOWED');
  });
});
