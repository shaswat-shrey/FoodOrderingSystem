import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import type { RecordingJobQueue } from '../src/platform/jobs';
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
  (ctx.container.jobs as RecordingJobQueue).jobs.length = 0;
});

const key = () => ({ 'Idempotency-Key': uuidv7() });

/** Signed-up customer, home address, Paneer Biryani (+ raita) in the cart, and a checkout session. */
async function checkoutWith(session: Record<string, unknown> = {}, quantity = 1) {
  const c = await signUpCustomer(ctx);
  const home = (
    await c.browser.post('/me/addresses', {
      label: 'HOME',
      line1: 'Flat 9',
      area: 'Koramangala',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560095',
      location: HOME,
    })
  ).body.data;
  await c.browser.post('/cart/items', {
    branchId: saffron,
    foodItemId: ids['Paneer Biryani'],
    optionIds: [ids.Mild, ids['Extra raita']],
    quantity,
  });
  const s = (
    await c.browser.post('/checkout/sessions', {
      addressId: home.id,
      paymentMethod: 'COD',
      ...session,
    })
  ).body.data;
  return { ...c, session: s, addressId: home.id as string };
}
const confirm = (
  b: Awaited<ReturnType<typeof checkoutWith>>['browser'],
  sessionId: string,
  expectedPayable: number,
  headers = key(),
) => b.post(`/checkout/sessions/${sessionId}/confirm`, { expectedPayable }, headers);

