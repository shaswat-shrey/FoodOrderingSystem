import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  branchId,
  browser,
  createFixtureOrder,
  createTestContext,
  integrationEnabled,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
let restaurantId: string;
const ids: Record<string, string> = {};

function todayAt(hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const t = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(t.year, t.month, t.day, h! * 60 + m!, 'Asia/Kolkata');
}
const HOME = { lat: 12.9352, lng: 77.6245 };

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
  restaurantId = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
    .restaurantId;
  for (const i of await ctx.prisma.foodItem.findMany({ where: { restaurantId } }))
    ids[i.name] = i.id;
  for (const o of await ctx.prisma.customizationOption.findMany({
    where: { group: { restaurantId } },
  }))
    ids[o.name] = o.id;
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  ctx.clock.set(todayAt('13:00'));
});

/** Paneer Biryani is ₹279. */
async function customerWithPaneer(quantity = 1) {
  const c = await signUpCustomer(ctx);
  await c.browser.post('/cart/items', {
    branchId: saffron,
    foodItemId: ids['Paneer Biryani'],
    optionIds: [ids.Mild],
    quantity,
  });
  return c;
}

suite('applying coupons (API-CART-009/010, FR-COUP-002, BR-COUPON-001…004)', () => {
  it('applies a capped percentage coupon for a new customer', async () => {
    const { browser: b } = await customerWithPaneer();
    const res = await b.post('/cart/coupon', { code: 'welcome50' });
    expect(res.status).toBe(200);
    expect(res.body.data.coupon).toEqual({
      code: 'WELCOME50',
      discountAmount: 10_000,
      freeDelivery: false,
    }); // 50 % capped at ₹100
    expect(res.body.data.cart.preview.discounts).toEqual([
      expect.objectContaining({ source: 'COUPON', amount: 10_000, platformFundedAmount: 10_000 }),
    ]);
  });

  it('explains a minimum shortfall and keeps the previous coupon', async () => {
    const { browser: b } = await customerWithPaneer();
    await b.post('/cart/coupon', { code: 'WELCOME50' });
    const res = await b.post('/cart/coupon', { code: 'FLAT100' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COUPON_NOT_APPLICABLE');
    expect(res.body.message).toBe('Add ₹220.00 more to use FLAT100.'); // 499 − 279
    expect((await b.get('/cart')).body.data.coupon.code).toBe('WELCOME50');
  });

  it('waives the base delivery fee with a free-delivery coupon (BR-PRICE-012)', async () => {
    const { browser: b } = await customerWithPaneer();
    await b.post('/cart/coupon', { code: 'FREEDEL' });
    const preview = (await b.get('/cart/price-preview', HOME)).body.data.preview;
    expect(preview).toMatchObject({ deliveryFee: 0, deliveryFeeWaived: 1_900 });
  });

  it('flags a coupon that stops qualifying, and can be removed', async () => {
    const { browser: b } = await customerWithPaneer(2);
    await b.post('/cart/coupon', { code: 'FLAT100' }); // 2 × 279 = 558 ≥ 499
    const line = (await b.get('/cart')).body.data.lines[0].id;
    const after = (await b.patch(`/cart/items/${line}`, { quantity: 1 })).body.data;
    expect(after.blocking).toEqual([expect.objectContaining({ code: 'COUPON_NOT_APPLICABLE' })]);
    const removed = (await b.delete('/cart/coupon')).body.data;
    expect(removed).toMatchObject({ coupon: null, blocking: [] });
  });

  it('rejects unknown and expired codes', async () => {
    const { browser: b } = await customerWithPaneer();
    expect((await b.post('/cart/coupon', { code: 'NOPE' })).body.error.code).toBe('COUPON_INVALID');
    const expired = await ctx.prisma.coupon.create({
      data: {
        code: `OLD${Date.now()}`,
        description: 'old',
        discountType: 'FLAT',
        value: 1000,
        startsAt: new Date(Date.now() - 2 * 86_400_000),
        endsAt: new Date(Date.now() - 86_400_000),
        status: 'ACTIVE',
      },
    });
    expect((await b.post('/cart/coupon', { code: expired.code })).body.error.code).toBe(
      'COUPON_EXPIRED',
    );
  });
});

suite('promotions (BR-COUPON-005)', () => {
  it('applies the best automatic offer and keeps the larger of it and a non-stackable coupon', async () => {
    const promo = await ctx.prisma.promotion.create({
      data: {
        scope: 'RESTAURANT',
        restaurantId,
        title: '₹50 off biryanis',
        type: 'FLAT_OFF',
        value: 5_000,
        // Relative to the test clock (13:00 today), not real time.
        startsAt: new Date(ctx.clock.now().getTime() - 3_600_000),
        endsAt: new Date(ctx.clock.now().getTime() + 86_400_000),
        funding: 'RESTAURANT',
        status: 'ACTIVE',
      },
    });
    try {
      const { browser: b } = await customerWithPaneer();
      expect((await b.get('/cart')).body.data.preview.discounts).toEqual([
        expect.objectContaining({
          source: 'PROMOTION',
          label: '₹50 off biryanis',
          amount: 5_000,
          restaurantFundedAmount: 5_000,
        }),
      ]);
      await b.post('/cart/coupon', { code: 'WELCOME50' }); // ₹100 beats ₹50
      const view = (await b.get('/cart')).body.data;
      expect(view.preview.discounts.map((d: { source: string }) => d.source)).toEqual(['COUPON']);
      expect(view.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'COUPON_NOT_COMBINED' })]),
      );
    } finally {
      await ctx.prisma.promotion.update({
        where: { id: promo.id },
        data: { deletedAt: new Date(), status: 'ENDED' },
      });
    }
  });
});

