import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { CartExpiry } from '../src/modules/checkout';
import {
  branchId,
  browser,
  createTestContext,
  integrationEnabled,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
let ember: string;
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
  ember = (
    await ctx.prisma.branch.findFirstOrThrow({
      where: { restaurant: { brandName: 'Ember & Crust Pizzeria' } },
    })
  ).id;
  const restaurantId = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
    .restaurantId;
  const items = await ctx.prisma.foodItem.findMany({
    where: { restaurantId },
    include: { variants: true },
  });
  for (const i of items) {
    ids[i.name] = i.id;
    for (const v of i.variants) ids[`${i.name}/${v.name}`] = v.id;
  }
  const options = await ctx.prisma.customizationOption.findMany({
    where: { group: { restaurantId } },
  });
  for (const o of options) ids[o.name] = o.id;
  ids.pizza = (
    await ctx.prisma.foodItem.findFirstOrThrow({
      where: {
        restaurant: { brandName: 'Ember & Crust Pizzeria' },
        variants: { none: {} },
        customizationGroups: { none: {} },
      },
    })
  ).id;
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  ctx.clock.set(todayAt('13:00'));
});

const chicken = (over: Record<string, unknown> = {}) => ({
  branchId: saffron,
  foodItemId: ids['Chicken Dum Biryani'],
  variantId: ids['Chicken Dum Biryani/Regular'],
  optionIds: [ids.Medium, ids['Extra raita']],
  quantity: 2,
  ...over,
});
const paneer = (over: Record<string, unknown> = {}) => ({
  branchId: saffron,
  foodItemId: ids['Paneer Biryani'],
  optionIds: [ids.Mild],
  quantity: 1,
  ...over,
});

suite('cart lines (API-CART-002…006, FR-CART-001…006, BR-CART-001…004)', () => {
  it('adds a configured dish and prices it on the server', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const res = await b.post('/cart/items', chicken());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      branch: { id: saffron, restaurantName: 'Saffron Handi Biryani' },
      itemCount: 2,
      lines: [
        {
          name: 'Chicken Dum Biryani',
          variant: { name: 'Regular' },
          options: expect.arrayContaining([
            expect.objectContaining({ name: 'Extra raita', groupName: 'Add-ons' }),
          ]),
          unitAmount: 35_900, // 329 + 30 raita
          lineAmount: 71_800,
          status: 'OK',
        },
      ],
      preview: { itemsSubtotal: 71_800 },
    });
    // Client prices are refused (FR-PRICE-002).
    expect((await b.post('/cart/items', chicken({ priceAmount: 1 }))).status).toBe(400);
  });

  // Overrides are functions: item IDs are only known after beforeAll.
  it.each([
    ['missing variant', () => ({ variantId: undefined }), 'VARIANT_REQUIRED'],
    ['missing required spice level', () => ({ optionIds: [] }), 'CUSTOMIZATION_INVALID'],
    ['two spice levels', () => ({ optionIds: [ids.Mild, ids.Hot] }), 'CUSTOMIZATION_INVALID'],
  ])('rejects %s', async (_name, over, code) => {
    const { browser: b } = await signUpCustomer(ctx);
    const res = await b.post('/cart/items', chicken(over()));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(code);
  });

  it('explains which group is wrong, and rejects dishes from another restaurant', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const res = await b.post('/cart/items', chicken({ optionIds: [] }));
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ code: 'MIN_SELECT', message: 'Choose Spice level' }),
    ]);
    const other = await b.post(
      '/cart/items',
      chicken({ foodItemId: ids.pizza, variantId: undefined, optionIds: [] }),
    );
    expect(other.body.error.code).toBe('ITEM_NOT_IN_BRANCH');
  });

  it('merges identical lines and keeps different instructions separate (BR-CART-004)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    await b.post('/cart/items', chicken());
    await b.post('/cart/items', chicken({ optionIds: [ids['Extra raita'], ids.Medium] })); // same set, other order
    const separate = await b.post('/cart/items', chicken({ instructions: 'Less <b>oil</b>' }));
    const lines = separate.body.data.lines as { quantity: number; instructions: string | null }[];
    expect(lines.map((l) => [l.quantity, l.instructions])).toEqual([
      [4, null],
      [2, 'Less oil'], // HTML stripped (BR-CART-006)
    ]);
    const tooMany = await b.post('/cart/items', chicken({ quantity: 17 }));
    expect(tooMany.body.error.code).toBe('CART_LIMIT_EXCEEDED');
  });

  it('refuses another restaurant unless the customer replaces the cart (BR-CART-001)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    await b.post('/cart/items', chicken());
    const pizza = { branchId: ember, foodItemId: ids.pizza, optionIds: [], quantity: 1 };
    const conflict = await b.post('/cart/items', pizza);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CART_BRANCH_CONFLICT');
    expect(conflict.body.message).toContain('Saffron Handi Biryani');
    const replaced = await b.post('/cart/items', { ...pizza, replaceCart: true });
    expect(replaced.body.data.branch.id).toBe(ember);
    expect(replaced.body.data.lines).toHaveLength(1);
  });

  it('updates quantity with optimistic versions; removing the last line empties the cart', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const added = (await b.post('/cart/items', paneer())).body.data;
    const line = added.lines[0].id;
    expect(
      (await b.patch(`/cart/items/${line}`, { quantity: 3, version: added.version + 5 })).body.error
        .code,
    ).toBe('CONFLICT_STALE_VERSION');
    expect(
      (await b.patch(`/cart/items/${line}`, { quantity: 3, version: added.version })).body.data
        .itemCount,
    ).toBe(3);
    const empty = (await b.patch(`/cart/items/${line}`, { quantity: 0 })).body.data;
    expect(empty).toMatchObject({
      branch: null,
      lines: [],
      blocking: [expect.objectContaining({ code: 'CART_EMPTY' })],
    });
  });

  it('replaces a line’s customisation and merges into an identical line (FR-CART-004)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    await b.post('/cart/items', paneer({ optionIds: [ids.Mild] }));
    const hot = (await b.post('/cart/items', paneer({ optionIds: [ids.Hot] }))).body.data;
    const hotLine = hot.lines.find(
      (l: { options: { name: string }[] }) => l.options[0]!.name === 'Hot',
    ).id;
    const merged = await b.put(`/cart/items/${hotLine}`, { optionIds: [ids.Mild] });
    expect(merged.body.data.lines).toEqual([
      expect.objectContaining({
        quantity: 2,
        options: [expect.objectContaining({ name: 'Mild' })],
      }),
    ]);
    expect((await b.delete('/cart')).body.data.lines).toEqual([]);
  });
});

