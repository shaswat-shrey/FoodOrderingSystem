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
const jobs = () => ctx.container.jobs as RecordingJobQueue;
const relay = () => ctx.container.outboxRelay.runOnce();

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
  jobs().jobs.length = 0;
  mock.down = false;
  // Events left by other suites are not this suite's concern.
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

/** An online order with ₹50 of wallet credit held and WELCOME50 reserved (T01). */
const onlineOrder = () =>
  placeOrder(ctx, {
    branchId: saffron,
    items: [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 2 }],
    paymentMethod: 'ONLINE',
    walletCredit: 5_000,
    coupon: 'WELCOME50',
  });

// Through the service: the clock moves past the access token's lifetime in some tests.
const wallet = (c: { userId: string }) => ctx.container.wallet.summary(c.userId);

suite('payment events place the order (T03, outbox relay)', () => {
  it('captures, then the relay places the order and consumes coupon and wallet once', async () => {
    const c = await onlineOrder();
    const paid = mock.pay(c.payment.providerOrderId, 'success');
    await c.browser.post(
      `/payments/${c.payment.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: c.orderId } })).status).toBe(
      'PAYMENT_PENDING',
    );

    expect(await relay()).toBeGreaterThan(0);
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: c.orderId } });
    expect(order).toMatchObject({ status: 'PLACED', placedAt: expect.any(Date) });
    expect(
      await ctx.prisma.orderStatusHistory.findFirst({
        where: { orderId: c.orderId, toStatus: 'PLACED' },
      }),
    ).toMatchObject({ fromStatus: 'PAYMENT_PENDING', actorType: 'SYSTEM' });
    expect(
      await ctx.prisma.couponRedemption.findUnique({ where: { orderId: c.orderId } }),
    ).toMatchObject({ status: 'REDEEMED' });
    expect(await wallet(c)).toMatchObject({ availableAmount: 0, heldAmount: 0 });
    expect(jobs().jobs.map((j) => j.jobId)).toEqual(
      expect.arrayContaining([`accept-reminder-${c.orderId}`, `accept-timeout-${c.orderId}`]),
    );

    // A replayed event (crash before marking it published) changes nothing.
    const captured = await ctx.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'payment.captured', payload: { path: ['orderId'], equals: c.orderId } },
    });
    expect(captured.publishedAt).not.toBeNull();
    await ctx.container.orderPaymentReactions.onCaptured(c.orderId, captured.aggregateId);
    expect(
      await ctx.prisma.ledgerTransaction.count({
        where: { type: 'WALLET_DEBIT', referenceId: c.orderId },
      }),
    ).toBe(1);
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('refunds a second capture for an already placed order (E10)', async () => {
    const c = await onlineOrder();
    const first = mock.pay(c.payment.providerOrderId, 'success');
    await c.browser.post(
      `/payments/${c.payment.paymentId}/verify`,
      { providerPaymentId: first.providerPaymentId, signature: first.signature },
      key(),
    );
    await relay();
    // A second payment record captured for the same order (e.g. a retried checkout).
    const second = await ctx.prisma.payment.create({
      data: {
        orderId: c.orderId,
        method: 'ONLINE',
        provider: 'MOCK',
        amount: c.payable,
        status: 'CAPTURED',
        capturedAmount: c.payable,
        capturedAt: ctx.clock.now(),
      },
    });
    await ctx.container.orderPaymentReactions.onCaptured(c.orderId, second.id);
    await ctx.container.orderPaymentReactions.onCaptured(c.orderId, second.id);
    expect(await ctx.prisma.refund.findMany({ where: { paymentId: second.id } })).toEqual([
      expect.objectContaining({ amount: c.payable, reasonCode: 'DUPLICATE_PAYMENT' }),
    ]);
  });

  it('keeps per-aggregate order and retries a failing consumer', async () => {
    let calls = 0;
    ctx.container.outboxRelay.on('test.ping', async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    const aggregateId = uuidv7();
    await ctx.prisma.$transaction(async (tx) => {
      for (const v of [1, 2])
        await tx.outboxEvent.create({
          data: {
            eventId: uuidv7(),
            aggregateType: 'test',
            aggregateId,
            aggregateVersion: v,
            eventType: 'test.ping',
            payload: {},
          },
        });
    });
    expect(await relay()).toBe(0); // first fails, second waits behind it
    expect(await relay()).toBe(2);
    expect(calls).toBe(3);
    const rows = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId } });
    expect(rows.map((r) => r.attempts).sort()).toEqual([1, 2]);
  });

  it('alerts when events wait too long (JOB-OUTBOX-001)', async () => {
    await ctx.prisma.outboxEvent.create({
      data: {
        eventId: uuidv7(),
        aggregateType: 'test',
        aggregateId: uuidv7(),
        aggregateVersion: 1,
        eventType: 'test.stale',
        payload: {},
        createdAt: new Date(ctx.clock.now().getTime() - 5 * 60_000),
      },
    });
    expect(await ctx.container.outboxRelay.checkStale()).toBe(1);
    expect(
      await ctx.prisma.opsAlert.count({ where: { type: 'OUTBOX_STALE', status: 'OPEN' } }),
    ).toBe(1);
    await ctx.prisma.outboxEvent.updateMany({
      where: { eventType: 'test.stale' },
      data: { publishedAt: new Date() },
    });
    await ctx.prisma.opsAlert.updateMany({
      where: { type: 'OUTBOX_STALE' },
      data: { status: 'RESOLVED' },
    });
  });
});

suite('order timers (JOB-ORD-001…007)', () => {
  it('expires an unpaid order and gives back coupon, wallet and stock (T04)', async () => {
    await ctx.prisma.branchItemStock.create({
      data: { branchId: saffron, foodItemId: ids['Paneer Biryani']!, quantity: 5 },
    });
    try {
      const c = await onlineOrder();
      expect(
        (await ctx.prisma.branchItemStock.findFirstOrThrow({ where: { branchId: saffron } }))
          .quantity,
      ).toBe(3);
      ctx.clock.advance(16 * 60_000);
      await ctx.container.orderTimerJobs.run('payment-ttl', c.orderId);

      expect(await ctx.prisma.order.findUniqueOrThrow({ where: { id: c.orderId } })).toMatchObject({
        status: 'FAILED',
        failureReason: 'PAYMENT_EXPIRED',
      });
      expect(
        await ctx.prisma.payment.findUniqueOrThrow({ where: { id: c.payment.paymentId } }),
      ).toMatchObject({ status: 'EXPIRED' });
      expect(
        await ctx.prisma.couponRedemption.findUnique({ where: { orderId: c.orderId } }),
      ).toMatchObject({ status: 'RELEASED' });
      expect(await wallet(c)).toMatchObject({ availableAmount: 5_000, heldAmount: 0 });
      expect(
        (await ctx.prisma.branchItemStock.findFirstOrThrow({ where: { branchId: saffron } }))
          .quantity,
      ).toBe(5);
      expect(await ctx.container.ledger.verify()).toEqual([]);

      // Late, duplicate job: nothing happens.
      await ctx.container.orderTimerJobs.run('payment-ttl', c.orderId);
    } finally {
      await ctx.prisma.branchItemStock.deleteMany({ where: { branchId: saffron } });
    }
  });

  it('asks the provider first and places an order whose capture notice was lost (FR-PAY-006)', async () => {
    const c = await onlineOrder();
    mock.pay(c.payment.providerOrderId, 'success'); // no verify, no webhook
    ctx.clock.advance(16 * 60_000);

    mock.down = true;
    await expect(ctx.container.orderTimerJobs.run('payment-ttl', c.orderId)).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    });
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: c.orderId } })).status).toBe(
      'PAYMENT_PENDING',
    );

    mock.down = false;
    await ctx.container.orderTimerJobs.run('payment-ttl', c.orderId);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: c.orderId } })).status).toBe(
      'PLACED',
    );
    expect(await wallet(c)).toMatchObject({ availableAmount: 0, heldAmount: 0 });
  });

  it('moves an accepted order to preparing and nudges a slow restaurant', async () => {
    const c = await signUpCustomer(ctx);
    const accepted = await createFixtureOrder(ctx, {
      userId: c.userId,
      branchId: saffron,
      status: 'ACCEPTED',
    });
    await ctx.container.orderTimerJobs.run('auto-preparing', accepted.orderId);
    expect(
      (await ctx.prisma.order.findUniqueOrThrow({ where: { id: accepted.orderId } })).status,
    ).toBe('PREPARING');
    await ctx.container.orderTimerJobs.run('auto-preparing', accepted.orderId); // no-op now

    const placed = await createFixtureOrder(ctx, {
      userId: c.userId,
      branchId: saffron,
      status: 'PLACED',
    });
    await ctx.container.orderTimerJobs.run('accept-reminder', placed.orderId);
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { aggregateId: placed.orderId, eventType: 'order.accept_reminder' },
      }),
    ).toBe(1);
  });

  it('re-arms lost timers with the remaining delay (JOB-ORD-007, AC-ORDER-010)', async () => {
    const c = await signUpCustomer(ctx);
    const placed = await createFixtureOrder(ctx, {
      userId: c.userId,
      branchId: saffron,
      status: 'PLACED',
    });
    await ctx.prisma.order.update({
      where: { id: placed.orderId },
      data: { placedAt: new Date(ctx.clock.now().getTime() - 60_000) },
    });
    await ctx.container.orderTimerJobs.sweep();
    await ctx.container.orderTimerJobs.sweep(); // deterministic ids: no duplicates
    const mine = jobs().jobs.filter((j) => j.data.orderId === placed.orderId);
    expect(mine).toEqual([
      expect.objectContaining({ name: 'accept-reminder', delayMs: 60_000 }),
      expect.objectContaining({ name: 'accept-timeout', delayMs: 240_000 }),
    ]);
  });

  it('expires stale checkout sessions (JOB-CHK-001)', async () => {
    const before = await ctx.prisma.checkoutSession.count({ where: { status: 'OPEN' } });
    ctx.clock.advance(24 * 60 * 60_000);
    const { CartExpiry } = await import('../src/modules/checkout/cart-expiry');
    expect(await new CartExpiry(ctx.prisma, ctx.clock).expireSessions()).toBeGreaterThanOrEqual(
      before > 0 ? 1 : 0,
    );
    expect(await ctx.prisma.checkoutSession.count({ where: { status: 'OPEN' } })).toBe(0);
  });
});