suite('coupon listing and terms (API-COUP-001…003, FR-COUP-001, 003)', () => {
  it('lists eligible coupons first with reasons for the rest', async () => {
    const { browser: b } = await customerWithPaneer();
    const list = (await b.get('/coupons', { branchId: saffron })).body.data as {
      code: string;
      eligible: boolean;
      reason: string | null;
    }[];
    expect(list.filter((c) => c.eligible).map((c) => c.code)).toEqual(
      expect.arrayContaining(['WELCOME50', 'FREEDEL']),
    );
    expect(list.find((c) => c.code === 'FLAT100')).toMatchObject({
      eligible: false,
      reason: 'Add ₹220 more to use FLAT100.',
    });
    expect(list.findIndex((c) => !c.eligible)).toBeGreaterThan(
      list.findLastIndex((c) => c.eligible),
    );
    const guest = (await browser(ctx).get('/coupons', { branchId: saffron })).body.data;
    expect(guest.length).toBeGreaterThan(0);
  });

  it('shows terms, and validates without applying', async () => {
    const { browser: b } = await customerWithPaneer();
    const terms = (await b.get('/coupons/WELCOME50')).body.data;
    expect(terms).toMatchObject({
      code: 'WELCOME50',
      newUsersOnly: true,
      maxDiscountAmount: 10_000,
      remainingForYou: 1,
      restaurants: null,
    });
    const ok = (await b.post('/coupons/validate', { code: 'WELCOME50' })).body.data;
    expect(ok).toMatchObject({ valid: true, discountAmount: 10_000 });
    expect((await b.get('/cart')).body.data.coupon).toBeNull();
    const no = (await b.post('/coupons/validate', { code: 'FLAT100' })).body.data;
    expect(no).toMatchObject({ valid: false, reasonCode: 'COUPON_NOT_APPLICABLE' });
  });
});

suite('redemption lifecycle (FR-COUP-004, BR-COUPON-003, 006, 007)', () => {
  it('reserves under a lock, counts reserved uses toward limits, and redeems or releases once', async () => {
    const { userId } = await customerWithPaneer();
    const coupon = await ctx.prisma.coupon.findFirstOrThrow({ where: { code: 'WELCOME50' } });
    const before = { used: coupon.usedCount, reserved: coupon.reservedCount };
    const first = await createFixtureOrder(ctx, { userId, branchId: saffron });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.offers.reserve(tx, {
        couponId: coupon.id,
        userId,
        orderId: first.orderId,
        discountAmount: 10_000,
      }),
    );

    // The single per-user use is taken while reserved.
    const second = await createFixtureOrder(ctx, { userId, branchId: saffron });
    await expect(
      ctx.prisma.$transaction((tx) =>
        ctx.container.offers.reserve(tx, {
          couponId: coupon.id,
          userId,
          orderId: second.orderId,
          discountAmount: 10_000,
        }),
      ),
    ).rejects.toMatchObject({ code: 'COUPON_LIMIT_REACHED' });

    expect(await ctx.container.offers.redeem(ctx.prisma, first.orderId)).toBe(true);
    expect(await ctx.container.offers.redeem(ctx.prisma, first.orderId)).toBe(false); // idempotent
    const after = await ctx.prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect({ used: after.usedCount, reserved: after.reservedCount }).toEqual({
      used: before.used + 1,
      reserved: before.reserved,
    });

    // A released reservation frees the use again.
    const other = await signUpCustomer(ctx);
    const o = await createFixtureOrder(ctx, { userId: other.userId, branchId: saffron });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.offers.reserve(tx, {
        couponId: coupon.id,
        userId: other.userId,
        orderId: o.orderId,
        discountAmount: 10_000,
      }),
    );
    expect(await ctx.container.offers.release(ctx.prisma, o.orderId)).toBe(true);
    const o2 = await createFixtureOrder(ctx, { userId: other.userId, branchId: saffron });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.offers.reserve(tx, {
        couponId: coupon.id,
        userId: other.userId,
        orderId: o2.orderId,
        discountAmount: 10_000,
      }),
    );
  });

  it('a delivered order ends new-customer eligibility (BR-COUPON-007)', async () => {
    const { browser: b, userId } = await customerWithPaneer();
    await createFixtureOrder(ctx, {
      userId,
      branchId: saffron,
      status: 'DELIVERED',
      paymentMethod: 'COD',
    });
    const res = await b.post('/cart/coupon', { code: 'WELCOME50' });
    expect(res.body.error.code).toBe('COUPON_NOT_APPLICABLE');
    expect(res.body.message).toMatch(/first order/);
  });

  it('enforces a global limit counting reservations', async () => {
    const limited = await ctx.prisma.coupon.create({
      data: {
        code: `ONE${Date.now()}`,
        description: 'one use',
        discountType: 'FLAT',
        value: 1_000,
        usageLimitTotal: 1,
        startsAt: new Date(ctx.clock.now().getTime() - 3_600_000),
        endsAt: new Date(ctx.clock.now().getTime() + 86_400_000),
        status: 'ACTIVE',
      },
    });
    const a = await signUpCustomer(ctx);
    const order = await createFixtureOrder(ctx, { userId: a.userId, branchId: saffron });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.offers.reserve(tx, {
        couponId: limited.id,
        userId: a.userId,
        orderId: order.orderId,
        discountAmount: 1_000,
      }),
    );
    const { browser: b } = await customerWithPaneer();
    expect((await b.post('/cart/coupon', { code: limited.code })).body.error.code).toBe(
      'COUPON_LIMIT_REACHED',
    );
  });
});