suite('revalidation and preview (FR-CART-002, 008, 010, BR-CART-005, FR-PRICE-003)', () => {
  it('flags price changes and unavailable dishes instead of hiding them', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    await b.post('/cart/items', paneer());
    await b.post('/cart/items', chicken({ quantity: 1 }));
    const original = await ctx.prisma.foodItem.findUniqueOrThrow({
      where: { id: ids['Paneer Biryani'] },
    });
    await ctx.prisma.foodItem.update({
      where: { id: original.id },
      data: { basePriceAmount: 29_900 },
    });
    await ctx.prisma.branchItemAvailability.create({
      data: { branchId: saffron, foodItemId: ids['Chicken Dum Biryani']!, isAvailable: false },
    });
    await ctx.prisma.branch.update({
      where: { id: saffron },
      data: { menuVersion: { increment: 1 } },
    });
    try {
      const view = (await b.get('/cart')).body.data;
      expect(view.lines.map((l: { name: string; status: string }) => [l.name, l.status])).toEqual([
        ['Paneer Biryani', 'PRICE_CHANGED'],
        ['Chicken Dum Biryani', 'ITEM_UNAVAILABLE'],
      ]);
      expect(view.lines[0]).toMatchObject({ previousUnitAmount: 27_900, unitAmount: 29_900 });
      expect(view.blocking.map((i: { code: string }) => i.code)).toContain('ITEM_UNAVAILABLE');
      expect(view.warnings.map((i: { code: string }) => i.code)).toContain('PRICE_CHANGED');
      const validate = (await b.post('/cart/validate')).body.data;
      expect(validate.valid).toBe(false);
    } finally {
      await ctx.prisma.foodItem.update({
        where: { id: original.id },
        data: { basePriceAmount: original.basePriceAmount },
      });
      await ctx.prisma.branchItemAvailability.deleteMany({ where: { branchId: saffron } });
      await ctx.prisma.branch.update({
        where: { id: saffron },
        data: { menuVersion: { increment: 1 } },
      });
    }
  });

  it('prices delivery, tip and taxes for a location, and blocks below the minimum', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    await b.post('/cart/items', chicken({ quantity: 1 }));
    const preview = (await b.get('/cart/price-preview', { ...HOME, tip: 2000 })).body.data;
    expect(preview.preview).toMatchObject({
      deliveryFeeKnown: true,
      deliveryFee: 1_900,
      tip: 2_000,
      platformFee: 500,
    });
    expect(preview.preview.taxes.length).toBeGreaterThan(0);
    expect(preview.delivery).toMatchObject({ serviceable: true });
    expect((await b.get('/cart/price-preview', { ...HOME, tip: 2050 })).status).toBe(400); // whole rupees
    const far = (await b.get('/cart/price-preview', { lat: 12.9719, lng: 77.6412 })).body.data;
    expect(far.blocking.map((i: { code: string }) => i.code)).toContain('ADDRESS_NOT_SERVICEABLE');

    await ctx.prisma.branch.update({ where: { id: saffron }, data: { minOrderAmount: 50_000 } });
    try {
      const view = (await b.get('/cart')).body.data;
      expect(view.blocking).toEqual([
        expect.objectContaining({
          code: 'ORDER_BELOW_MINIMUM',
          message: expect.stringContaining('₹500'),
        }),
      ]);
    } finally {
      await ctx.prisma.branch.update({ where: { id: saffron }, data: { minOrderAmount: 0 } });
    }
  });

  it('prices for a saved address and blocks while the restaurant is closed', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const address = (
      await b.post('/me/addresses', {
        label: 'HOME',
        line1: '1',
        area: 'Koramangala',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560095',
        location: HOME,
      })
    ).body.data;
    await b.post('/cart/items', paneer());
    expect((await b.get('/cart', { addressId: address.id })).body.data.delivery).toMatchObject({
      serviceable: true,
    });
    ctx.clock.set(todayAt('09:00'));
    const closed = (await b.get('/cart')).body.data;
    expect(closed.blocking.map((i: { code: string }) => i.code)).toContain(
      'BRANCH_NOT_ACCEPTING_ORDERS',
    );
  });

  it('stores cart instructions and the no-cutlery choice (FR-CART-007)', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const res = await b.patch('/cart', { instructions: '<i>Ring</i> twice', noCutlery: true });
    expect(res.body.data).toMatchObject({ instructions: 'Ring twice', noCutlery: true });
  });
});

