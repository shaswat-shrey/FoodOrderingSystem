import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import {
  branchId,
  createTestContext,
  integrationEnabled,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
const ids: Record<string, string> = {};

function todayAt(hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const t = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(t.year, t.month, t.day, h! * 60 + m!, 'Asia/Kolkata');
}
const HOME = { lat: 12.9352, lng: 77.6245 };
const address = (over: Record<string, unknown> = {}) => ({
  label: 'HOME',
  line1: 'Flat 2',
  area: 'Koramangala',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560095',
  location: HOME,
  ...over,
});

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
  const restaurantId = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
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

/** A customer with a saved home address and one Paneer Biryani (₹279) in the cart. */
async function ready(quantity = 1) {
  const c = await signUpCustomer(ctx);
  const home = (await c.browser.post('/me/addresses', address())).body.data;
  await c.browser.post('/cart/items', {
    branchId: saffron,
    foodItemId: ids['Paneer Biryani'],
    optionIds: [ids.Mild],
    quantity,
  });
  return { ...c, addressId: home.id as string };
}
const credit = (userId: string, amount: number) =>
  ctx.prisma.$transaction((tx) =>
    ctx.container.wallet.credit(tx, {
      userId,
      amount,
      source: 'GOODWILL',
      referenceType: 'test',
      referenceId: uuidv7(),
      description: 'test credit',
    }),
  );

suite('checkout sessions (API-CHK-001…003, FR-CHK-001, 003…007)', () => {
  it('creates a session with a full quote, address snapshot and a 10-minute expiry', async () => {
    const { browser: b, addressId } = await ready();
    const res = await b.post('/checkout/sessions', {
      addressId,
      paymentMethod: 'ONLINE',
      tipAmount: 2000,
    });
    expect(res.status).toBe(201);
    const s = res.body.data;
    expect(s).toMatchObject({
      status: 'OPEN',
      branchId: saffron,
      paymentMethod: 'ONLINE',
      address: { id: addressId, area: 'Koramangala' },
      contact: { name: 'Test User' },
      quote: { itemsSubtotal: 27_900, tip: 2_000, deliveryFee: 1_900 },
      delivery: { eta: { minMinutes: expect.any(Number) } },
    });
    expect(s.payableAmount).toBe(s.quote.payable);
    expect(new Date(s.expiresAt).getTime() - ctx.clock.now().getTime()).toBe(600_000);
    const row = await ctx.prisma.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.cartHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (row.quote as { configVersions: { taxRuleIds: string[] } }).configVersions.taxRuleIds.length,
    ).toBeGreaterThan(0);
  });

  it('re-quotes on change, supersedes older sessions, and expires', async () => {
    const { browser: b, addressId } = await ready();
    const first = (await b.post('/checkout/sessions', { addressId, paymentMethod: 'ONLINE' })).body
      .data;
    const changed = (
      await b.patch(`/checkout/sessions/${first.id}`, { tipAmount: 3000, version: first.version })
    ).body.data;
    expect(changed.quote.tip).toBe(3_000);
    expect(changed.quote.payable).toBe(first.quote.payable + 3_000);
    expect(
      (await b.patch(`/checkout/sessions/${first.id}`, { tipAmount: 1000, version: first.version }))
        .body.error.code,
    ).toBe('CONFLICT_STALE_VERSION');

    const second = (await b.post('/checkout/sessions', { addressId, paymentMethod: 'ONLINE' })).body
      .data;
    expect((await b.get(`/checkout/sessions/${first.id}`)).body.data.status).toBe('EXPIRED');
    ctx.clock.advance(601_000);
    expect((await b.get(`/checkout/sessions/${second.id}`)).body.data.status).toBe('EXPIRED');
    expect((await b.patch(`/checkout/sessions/${second.id}`, { tipAmount: 1000 })).status).toBe(
      410,
    );
  });

  it('refuses addresses the restaurant does not deliver to, and closed restaurants', async () => {
    const { browser: b } = await ready();
    const work = (
      await b.post(
        '/me/addresses',
        address({ label: 'WORK', location: { lat: 12.9719, lng: 77.6412 } }),
      )
    ).body.data;
    const far = await b.post('/checkout/sessions', { addressId: work.id, paymentMethod: 'ONLINE' });
    expect(far.body.error.code).toBe('ADDRESS_NOT_SERVICEABLE');
    ctx.clock.set(todayAt('09:00'));
    const home = (await b.get('/me/addresses')).body.data.find(
      (a: { label: string }) => a.label === 'HOME',
    );
    expect(
      (await b.post('/checkout/sessions', { addressId: home.id, paymentMethod: 'ONLINE' })).body
        .error.code,
    ).toBe('BRANCH_NOT_ACCEPTING_ORDERS');
  });

  it('applies wallet credit (split payment) and covers the whole order with WALLET', async () => {
    const { browser: b, addressId, userId } = await ready();
    await credit(userId, 10_000);
    const split = (
      await b.post('/checkout/sessions', { addressId, paymentMethod: 'ONLINE', useWallet: true })
    ).body.data;
    expect(split.quote.walletApplied).toBe(10_000);
    expect(split.payableAmount).toBe(split.quote.total - 10_000);
    const short = await b.post('/checkout/sessions', { addressId, paymentMethod: 'WALLET' });
    expect(short.body.error.code).toBe('INSUFFICIENT_WALLET_BALANCE');
    await credit(userId, 50_000);
    const full = (await b.post('/checkout/sessions', { addressId, paymentMethod: 'WALLET' })).body
      .data;
    expect(full).toMatchObject({ payableAmount: 0, useWallet: true });
  });

  it('enforces COD rules (BR-PAY-002, BR-PAY-007, BR-DEL-009)', async () => {
    const { browser: b, addressId, userId } = await ready();
    expect(
      (await b.post('/checkout/sessions', { addressId, paymentMethod: 'COD', useWallet: true }))
        .body.error.code,
    ).toBe('COD_NOT_AVAILABLE');
    expect(
      (await b.post('/checkout/sessions', { addressId, paymentMethod: 'COD', contactless: true }))
        .status,
    ).toBe(400);
    expect((await b.post('/checkout/sessions', { addressId, paymentMethod: 'COD' })).status).toBe(
      201,
    );
    await ctx.prisma.customerProfile.upsert({
      where: { userId },
      create: { userId, codBlocked: true },
      update: { codBlocked: true },
    });
    const blocked = await b.post('/checkout/sessions', { addressId, paymentMethod: 'COD' });
    expect(blocked.body.error.code).toBe('COD_NOT_AVAILABLE');
    expect(blocked.body.message).toMatch(/refused deliveries/);
  });

  it('turns cart problems into one clear error with details', async () => {
    const { browser: b, addressId } = await ready();
    await ctx.prisma.branch.update({ where: { id: saffron }, data: { minOrderAmount: 50_000 } });
    try {
      const res = await b.post('/checkout/sessions', { addressId, paymentMethod: 'ONLINE' });
      expect(res.body.error.code).toBe('ORDER_BELOW_MINIMUM');
      expect(res.body.error.details[0].code).toBe('ORDER_BELOW_MINIMUM');
    } finally {
      await ctx.prisma.branch.update({ where: { id: saffron }, data: { minOrderAmount: 0 } });
    }
    await b.delete('/cart');
    expect(
      (await b.post('/checkout/sessions', { addressId, paymentMethod: 'ONLINE' })).body.error.code,
    ).toBe('CART_EMPTY');
  });

  it('rejects client-sent prices (FR-PRICE-002) and other users’ sessions', async () => {
    const { browser: b, addressId } = await ready();
    expect(
      (await b.post('/checkout/sessions', { addressId, paymentMethod: 'ONLINE', total: 1 })).status,
    ).toBe(400);
    const mine = (await b.post('/checkout/sessions', { addressId, paymentMethod: 'ONLINE' })).body
      .data;
    const stranger = await signUpCustomer(ctx);
    expect((await stranger.browser.get(`/checkout/sessions/${mine.id}`)).status).toBe(404);
  });
});

suite('payment methods (API-PAY-001, FR-CHK-007)', () => {
  it('lists online, cash (with its cap) and wallet availability', async () => {
    const { browser: b, userId } = await ready();
    await credit(userId, 5_000);
    const small = (await b.get('/payments/methods', { branchId: saffron, amount: 4_000 })).body
      .data;
    expect(small).toEqual([
      expect.objectContaining({ method: 'ONLINE', available: true }),
      expect.objectContaining({ method: 'COD', available: true }),
      expect.objectContaining({ method: 'WALLET', available: true, balance: 5_000 }),
    ]);
    const big = (await b.get('/payments/methods', { branchId: saffron, amount: 200_000 })).body
      .data;
    expect(big[1]).toMatchObject({
      method: 'COD',
      available: false,
      reason: 'Cash on delivery is available up to ₹1500.',
    });
    expect(big[2]).toMatchObject({ method: 'WALLET', available: false });
  });
});
