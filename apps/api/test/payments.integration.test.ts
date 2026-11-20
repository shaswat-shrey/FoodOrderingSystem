import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import type { MockPaymentProvider } from '../src/modules/payments';
import {
  branchId,
  createFixtureOrder,
  createTestContext,
  integrationEnabled,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let mock: MockPaymentProvider;
let saffron: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  mock = ctx.container.paymentProvider as MockPaymentProvider;
  saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  mock.down = false;
});

const key = () => ({ 'Idempotency-Key': uuidv7() });

/** A customer with an ONLINE order waiting for ₹500. */
async function pendingOrder(
  payableAmount = 50_000,
  status: 'PAYMENT_PENDING' | 'FAILED' = 'PAYMENT_PENDING',
) {
  const c = await signUpCustomer(ctx);
  const order = await createFixtureOrder(ctx, {
    userId: c.userId,
    branchId: saffron,
    payableAmount,
    status,
  });
  return { ...c, ...order };
}

// Sent as a string: supertest would JSON-encode a Buffer ({"type":"Buffer",…}) and break the signature.
const webhook = (hook: { body: Buffer; headers: Record<string, string> }, provider = 'mock') =>
  request(ctx.app)
    .post(`/api/v1/payments/webhooks/${provider}`)
    .set(hook.headers)
    .send(hook.body.toString('utf8'));

/** Processes whatever webhook events are waiting (what the worker does). */
const drain = () => ctx.container.payments.processPendingWebhooks(-60_000);

suite('initiating payment (API-PAY-002, FR-PAY-002, 005, 007)', () => {
  it('creates a provider order once, returns only public parameters, and counts attempts', async () => {
    const { browser: b, orderId, number } = await pendingOrder();
    expect((await b.post(`/orders/${orderId}/payments`)).status).toBe(400); // Idempotency-Key required
    const first = await b.post(`/orders/${orderId}/payments`, {}, key());
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      provider: 'MOCK',
      keyId: 'rzp_mock_key',
      amount: 50_000,
      currency: 'INR',
      orderNumber: number,
      prefill: { name: 'Test User' },
    });
    expect(JSON.stringify(first.body)).not.toMatch(/secret/i);
    const again = await b.post(`/orders/${orderId}/payments`, {}, key());
    expect(again.body.data.providerOrderId).toBe(first.body.data.providerOrderId); // reused (FR-PAY-005)
    for (let i = 0; i < 3; i++) await b.post(`/orders/${orderId}/payments`, {}, key());
    const sixth = await b.post(`/orders/${orderId}/payments`, {}, key());
    expect(sixth.body.error.code).toBe('PAYMENT_ATTEMPTS_EXCEEDED'); // BR-PAY-006
  });

  it('keeps the order waiting when the provider is down, so the customer can retry', async () => {
    const { browser: b, orderId } = await pendingOrder();
    mock.down = true;
    const res = await b.post(`/orders/${orderId}/payments`, {}, key());
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', retryable: true });
    mock.down = false;
    expect((await b.post(`/orders/${orderId}/payments`, {}, key())).status).toBe(201);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      'PAYMENT_PENDING',
    );
  });

  it('only for the order owner and only while payment is pending', async () => {
    const { orderId } = await pendingOrder();
    const stranger = await signUpCustomer(ctx);
    expect((await stranger.browser.post(`/orders/${orderId}/payments`, {}, key())).status).toBe(
      404,
    );
    const done = await pendingOrder(50_000, 'FAILED');
    expect(
      (await done.browser.post(`/orders/${done.orderId}/payments`, {}, key())).body.error.code,
    ).toBe('ORDER_STATE_CONFLICT');
  });
});

