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
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
const ids: Record<string, string> = {};
const RIDER = '+919000000405';
const PASSWORD = 'kitchen pass phrase 42';

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

/** One COD trip with a tip, delivered by RIDER. */
async function deliverOne() {
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
    tipAmount: 2_000,
  });
  const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
  await manager.browser.post(`/merchant/orders/${c.orderId}/accept`, { prepMinutes: 12 }, key());
  await ctx.container.outboxRelay.runOnce();
  const d = await ctx.prisma.delivery.findUniqueOrThrow({ where: { orderId: c.orderId } });
  await ctx.container.dispatch.start(d.id);
  const offer = (await r.browser.get('/partner/offers/current')).body.data;
  await r.browser.post(`/partner/offers/${offer.offerId}/accept`, {}, key());
  await manager.browser.post(`/merchant/orders/${c.orderId}/ready`, {}, key());
  await r.browser.post(`/partner/deliveries/${d.id}/picked-up`, {}, key());
  const otp = deliveryCode(ctx.container.env.AUTH_HMAC_SECRET, c.orderId);
  const done = await r.browser.post(
    `/partner/deliveries/${d.id}/complete`,
    { method: 'OTP', otp, cashCollected: true },
    key(),
  );
  expect(done.status).toBe(200);
  return { ...r, deliveryId: d.id, payable: c.payable, orderId: c.orderId };
}

suite('partner earnings (API-EARN-001…012, FR-EARN-001/002/005…007, BR-EARN-002/005/006)', () => {
  it('shows the trip in the summary, the statement and its own breakdown, with the tip apart', async () => {
    const r = await deliverOne();
    const earning = await ctx.prisma.partnerEarning.findUniqueOrThrow({
      where: { deliveryId: r.deliveryId },
    });

    const day = (await r.browser.get('/partner/me/earnings/summary?period=day')).body.data;
    expect(day.deliveries).toBeGreaterThanOrEqual(1);
    expect(day.breakdown.tips).toBeGreaterThanOrEqual(2_000);
    expect(day.total).toBe(
      day.tripPay + day.breakdown.tips + day.breakdown.incentives + day.breakdown.adjustments,
    );
    const week = (await r.browser.get('/partner/me/earnings/summary?period=week')).body.data;
    expect(new Date(week.to).getTime() - new Date(week.from).getTime()).toBe(7 * 86_400_000);
    expect(week.total).toBeGreaterThanOrEqual(day.total);

    // One entry per page: the tip, then the trip pay, both for this delivery.
    const first = await r.browser.get('/partner/me/earnings?limit=1');
    expect(first.body.data).toEqual([
      expect.objectContaining({ type: 'TIP', amount: 2_000, deliveryId: r.deliveryId }),
    ]);
    const cursor = encodeURIComponent(first.body.meta.pagination.nextCursor as string);
    const second = await r.browser.get(`/partner/me/earnings?limit=1&cursor=${cursor}`);
    expect(second.body.data).toEqual([
      expect.objectContaining({
        type: 'PARTNER_EARNING',
        amount: earning.totalAmount - 2_000,
        deliveryId: r.deliveryId,
        orderNumber: expect.any(String),
      }),
    ]);

    const one = (await r.browser.get(`/partner/me/earnings/deliveries/${r.deliveryId}`)).body.data;
    expect(one).toMatchObject({
      deliveryId: r.deliveryId,
      compensation: false,
      breakdown: { base: earning.baseAmount, tip: 2_000 },
      total: earning.totalAmount,
    });
    const other = await signInAs(ctx, '+919000000403', 'DELIVERY');
    expect(
      (await other.browser.get(`/partner/me/earnings/deliveries/${r.deliveryId}`)).status,
    ).toBe(404);
  });

  it('shows cash in hand against the cap, and deducts it from the next payout (BR-EARN-006)', async () => {
    const r = await deliverOne();
    const cash = (await r.browser.get('/partner/me/cash')).body.data;
    expect(cash).toMatchObject({ cap: 300_000, blocked: false });
    expect(cash.balance).toBeGreaterThanOrEqual(r.payable);
    expect(cash.remaining).toBe(cash.cap - cash.balance);
    const moves = (await r.browser.get('/partner/me/cash/transactions')).body.data;
    expect(moves[0]).toMatchObject({ type: 'COD_COLLECTION', amount: r.payable });

    const payouts = (await r.browser.get('/partner/me/payouts')).body.data;
    expect(payouts.items).toEqual([]);
    expect(payouts.next).toMatchObject({ cashDeduction: cash.balance, minimum: 10_000 });
    expect(payouts.next.amount).toBe(payouts.next.earnings - cash.balance);
    // This partner collected more cash than they earned: the balance carries over.
    expect(payouts.next.status).toBe('CARRY_OVER_NEGATIVE');
    expect((await r.browser.get(`/partner/me/payouts/${uuidv7()}`)).status).toBe(404);
  });

  it('reports 30-day performance and aggregate-only ratings (BR-REVIEW-006)', async () => {
    const r = await deliverOne();
    const perf = (await r.browser.get('/partner/me/performance')).body.data;
    expect(perf).toMatchObject({ windowDays: 30, acceptanceRate: expect.any(Number) });
    expect(perf.deliveries).toBeGreaterThanOrEqual(1);
    expect(perf.completionRate).toBeGreaterThan(0);
    const ratings = await r.browser.get('/partner/me/ratings');
    expect(ratings.body.data).toMatchObject({
      distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
      tags: {},
      comments: [],
    });
  });

  it('holds payouts while a bank change waits for verification, after a fresh password (BR-AUTH-017)', async () => {
    const r = await signInAs(ctx, RIDER, 'DELIVERY');
    const body = { holderName: 'Test Rider', accountNumber: '123456789012', ifsc: 'HDFC0001234' };
    const blocked = await r.browser.post('/partner/me/bank-account/change-requests', body, key());
    expect(blocked.body.error.code).toBe('AUTH_REAUTH_REQUIRED');
    expect((await r.browser.post('/auth/reauth', { password: PASSWORD })).status).toBe(200);
    const res = await r.browser.post('/partner/me/bank-account/change-requests', body, key());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ payoutsOnHold: true });
    const shown = JSON.stringify(res.body.data);
    expect(shown).toContain('XXXXXX9012');
    expect(shown).not.toContain('123456789012');
    expect((await r.browser.get('/partner/me/payouts')).body.data.next.status).toBe(
      'ON_HOLD_BANK_CHANGE',
    );
    // A second request replaces the first rather than queueing behind it.
    await r.browser.post(
      '/partner/me/bank-account/change-requests',
      { ...body, accountNumber: '998877665544' },
      key(),
    );
    const partnerId = (
      await ctx.prisma.deliveryPartner.findFirstOrThrow({ where: { user: { phone: RIDER } } })
    ).id;
    expect(
      await ctx.prisma.partnerBankAccount.count({
        where: { partnerId, status: 'PENDING_VERIFICATION' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'partner.bank_change_requested', targetId: partnerId },
      }),
    ).toBe(2);
  });
});
