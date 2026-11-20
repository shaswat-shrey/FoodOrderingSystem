import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import type { MockPaymentProvider } from '../src/modules/payments';
import type { RecordingJobQueue } from '../src/platform/jobs';
import {
  branchId,
  createFixtureOrder,
  createTestContext,
  integrationEnabled,
  placeOrder,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let mock: MockPaymentProvider;
let saffron: string;
const ids: Record<string, string> = {};

function todayAt(hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const t = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(t.year, t.month, t.day, h! * 60 + m!, 'Asia/Kolkata');
}
const key = () => ({ 'Idempotency-Key': uuidv7() });

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  mock = ctx.container.paymentProvider as MockPaymentProvider;
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
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

const biryani = (quantity = 2) => [
  { foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity },
];
type Placed = Awaited<ReturnType<typeof placeOrder>>;
const preview = async (c: Placed) =>
  (await c.browser.get(`/orders/${c.orderId}/cancellation-preview`)).body.data;
const cancel = (c: Placed, quoteId: string, reasonCode = 'CHANGED_MIND') =>
  c.browser.post(`/orders/${c.orderId}/cancel`, { quoteId, reasonCode }, key());
const orderOf = (c: Placed) => ctx.prisma.order.findUniqueOrThrow({ where: { id: c.orderId } });

/** Online order paid in full by the mock provider and placed by the relay (T03). */
async function paidOrder(
  opts: { walletCredit?: number; coupon?: string; tipAmount?: number } = {},
) {
  const c = await placeOrder(ctx, {
    branchId: saffron,
    items: biryani(),
    paymentMethod: 'ONLINE',
    ...opts,
  });
  const paid = mock.pay(c.payment.providerOrderId, 'success');
  await c.browser.post(
    `/payments/${c.payment.paymentId}/verify`,
    { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
    key(),
  );
  await ctx.container.outboxRelay.runOnce();
  expect((await orderOf(c)).status).toBe('PLACED');
  return c;
}

async function advance(c: Placed, to: 'ACCEPTED' | 'PREPARING' | 'READY_FOR_PICKUP') {
  const path = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'];
  for (const status of path.slice(0, path.indexOf(to) + 1)) {
    await ctx.prisma.$transaction((tx) =>
      ctx.container.orderTransitions.apply(tx, {
        orderId: c.orderId,
        to: status as 'ACCEPTED',
        actor: { type: 'RESTAURANT', id: null },
      }),
    );
  }
}

/** Runs every queued refund through the worker path (wallet ones complete at once). */
async function submitRefunds(orderId: string) {
  for (const r of await ctx.prisma.refund.findMany({ where: { orderId, status: 'APPROVED' } }))
    await ctx.container.refunds.submit(r.id);
}

suite('customer cancellation (API-ORD-006/007, BR-ORDER-010…013, FR-ORDER-020…023)', () => {
  it('cancels a COD order for free before acceptance and gives everything back (T08a)', async () => {
    await ctx.prisma.branchItemStock.create({
      data: { branchId: saffron, foodItemId: ids['Paneer Biryani']!, quantity: 5 },
    });
    try {
      const c = await placeOrder(ctx, {
        branchId: saffron,
        items: biryani(),
        paymentMethod: 'COD',
        coupon: 'WELCOME50',
      });
      const p = await preview(c);
      expect(p).toMatchObject({
        allowed: true,
        fee: 0,
        refund: { amount: 0 },
        quoteId: expect.any(String),
      });
      const res = await cancel(c, p.quoteId);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        order: { status: 'CANCELLED' },
        cancellation: { fee: 0, fault: 'CUSTOMER', refund: { amount: 0, status: 'NONE' } },
      });
      expect(await orderOf(c)).toMatchObject({
        status: 'CANCELLED',
        cancelledAt: expect.any(Date),
      });
      expect(
        await ctx.prisma.orderCancellation.findUnique({ where: { orderId: c.orderId } }),
      ).toMatchObject({
        initiatorType: 'CUSTOMER',
        reasonCode: 'CHANGED_MIND',
        fault: 'CUSTOMER',
        quoteId: p.quoteId,
      });
      expect(await ctx.prisma.payment.findFirst({ where: { orderId: c.orderId } })).toMatchObject({
        method: 'COD',
        status: 'CANCELLED',
      });
      expect(
        await ctx.prisma.couponRedemption.findUnique({ where: { orderId: c.orderId } }),
      ).toMatchObject({ status: 'RELEASED' });
      expect(
        (await ctx.prisma.branchItemStock.findFirstOrThrow({ where: { branchId: saffron } }))
          .quantity,
      ).toBe(5);
      expect(
        await ctx.prisma.outboxEvent.count({
          where: { aggregateId: c.orderId, eventType: 'order.cancelled' },
        }),
      ).toBe(1);
      // Already closed.
      expect((await cancel(c, p.quoteId)).body.error.code).toBe('ORDER_STATE_CONFLICT');
    } finally {
      await ctx.prisma.branchItemStock.deleteMany({ where: { branchId: saffron } });
    }
  });

  it('refunds a paid order in full, card to source and wallet to wallet', async () => {
    const c = await paidOrder({ walletCredit: 5_000, tipAmount: 2_000 });
    const p = await preview(c);
    expect(p).toMatchObject({
      fee: 0,
      refund: { amount: c.payable + 5_000, toSource: c.payable, toWallet: 5_000 },
    });
    expect((await cancel(c, p.quoteId)).body.data.cancellation.refund).toMatchObject({
      status: 'PENDING',
    });
    expect((await orderOf(c)).refundStatus).toBe('PENDING');
    const refunds = await ctx.prisma.refund.findMany({ where: { orderId: c.orderId } });
    expect(refunds.map((r) => [r.destination, r.amount]).sort()).toEqual(
      [
        ['SOURCE', c.payable],
        ['WALLET', 5_000],
      ].sort(),
    );

    await submitRefunds(c.orderId);
    expect(await ctx.container.wallet.summary(c.userId)).toMatchObject({ availableAmount: 5_000 });
    const source = refunds.find((r) => r.destination === 'SOURCE')!;
    const settled = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: source.id } });
    const hook = mock.settleRefund(settled.providerRefundId!);
    await request(ctx.app)
      .post('/api/v1/payments/webhooks/mock')
      .set(hook.headers)
      .send(hook.body.toString('utf8'));
    // What the worker's JOB-PAY-001 does with the queued event.
    for (const job of (ctx.container.jobs as RecordingJobQueue).jobs.filter(
      (j) => j.queue === 'payments',
    ))
      await ctx.container.payments.processWebhook(String(job.data.eventRowId));
    await ctx.container.outboxRelay.runOnce();
    expect((await orderOf(c)).refundStatus).toBe('FULL');
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('charges half the food value after the free window, keeps the coupon, pays the restaurant', async () => {
    const c = await paidOrder({ coupon: 'WELCOME50' });
    await advance(c, 'ACCEPTED');
    const free = await preview(c);
    expect(free).toMatchObject({ fee: 0, freeUntil: expect.any(String) });

    ctx.clock.advance(61_000);
    // The free quote is no longer honoured (FR-ORDER-020).
    expect((await cancel(c, free.quoteId)).body.error.code).toBe('CANCELLATION_QUOTE_STALE');
    const p = await preview(c);
    const order = await orderOf(c);
    const food = order.itemsSubtotalAmount - order.discountTotalAmount;
    expect(p).toMatchObject({ fee: Math.round(food / 2), freeUntil: null });
    expect(p.refund.amount).toBe(c.payable - p.fee);

    const res = await cancel(c, p.quoteId, 'DELAY');
    expect(res.body.data.cancellation).toMatchObject({
      fee: p.fee,
      refund: { amount: p.refund.amount },
    });
    expect(
      await ctx.prisma.couponRedemption.findUnique({ where: { orderId: c.orderId } }),
    ).toMatchObject({ status: 'REDEEMED' }); // BR-COUPON-006: customer fault after acceptance
    const fee = await ctx.prisma.ledgerTransaction.findFirstOrThrow({
      where: { type: 'CANCELLATION_FEE', referenceId: c.orderId },
      include: { entries: { include: { account: true } } },
    });
    expect(fee.entries.find((e) => e.account.type === 'RESTAURANT_PAYABLE')!.amount).toBe(
      BigInt(-p.fee),
    );
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('charges food and packaging while preparing, and refuses once ready', async () => {
    const c = await paidOrder();
    await advance(c, 'PREPARING');
    const p = await preview(c);
    const order = await orderOf(c);
    const packaging = await ctx.prisma.orderPriceComponent.aggregate({
      where: { orderId: c.orderId, type: 'PACKAGING' },
      _sum: { amount: true },
    });
    expect(p.fee).toBe(
      order.itemsSubtotalAmount - order.discountTotalAmount + (packaging._sum.amount ?? 0),
    );

    const ready = await paidOrder();
    await advance(ready, 'READY_FOR_PICKUP');
    const r = await preview(ready);
    expect(r).toMatchObject({ allowed: false, reason: 'ORDER_READY', quoteId: null });
    const refused = await cancel(ready, uuidv7());
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({
      code: 'CANCELLATION_NOT_ALLOWED',
      details: [expect.objectContaining({ code: 'ORDER_READY', path: 'supportLink' })],
    });
  });

  it('serialises a cancel racing the restaurant accepting; the loser gets 409', async () => {
    const c = await placeOrder(ctx, { branchId: saffron, items: biryani(), paymentMethod: 'COD' });
    const p = await preview(c);
    const [cancelled, accepted] = await Promise.allSettled([
      cancel(c, p.quoteId),
      ctx.prisma.$transaction((tx) =>
        ctx.container.orderTransitions.apply(tx, {
          orderId: c.orderId,
          to: 'ACCEPTED',
          actor: { type: 'RESTAURANT', id: null },
        }),
      ),
    ]);
    const status = (await orderOf(c)).status;
    if (status === 'CANCELLED') {
      expect(accepted.status).toBe('rejected');
    } else {
      expect(status).toBe('ACCEPTED');
      expect(cancelled.status === 'fulfilled' && cancelled.value.body.error.code).toBe(
        'ORDER_STATE_CONFLICT',
      );
    }
  });
});

suite('abandoning a payment (API-PAY-005, T05, FR-PAY-016)', () => {
  it('cancels the unpaid order, releases the hold, and refunds a capture that arrives later (E07)', async () => {
    const c = await placeOrder(ctx, {
      branchId: saffron,
      items: biryani(),
      paymentMethod: 'ONLINE',
      walletCredit: 5_000,
      coupon: 'WELCOME50',
    });
    const res = await c.browser.post(`/payments/${c.payment.paymentId}/cancel`, {}, key());
    expect(res.status).toBe(200);
    expect(await orderOf(c)).toMatchObject({ status: 'CANCELLED' });
    expect(
      await ctx.prisma.payment.findUniqueOrThrow({ where: { id: c.payment.paymentId } }),
    ).toMatchObject({ status: 'CANCELLED' });
    expect(await ctx.container.wallet.summary(c.userId)).toMatchObject({
      availableAmount: 5_000,
      heldAmount: 0,
    });
    expect(
      await ctx.prisma.couponRedemption.findUnique({ where: { orderId: c.orderId } }),
    ).toMatchObject({ status: 'RELEASED' });

    // The customer paid in another tab anyway.
    const paid = mock.pay(c.payment.providerOrderId, 'success');
    await c.browser.post(
      `/payments/${c.payment.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    expect(await ctx.prisma.refund.findMany({ where: { orderId: c.orderId } })).toEqual([
      expect.objectContaining({ amount: c.payable, reasonCode: 'LATE_CAPTURE' }),
    ]);
  });

  it('does not cancel when the provider says it was already paid', async () => {
    const c = await placeOrder(ctx, {
      branchId: saffron,
      items: biryani(),
      paymentMethod: 'ONLINE',
    });
    mock.pay(c.payment.providerOrderId, 'success'); // no callback reached us
    const res = await c.browser.post(`/payments/${c.payment.paymentId}/cancel`, {}, key());
    expect(res.body.error.code).toBe('ORDER_STATE_CONFLICT');
    await ctx.container.outboxRelay.runOnce();
    expect((await orderOf(c)).status).toBe('PLACED');
  });
});

suite('acceptance timeout (T08b, BR-ORDER-004, BR-REST-009, AC-ORDER-009)', () => {
  it('cancels with a full refund and pauses the branch after three in a row', async () => {
    const c = await signUpCustomer(ctx);
    try {
      const orders: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const { orderId } = await createFixtureOrder(ctx, {
          userId: c.userId,
          branchId: saffron,
          status: 'PLACED',
        });
        // Later than anything else at this branch, so these are "the last three".
        await ctx.prisma.order.update({
          where: { id: orderId },
          data: { placedAt: new Date(ctx.clock.now().getTime() + i * 3_600_000) },
        });
        orders.push(orderId);
      }
      for (const id of orders.slice(0, 2))
        await ctx.container.orderTimerJobs.run('accept-timeout', id);
      expect(
        (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } })).pausedUntil,
      ).toBeNull();
      await ctx.container.orderTimerJobs.run('accept-timeout', orders[2]!);
      await ctx.container.orderTimerJobs.run('accept-timeout', orders[2]!); // duplicate job: no-op

      expect(
        await ctx.prisma.orderCancellation.findUnique({ where: { orderId: orders[0]! } }),
      ).toMatchObject({
        initiatorType: 'SYSTEM',
        reasonCode: 'ACCEPT_TIMEOUT',
        fault: 'RESTAURANT',
      });
      const branch = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } });
      expect(branch.pausedUntil!.getTime()).toBe(ctx.clock.now().getTime() + 30 * 60_000);
      expect(
        await ctx.prisma.opsAlert.count({ where: { type: 'BRANCH_AUTO_PAUSED', refId: saffron } }),
      ).toBeGreaterThan(0);
    } finally {
      await ctx.prisma.branch.update({
        where: { id: saffron },
        data: { pausedUntil: null, pauseReason: null },
      });
    }
  });
});