suite('placing an order (API-CHK-004, FR-CHK-002, FR-ORDER-001)', () => {
  it('creates a COD order with immutable snapshots, history, events and timers (T02)', async () => {
    const { browser: b, session, userId } = await checkoutWith();
    const res = await confirm(b, session.id, session.payableAmount);
    expect(res.status).toBe(201);
    const { order } = res.body.data;
    expect(order).toMatchObject({
      status: 'PLACED',
      paymentMethod: 'COD',
      payableAmount: session.payableAmount,
    });
    expect(order.number).toMatch(/^\d{6}-[0-9A-HJKMNP-TV-Z]{6}$/); // FR-ORDER-003, ≤ 13 characters

    const full = await ctx.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: { include: { options: true } }, priceComponents: true },
    });
    expect(full).toMatchObject({
      userId,
      branchId: saffron,
      totalAmount: session.quote.total,
      placedAt: expect.any(Date),
      deliveryOtpHash: expect.any(Uint8Array),
    });
    expect(full.items).toEqual([
      expect.objectContaining({
        itemName: 'Paneer Biryani',
        unitPriceAmount: 27_900,
        optionsAmount: 3_000,
        quantity: 1,
        lineTotalAmount: 30_900,
      }),
    ]);
    expect(full.items[0]!.options.map((o) => o.optionName).sort()).toEqual(['Extra raita', 'Mild']);
    const fees = full.priceComponents.filter(
      (p) => !['ITEMS_SUBTOTAL', 'ITEM_DISCOUNT', 'PROMOTION', 'COUPON'].includes(p.type),
    );
    expect(full.itemsSubtotalAmount + fees.reduce((s, p) => s + p.amount, 0) + full.tipAmount).toBe(
      full.totalAmount + full.discountTotalAmount,
    );

    const [address] = await ctx.prisma.$queryRaw<
      { area: string; lat: number }[]
    >`SELECT area, ST_Y(location::geometry) AS lat FROM order_addresses WHERE order_id = ${order.id}::uuid`;
    expect(address).toMatchObject({ area: 'Koramangala', lat: HOME.lat });
    expect(await ctx.prisma.orderStatusHistory.findMany({ where: { orderId: order.id } })).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'PLACED', actorType: 'CUSTOMER' }),
    ]);
    const events = await ctx.prisma.outboxEvent.findMany({
      where: { aggregateId: order.id },
      orderBy: { sequence: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual(['order.created', 'order.placed']);
    expect(await ctx.prisma.payment.findFirst({ where: { orderId: order.id } })).toMatchObject({
      method: 'COD',
      status: 'PENDING',
    });
    expect(
      (await ctx.prisma.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status,
    ).toBe('CONFIRMED');
    expect((await b.get('/cart')).body.data.lines).toEqual([]); // cart converted
    const jobs = (ctx.container.jobs as RecordingJobQueue).jobs.map((j) => j.name);
    expect(jobs).toEqual(['accept-reminder', 'accept-timeout']);
  });

  it('produces exactly one order per session: replays, reused sessions and races (FR-ORDER-002)', async () => {
    const { browser: b, session } = await checkoutWith();
    const k = key();
    const first = await confirm(b, session.id, session.payableAmount, k);
    const replay = await confirm(b, session.id, session.payableAmount, k);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.order.id).toBe(first.body.data.order.id);
    const again = await confirm(b, session.id, session.payableAmount);
    expect(again.body.error).toMatchObject({
      code: 'CHECKOUT_SESSION_CONSUMED',
      details: [{ code: 'ORDER_ID', message: first.body.data.order.id }],
    });

    const race = await checkoutWith();
    const results = await Promise.all([
      confirm(race.browser, race.session.id, race.session.payableAmount),
      confirm(race.browser, race.session.id, race.session.payableAmount),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ctx.prisma.order.count({ where: { checkoutSessionId: race.session.id } })).toBe(1);
  });

  it('starts an online payment and holds wallet credit (T01)', async () => {
    const c = await checkoutWith({ paymentMethod: 'ONLINE' });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.wallet.credit(tx, {
        userId: c.userId,
        amount: 5_000,
        source: 'GOODWILL',
        referenceType: 'test',
        referenceId: uuidv7(),
        description: 'x',
      }),
    );
    const s = (await c.browser.patch(`/checkout/sessions/${c.session.id}`, { useWallet: true }))
      .body.data;
    const res = await confirm(c.browser, s.id, s.payableAmount);
    expect(res.body.data).toMatchObject({
      order: { status: 'PAYMENT_PENDING' },
      payment: { provider: 'MOCK', amount: s.payableAmount },
      paymentError: null,
    });
    expect((await c.browser.get('/me/wallet')).body.data).toMatchObject({
      availableAmount: 0,
      heldAmount: 5_000,
    });
    expect((ctx.container.jobs as RecordingJobQueue).jobs.map((j) => j.name)).toEqual([
      'payment-ttl',
    ]);
  });

  it('pays fully from the wallet and consumes it immediately', async () => {
    const c = await checkoutWith();
    await ctx.prisma.$transaction((tx) =>
      ctx.container.wallet.credit(tx, {
        userId: c.userId,
        amount: 100_000,
        source: 'GOODWILL',
        referenceType: 'test',
        referenceId: uuidv7(),
        description: 'x',
      }),
    );
    const s = (
      await c.browser.patch(`/checkout/sessions/${c.session.id}`, { paymentMethod: 'WALLET' })
    ).body.data;
    const res = await confirm(c.browser, s.id, 0);
    expect(res.body.data.order).toMatchObject({ status: 'PLACED', payableAmount: 0 });
    expect((await c.browser.get('/me/wallet')).body.data).toMatchObject({
      availableAmount: 100_000 - s.quote.total,
      heldAmount: 0,
    });
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('reserves an online coupon, and redeems it at once for COD', async () => {
    const online = await checkoutWith({ paymentMethod: 'ONLINE' });
    await online.browser.post('/cart/coupon', { code: 'WELCOME50' });
    const s1 = (
      await online.browser.patch(`/checkout/sessions/${online.session.id}`, { tipAmount: 0 })
    ).body.data;
    const o1 = (await confirm(online.browser, s1.id, s1.payableAmount)).body.data.order;
    expect(
      await ctx.prisma.couponRedemption.findUnique({ where: { orderId: o1.id } }),
    ).toMatchObject({ status: 'RESERVED', discountAmount: 10_000 });

    const cod = await checkoutWith();
    await cod.browser.post('/cart/coupon', { code: 'WELCOME50' });
    const s2 = (await cod.browser.patch(`/checkout/sessions/${cod.session.id}`, { tipAmount: 0 }))
      .body.data;
    const o2 = (await confirm(cod.browser, s2.id, s2.payableAmount)).body.data.order;
    expect(
      await ctx.prisma.couponRedemption.findUnique({ where: { orderId: o2.id } }),
    ).toMatchObject({ status: 'REDEEMED' });
  });

  it('refuses a changed price or cart, and expired sessions (FR-PRICE-005, E36)', async () => {
    const { browser: b, session } = await checkoutWith();
    const wrong = await confirm(b, session.id, session.payableAmount - 100);
    expect(wrong.body.error.code).toBe('PRICE_CHANGED');
    expect(await ctx.prisma.order.count({ where: { checkoutSessionId: session.id } })).toBe(0);

    await b.post('/cart/items', {
      branchId: saffron,
      foodItemId: ids['Paneer Biryani'],
      optionIds: [ids.Mild, ids['Extra raita']],
      quantity: 1,
    });
    expect((await confirm(b, session.id, session.payableAmount)).body.error.code).toBe(
      'CART_CHANGED',
    );

    const later = await checkoutWith();
    ctx.clock.advance(11 * 60_000);
    expect(
      (await confirm(later.browser, later.session.id, later.session.payableAmount)).status,
    ).toBe(410);
  });

  it('decrements tracked stock under a lock and refuses what is gone (BR-MENU-006)', async () => {
    await ctx.prisma.branchItemStock.upsert({
      where: { branchId_foodItemId: { branchId: saffron, foodItemId: ids['Paneer Biryani']! } },
      create: { branchId: saffron, foodItemId: ids['Paneer Biryani']!, quantity: 1 },
      update: { quantity: 1 },
    });
    await ctx.prisma.branch.update({
      where: { id: saffron },
      data: { menuVersion: { increment: 1 } },
    });
    try {
      const a = await checkoutWith();
      const b = await checkoutWith();
      const version = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
        .menuVersion;
      expect((await confirm(a.browser, a.session.id, a.session.payableAmount)).status).toBe(201);
      expect(
        (
          await ctx.prisma.branchItemStock.findFirstOrThrow({
            where: { foodItemId: ids['Paneer Biryani'] },
          })
        ).quantity,
      ).toBe(0);
      expect(
        (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } })).menuVersion,
      ).toBe(version + 1);
      const res = await confirm(b.browser, b.session.id, b.session.payableAmount);
      expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
    } finally {
      await ctx.prisma.branchItemStock.deleteMany({ where: { branchId: saffron } });
      await ctx.prisma.branch.update({
        where: { id: saffron },
        data: { menuVersion: { increment: 1 } },
      });
    }
  });
});