suite('guest cart merge (API-CART-012, FR-CART-011)', () => {
  it('adopts valid draft lines and reports the rest', async () => {
    const { browser: b } = await signUpCustomer(ctx);
    const res = await b.post('/cart/merge', {
      branchId: saffron,
      lines: [
        { foodItemId: ids['Paneer Biryani'], optionIds: [ids.Hot], quantity: 2 },
        { foodItemId: ids['Chicken Dum Biryani'], optionIds: [ids.Hot], quantity: 1 }, // no variant
      ],
    });
    expect(res.body.data.cart.lines).toHaveLength(1);
    expect(res.body.data.rejected).toEqual([
      expect.objectContaining({ index: 1, code: 'VARIANT_REQUIRED' }),
    ]);
    const conflict = await b.post('/cart/merge', {
      branchId: ember,
      lines: [{ foodItemId: ids.pizza, optionIds: [], quantity: 1 }],
    });
    expect(conflict.body.error.code).toBe('CART_BRANCH_CONFLICT');
  });

  it('is for signed-in customers only', async () => {
    expect((await browser(ctx).get('/cart')).status).toBe(401);
  });
});

suite('cart expiry (JOB-CART-001, BR-CART-002)', () => {
  it('expires carts idle for 7 days and leaves recent ones', async () => {
    const idle = await signUpCustomer(ctx);
    const fresh = await signUpCustomer(ctx);
    await idle.browser.post('/cart/items', paneer());
    await fresh.browser.post('/cart/items', paneer());
    await ctx.prisma.cart.updateMany({
      where: { userId: idle.userId },
      data: { lastActivityAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    expect(
      await new CartExpiry(ctx.prisma, { now: () => new Date() }).run(),
    ).toBeGreaterThanOrEqual(1);
    expect((await idle.browser.get('/cart')).body.data.id).toBeNull();
    expect((await fresh.browser.get('/cart')).body.data.lines).toHaveLength(1);
    // A new cart can start after expiry (one ACTIVE cart per user).
    expect((await idle.browser.post('/cart/items', paneer())).status).toBe(201);
  });
});