suite('verifying payment (API-PAY-003/004, FR-PAY-003, 015, BR-PAY-003)', () => {
  it('captures only after the signature checks out and the provider confirms', async () => {
    const { browser: b, orderId } = await pendingOrder();
    const init = (await b.post(`/orders/${orderId}/payments`, {}, key())).body.data;
    const paid = mock.pay(init.providerOrderId, 'success');

    const forged = await b.post(
      `/payments/${init.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: 'ab'.repeat(32) },
      key(),
    );
    expect(forged.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'payment.signature_invalid', targetId: init.paymentId },
      }),
    ).toBe(1);

    const ok = await b.post(
      `/payments/${init.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    expect(ok.body.data).toMatchObject({
      status: 'CAPTURED',
      capturedAmount: 50_000,
      instrumentSummary: 'UPI • as***@okicici',
    });
    expect((await b.get(`/payments/${init.paymentId}`)).body.data.status).toBe('CAPTURED');
    // Ledger: the money is at the gateway, owed to the order (ADR-011).
    const liability = await ctx.container.ledger.balance(ctx.prisma, {
      ownerType: 'ORDER',
      ownerId: orderId,
      type: 'CUSTOMER_ORDER_LIABILITY',
    });
    expect(liability).toBe(50_000);
    const events = await ctx.prisma.outboxEvent.findMany({
      where: { aggregateId: init.paymentId },
      orderBy: { sequence: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual(['payment.captured']);
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('records a declined payment as FAILED; a retry starts a new payment', async () => {
    const { browser: b, orderId } = await pendingOrder();
    const init = (await b.post(`/orders/${orderId}/payments`, {}, key())).body.data;
    const failed = mock.pay(init.providerOrderId, 'fail');
    const res = await b.post(
      `/payments/${init.paymentId}/verify`,
      { providerPaymentId: failed.providerPaymentId, signature: failed.signature },
      key(),
    );
    expect(res.body.data).toMatchObject({
      status: 'FAILED',
      failureReason: 'Payment was declined by the bank',
    });
    const retry = (await b.post(`/orders/${orderId}/payments`, {}, key())).body.data;
    expect(retry.paymentId).not.toBe(init.paymentId);
  });
});

suite('webhooks (API-PAY-007, FR-PAY-004, 008, 009, BR-PAY-004, 005)', () => {
  it('verifies the raw body, stores each event once, and processes asynchronously', async () => {
    const { browser: b, orderId } = await pendingOrder();
    const init = (await b.post(`/orders/${orderId}/payments`, {}, key())).body.data;
    const paid = mock.pay(init.providerOrderId, 'success');
    const forged = mock.webhook('payment.captured', {}, 'wrong-secret');
    expect((await webhook(forged)).status).toBe(401);
    expect((await webhook(paid.webhook, 'stripe')).status).toBe(404);

    const first = await webhook(paid.webhook);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ duplicate: false });
    expect((await webhook(paid.webhook)).body.data).toEqual({ duplicate: true });
    expect(
      await ctx.prisma.paymentWebhookEvent.count({
        where: { eventId: paid.webhook.headers['x-razorpay-event-id'] },
      }),
    ).toBe(1);

    expect(
      (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: init.paymentId } })).status,
    ).toBe('PENDING'); // not inline
    await drain();
    expect(
      (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: init.paymentId } })).status,
    ).toBe('CAPTURED');
  });

  it('ignores out-of-order events that would move a payment backwards', async () => {
    const { browser: b, orderId } = await pendingOrder();
    const init = (await b.post(`/orders/${orderId}/payments`, {}, key())).body.data;
    const paid = mock.pay(init.providerOrderId, 'success');
    await b.post(
      `/payments/${init.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    const late = mock.webhook('payment.authorized', {
      payment: {
        entity: {
          id: paid.providerPaymentId,
          order_id: init.providerOrderId,
          amount: 50_000,
          currency: 'INR',
          status: 'authorized',
        },
      },
    });
    await webhook(late);
    await webhook(paid.webhook); // the capture webhook arrives after verify
    await drain();
    expect(
      (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: init.paymentId } })).status,
    ).toBe('CAPTURED');
    const statuses = await ctx.prisma.paymentWebhookEvent.findMany({
      where: {
        eventId: {
          in: [late.headers['x-razorpay-event-id']!, paid.webhook.headers['x-razorpay-event-id']!],
        },
      },
    });
    expect(statuses.map((s) => s.processingStatus).sort()).toEqual(['IGNORED', 'IGNORED']);
    expect(await ctx.container.ledger.verify()).toEqual([]); // captured once in the ledger
  });

  it('refunds a capture with the wrong amount and never advances the order (FR-PAY-008)', async () => {
    const { browser: b, orderId } = await pendingOrder();
    const init = (await b.post(`/orders/${orderId}/payments`, {}, key())).body.data;
    const short = mock.pay(init.providerOrderId, 'amount_mismatch');
    await webhook(short.webhook);
    await drain();
    const payment = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: init.paymentId },
      include: { refunds: true },
    });
    expect(payment).toMatchObject({
      status: 'CAPTURED',
      failureCode: 'AMOUNT_MISMATCH',
      capturedAmount: 49_900,
    });
    expect(payment.refunds).toEqual([
      expect.objectContaining({
        amount: 49_900,
        status: 'APPROVED',
        reasonCode: 'AMOUNT_MISMATCH',
        costBearer: 'PLATFORM',
      }),
    ]);
    expect(
      await ctx.prisma.opsAlert.count({
        where: { type: 'PAYMENT_AMOUNT_MISMATCH', refId: payment.id },
      }),
    ).toBe(1);
    expect(
      (await ctx.prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: payment.id } }))
        .eventType,
    ).toBe('payment.amount_mismatch');

    // The worker submits it; the provider confirms; the ledger and payment follow.
    const refundId = payment.refunds[0]!.id;
    await ctx.container.refunds.submit(refundId);
    const processing = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(processing).toMatchObject({ status: 'PROCESSING', attempts: 1 });
    await webhook(mock.settleRefund(processing.providerRefundId!));
    await drain();
    expect((await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe(
      'SUCCEEDED',
    );
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'REFUNDED',
    );
    expect(
      await ctx.container.ledger.balance(ctx.prisma, {
        ownerType: 'ORDER',
        ownerId: orderId,
        type: 'CUSTOMER_ORDER_LIABILITY',
      }),
    ).toBe(0);
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('refunds a capture for an order that already failed (BR-PAY-005)', async () => {
    const { browser: b, orderId } = await pendingOrder();
    const init = (await b.post(`/orders/${orderId}/payments`, {}, key())).body.data;
    await ctx.prisma.order.update({
      where: { id: orderId },
      data: { status: 'FAILED', failureReason: 'PAYMENT_EXPIRED' },
    });
    await webhook(mock.pay(init.providerOrderId, 'success').webhook);
    await drain();
    const refunds = await ctx.prisma.refund.findMany({ where: { orderId } });
    expect(refunds).toEqual([
      expect.objectContaining({ reasonCode: 'LATE_CAPTURE', amount: 50_000 }),
    ]);
    expect(
      (await ctx.prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: init.paymentId } }))
        .eventType,
    ).toBe('payment.late_capture');
  });

  it('alerts on captures that match no payment', async () => {
    const body = mock.webhook('payment.captured', {
      payment: {
        entity: {
          id: `pay_${Date.now()}`,
          order_id: 'order_unknown',
          amount: 100,
          currency: 'INR',
          status: 'captured',
        },
      },
    });
    await webhook(body);
    await drain();
    expect(
      await ctx.prisma.opsAlert.count({
        where: { type: 'PAYMENT_ORPHAN_CAPTURE', status: 'OPEN' },
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});

suite('refunds (FR-REFUND-001, 003, 005, API-REF-001/002)', () => {
  async function captured() {
    const c = await pendingOrder();
    const init = (await c.browser.post(`/orders/${c.orderId}/payments`, {}, key())).body.data;
    const paid = mock.pay(init.providerOrderId, 'success');
    await c.browser.post(
      `/payments/${init.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    return { ...c, paymentId: init.paymentId as string };
  }
  const base = (o: { orderId: string; paymentId: string }) => ({
    orderId: o.orderId,
    paymentId: o.paymentId,
    destination: 'SOURCE' as const,
    reasonCode: 'TEST',
    initiatorType: 'SYSTEM' as const,
    costBearer: 'PLATFORM' as const,
  });

  it('never refunds more than was captured, counting refunds in flight', async () => {
    const o = await captured();
    await ctx.prisma.$transaction((tx) =>
      ctx.container.refunds.create(tx, { ...base(o), amount: 30_000 }),
    );
    await expect(
      ctx.prisma.$transaction((tx) =>
        ctx.container.refunds.create(tx, { ...base(o), amount: 20_001 }),
      ),
    ).rejects.toMatchObject({
      code: 'REFUND_EXCEEDS_REFUNDABLE',
    });
    await ctx.prisma.$transaction((tx) =>
      ctx.container.refunds.create(tx, { ...base(o), amount: 20_000 }),
    );
  });

  it('retries provider failures with backoff, then hands over to operations', async () => {
    const o = await captured();
    const refund = await ctx.prisma.$transaction((tx) =>
      ctx.container.refunds.create(tx, { ...base(o), amount: 10_000 }),
    );
    mock.down = true;
    await ctx.container.refunds.submit(refund.id);
    const retrying = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(retrying).toMatchObject({ status: 'APPROVED', attempts: 1 });
    expect(retrying.nextAttemptAt!.getTime()).toBeGreaterThan(ctx.clock.now().getTime());
    for (let i = 0; i < 4; i++) await ctx.container.refunds.submit(refund.id);
    expect((await ctx.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
      'FAILED',
    );
    expect(
      await ctx.prisma.opsAlert.count({ where: { type: 'REFUND_FAILED', refId: refund.id } }),
    ).toBe(1);
  });

  it('credits the wallet for wallet refunds, and shows refunds to their owner only', async () => {
    const o = await captured();
    const refund = await ctx.prisma.$transaction((tx) =>
      ctx.container.refunds.create(tx, { ...base(o), destination: 'WALLET', amount: 5_000 }),
    );
    await ctx.container.refunds.submit(refund.id);
    expect((await o.browser.get('/me/wallet')).body.data.availableAmount).toBe(5_000);
    expect((await o.browser.get('/me/refunds')).body.data).toEqual([
      expect.objectContaining({ id: refund.id, status: 'SUCCEEDED', destination: 'WALLET' }),
    ]);
    expect((await o.browser.get(`/refunds/${refund.id}`)).status).toBe(200);
    const stranger = await signUpCustomer(ctx);
    expect((await stranger.browser.get(`/refunds/${refund.id}`)).status).toBe(404);
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('lists the customer’s payments', async () => {
    const o = await captured();
    const history = (await o.browser.get('/me/payments')).body.data;
    expect(history).toEqual([expect.objectContaining({ id: o.paymentId, status: 'CAPTURED' })]);
  });
});

suite('stuck payments (FR-RECON-004)', () => {
  it('asks the provider about payments pending for 30 minutes', async () => {
    const { browser: b, orderId } = await pendingOrder();
    const init = (await b.post(`/orders/${orderId}/payments`, {}, key())).body.data;
    const paid = mock.pay(init.providerOrderId, 'success');
    // The customer closed the app before verify and the webhook never arrived; we know the attempt id.
    await ctx.prisma.paymentAttempt.updateMany({
      where: { paymentId: init.paymentId, providerPaymentId: null },
      data: { providerPaymentId: paid.providerPaymentId },
    });
    await ctx.prisma
      .$executeRaw`UPDATE payments SET updated_at = now() - interval '31 minutes' WHERE id = ${init.paymentId}::uuid`;
    ctx.clock.set(new Date());
    expect(await ctx.container.payments.resolveStuck()).toBeGreaterThanOrEqual(1);
    expect(
      (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: init.paymentId } })).status,
    ).toBe('CAPTURED');
  });
});
