import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { deliveryCode, ORDER_JOBS } from '../src/modules/orders';
import { periodBounds } from '../src/modules/partners';
import type { MockPaymentProvider } from '../src/modules/payments';
import type { RecordingJobQueue } from '../src/platform/jobs';
import { raiseOpsAlert } from '../src/platform/ops-alerts';
import {
  branchId,
  browser,
  createTestContext,
  integrationEnabled,
  parkActiveDeliveries,
  PARTNERS,
  placeOrder,
  SAFFRON_STAFF,
  setPassword,
  signInAs,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
let saffronRestaurant: string;
const ids: Record<string, string> = {};

const STAFF = {
  superAdmin: '+919000000001',
  admin: '+919000000002',
  support: '+919000000003',
} as const;
const PASSWORD = 'admin console passphrase';
const NEAR = { lat: 12.9355, lng: 77.6245 };
const key = () => ({ 'Idempotency-Key': uuidv7() });

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
  saffronRestaurant = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
    .restaurantId;
  for (const i of await ctx.prisma.foodItem.findMany({
    where: { restaurantId: saffronRestaurant },
  }))
    ids[i.name] = i.id;
  for (const o of await ctx.prisma.customizationOption.findMany({
    where: { group: { restaurantId: saffronRestaurant } },
  }))
    ids[o.name] = o.id;
  riderStats = await ctx.prisma.partnerStats.findMany({
    where: { partner: { user: { phone: { in: [...PARTNERS] } } } },
  });
});
/** Restaurant bank accounts this file verifies; superseded afterwards so go-live checks elsewhere stay stable. */
const verifiedBanks: string[] = [];
/** Seeded riders' ranking stats before this file, restored afterwards so dispatch order elsewhere is unchanged. */
let riderStats: Awaited<ReturnType<TestContext['prisma']['partnerStats']['findMany']>> = [];
afterAll(async () => {
  if (!integrationEnabled) return;
  for (const { partnerId, updatedAt: _, ...stats } of riderStats)
    await ctx.prisma.partnerStats.update({ where: { partnerId }, data: stats });
  // Other files sign the same staff in at the same manual clock time: lift this file's OTP cooldown.
  await ctx.prisma.otpCode.deleteMany({
    where: { userId: { in: [...signedIn.values()].map((s) => s.userId) } },
  });
  await ctx.prisma.restaurantBankAccount.updateMany({
    where: { id: { in: verifiedBanks } },
    data: { status: 'SUPERSEDED' },
  });
  await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
  (ctx.container.jobs as RecordingJobQueue).jobs.length = 0;
  await parkActiveDeliveries(ctx);
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

const signedIn = new Map<string, { browser: ReturnType<typeof browser>; userId: string }>();

/** Seeded staff into the admin app through the emailed second factor, once per file. */
async function staff(phone: string) {
  const known = signedIn.get(phone);
  if (known) return known;
  const user = await ctx.prisma.user.findFirstOrThrow({ where: { phone } });
  // Another file may have signed this person in at the same manual clock time (OTP resend cooldown).
  await ctx.prisma.otpCode.deleteMany({ where: { userId: user.id } });
  await setPassword(ctx.prisma, user.id, PASSWORD);
  const b = browser(ctx, 'ADMIN');
  const first = await b.post('/auth/login', { identifier: phone, password: PASSWORD });
  expect(first.body.data.mfaRequired).toBe(true);
  const code = ctx.messages.lastOtp(user.email!)!;
  const done = b.remember(
    await b.post('/auth/mfa/challenge', { mfaToken: first.body.data.mfaToken, code }),
  );
  expect(done.status).toBe(200);
  const result = { browser: b, userId: user.id };
  signedIn.set(phone, result);
  return result;
}

const audited = (action: string, targetId: string) =>
  ctx.prisma.auditLog.findFirst({ where: { action, targetId }, orderBy: { createdAt: 'desc' } });

async function rider(phone: string, at = NEAR) {
  const s = await signInAs(ctx, phone, 'DELIVERY');
  const online = await s.browser.post(
    '/partner/me/online',
    { ...at, accuracyM: 10, recordedAt: ctx.clock.now().toISOString() },
    key(),
  );
  expect(online.status).toBe(200);
  const partnerId = (
    await ctx.prisma.deliveryPartner.findFirstOrThrow({ where: { user: { phone } } })
  ).id;
  return { ...s, phone, partnerId };
}
type Rider = Awaited<ReturnType<typeof rider>>;

/** A placed order (paid when ONLINE), still waiting for the restaurant. */
async function placed(
  opts: { paymentMethod?: 'COD' | 'ONLINE'; tipAmount?: number; quantity?: number } = {},
) {
  const c = await placeOrder(ctx, {
    branchId: saffron,
    items: [
      {
        foodItemId: ids['Paneer Biryani']!,
        optionIds: [ids.Mild!],
        quantity: opts.quantity ?? 1,
      },
    ],
    paymentMethod: opts.paymentMethod ?? 'ONLINE',
    tipAmount: opts.tipAmount ?? 0,
  });
  if ((opts.paymentMethod ?? 'ONLINE') === 'ONLINE') {
    const mock = ctx.container.paymentProvider as MockPaymentProvider;
    const paid = mock.pay(c.payment.providerOrderId, 'success');
    await c.browser.post(
      `/payments/${c.payment.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    await ctx.container.outboxRelay.runOnce();
  }
  return c;
}

/** Accepted by the restaurant; the delivery is created and dispatch has started. */
async function accepted(opts: Parameters<typeof placed>[0] = {}) {
  const c = await placed(opts);
  const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
  expect(
    (await manager.browser.post(`/merchant/orders/${c.orderId}/accept`, { prepMinutes: 12 }, key()))
      .status,
  ).toBe(200);
  await ctx.container.outboxRelay.runOnce();
  const d = await ctx.prisma.delivery.findUniqueOrThrow({ where: { orderId: c.orderId } });
  await ctx.container.dispatch.start(d.id);
  return { ...c, deliveryId: d.id, manager };
}

/** Accepted, and the rider takes the offer. */
async function assigned(r: Rider, opts: Parameters<typeof placed>[0] = {}) {
  const o = await accepted(opts);
  const offer = (await r.browser.get('/partner/offers/current')).body.data;
  expect(offer?.deliveryId).toBe(o.deliveryId);
  expect((await r.browser.post(`/partner/offers/${offer.offerId}/accept`, {}, key())).status).toBe(
    200,
  );
  return o;
}

/** Assigned and picked up. */
async function pickedUp(r: Rider, opts: Parameters<typeof placed>[0] = {}) {
  const o = await assigned(r, opts);
  await o.manager.browser.post(`/merchant/orders/${o.orderId}/ready`, {}, key());
  expect(
    (await r.browser.post(`/partner/deliveries/${o.deliveryId}/picked-up`, {}, key())).status,
  ).toBe(200);
  return o;
}

async function delivered(r: Rider, opts: Parameters<typeof placed>[0] = {}) {
  const o = await pickedUp(r, opts);
  const otp = deliveryCode(ctx.container.env.AUTH_HMAC_SECRET, o.orderId);
  const done = await r.browser.post(
    `/partner/deliveries/${o.deliveryId}/complete`,
    { method: 'OTP', otp, ...(opts.paymentMethod === 'COD' ? { cashCollected: true } : {}) },
    key(),
  );
  expect(done.status).toBe(200);
  return o;
}

const liability = (orderId: string) =>
  ctx.container.ledger.balance(ctx.prisma, {
    ownerType: 'ORDER',
    ownerId: orderId,
    type: 'CUSTOMER_ORDER_LIABILITY',
  });

suite('dashboard and alerts (API-ADM-001…003, FR-ADMIN-002)', () => {
  it('moves the day’s numbers after an order and acknowledges then resolves an alert', async () => {
    const admin = await staff(STAFF.admin);
    const before = (await admin.browser.get('/admin/dashboard')).body.data;
    expect(before).toMatchObject({
      users: { total: expect.any(Number), newToday: expect.any(Number) },
      restaurants: { total: expect.any(Number), activeNow: expect.any(Number) },
      partners: { total: expect.any(Number), onlineNow: expect.any(Number) },
      orders: { active: { PLACED: expect.any(Number) } },
      alerts: { bySeverity: { CRITICAL: expect.any(Number) } },
    });

    const r = await rider('+919000000401');
    const o = await delivered(r);
    const after = (await admin.browser.get('/admin/dashboard')).body.data;
    expect(after.orders.completedToday).toBe(before.orders.completedToday + 1);
    expect(after.gmv.today).toBeGreaterThan(before.gmv.today);
    expect(after.platformRevenue.today).toBeGreaterThan(before.platformRevenue.today);
    expect(after.users.total).toBeGreaterThan(before.users.total);
    expect(after.partners.onlineNow).toBeGreaterThanOrEqual(1);

    // Support agents see the dashboard too; customers never.
    const support = await staff(STAFF.support);
    expect((await support.browser.get('/admin/dashboard')).status).toBe(200);
    expect((await o.browser.get('/admin/dashboard')).status).toBe(403);

    const type = `TEST_ALERT_${Date.now()}`;
    await raiseOpsAlert(ctx.prisma, {
      type,
      severity: 'WARNING',
      message: 'Something needs a look',
      refType: 'order',
      refId: o.orderId,
      dedupeKey: `test:${type}`,
    });
    const open = await admin.browser.get('/admin/alerts', { type });
    expect(open.body.data).toHaveLength(1);
    const alertId = open.body.data[0].id;
    expect(open.body.data[0]).toMatchObject({
      status: 'OPEN',
      ref: { type: 'order', id: o.orderId },
    });
    expect((await admin.browser.get('/admin/dashboard')).body.data.alerts.byType[type]).toBe(1);

    const ack = await support.browser.post(`/admin/alerts/${alertId}/acknowledge`, {});
    expect(ack.body.data).toMatchObject({ status: 'ACKNOWLEDGED' });
    expect((await support.browser.post(`/admin/alerts/${alertId}/acknowledge`, {})).status).toBe(
      409,
    );
    const resolved = await admin.browser.post(`/admin/alerts/${alertId}/acknowledge`, {
      resolve: true,
      note: 'Customer called back',
    });
    expect(resolved.body.data).toMatchObject({
      status: 'RESOLVED',
      resolvedAt: expect.any(String),
    });
    expect((await admin.browser.get('/admin/alerts', { type })).body.data).toHaveLength(0);
    expect(
      (await admin.browser.get('/admin/alerts', { type, status: 'RESOLVED' })).body.data,
    ).toHaveLength(1);
    expect(await audited('admin.alert_resolved', alertId)).toMatchObject({
      reason: 'Customer called back',
    });
  });
});

suite('orders (API-ADM-060…065, 067, FR-ADMIN-040/041)', () => {
  it('searches by number and phone with masked PII, and shows the order 360', async () => {
    const r = await rider('+919000000401');
    const o = await delivered(r);
    const support = await staff(STAFF.support);
    const number = o.order.number as string;
    const byNumber = await support.browser.get('/admin/orders', { q: number });
    expect(byNumber.body.data).toHaveLength(1);
    expect(byNumber.body.data[0]).toMatchObject({
      id: o.orderId,
      status: 'DELIVERED',
      customer: { phone: `+91XXXXXX${o.phone.slice(-4)}` },
      delivery: { partner: { id: r.partnerId } },
    });
    const byPhone = await support.browser.get('/admin/orders', { q: o.phone });
    expect(byPhone.body.data.map((x: { id: string }) => x.id)).toContain(o.orderId);
    const byPartner = await support.browser.get('/admin/orders', {
      partnerId: r.partnerId,
      status: 'DELIVERED',
      pageSize: 100,
    });
    expect(byPartner.body.data.map((x: { id: string }) => x.id)).toContain(o.orderId);

    const detail = (await support.browser.get(`/admin/orders/${o.orderId}`)).body.data;
    expect(detail).toMatchObject({
      number,
      status: 'DELIVERED',
      payments: [
        { status: 'CAPTURED', attempts: [expect.objectContaining({ status: 'CAPTURED' })] },
      ],
      delivery: {
        status: 'DELIVERED',
        partner: { id: r.partnerId },
        assignments: [expect.objectContaining({ status: 'ACCEPTED', manual: false })],
      },
    });
    expect(detail.items[0]).toMatchObject({ name: 'Paneer Biryani', quantity: 1 });
    expect(detail.statusHistory.map((h: { to: string }) => h.to)).toEqual(
      expect.arrayContaining(['PLACED', 'ACCEPTED', 'PICKED_UP', 'DELIVERED']),
    );
    expect(JSON.stringify(detail)).not.toContain(o.phone);
  });

  it('cancels with fault attribution and a full refund, audited high (AC-ADMIN-002)', async () => {
    const o = await placed();
    const support = await staff(STAFF.support);
    expect(
      (
        await support.browser.post(`/admin/orders/${o.orderId}/cancel`, {
          reasonCode: 'RESTAURANT_UNRESPONSIVE',
          fault: 'RESTAURANT',
          reason: 'Restaurant not answering calls',
        })
      ).status,
    ).toBe(403);
    const admin = await staff(STAFF.admin);
    expect(
      (
        await admin.browser.post(`/admin/orders/${o.orderId}/cancel`, {
          reasonCode: 'RESTAURANT_UNRESPONSIVE',
          fault: 'RESTAURANT',
        })
      ).status,
    ).toBe(400);
    const res = await admin.browser.post(`/admin/orders/${o.orderId}/cancel`, {
      reasonCode: 'RESTAURANT_UNRESPONSIVE',
      fault: 'RESTAURANT',
      reason: 'Restaurant not answering calls',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      order: { status: 'CANCELLED' },
      cancellation: {
        fault: 'RESTAURANT',
        fee: 0,
        refund: { amount: o.payable, toSource: o.payable },
      },
    });
    expect(
      await ctx.prisma.orderCancellation.findUnique({ where: { orderId: o.orderId } }),
    ).toMatchObject({ initiatorType: 'ADMIN', fault: 'RESTAURANT' });
    expect(await ctx.prisma.refund.findFirst({ where: { orderId: o.orderId } })).toMatchObject({
      amount: o.payable,
      costBearer: 'RESTAURANT',
      reasonCode: 'CANCELLED_RESTAURANT',
    });
    expect(await audited('admin.order_cancelled', o.orderId)).toMatchObject({
      reason: 'Restaurant not answering calls',
      sensitivity: 'HIGH',
    });
    const trail = (await admin.browser.get(`/admin/orders/${o.orderId}/audit`)).body.data;
    expect(trail.audit.map((a: { action: string }) => a.action)).toContain('admin.order_cancelled');
    expect(trail.statusHistory.at(-1)).toMatchObject({ to: 'CANCELLED', actorType: 'ADMIN' });
    // audit:read is not a support-agent permission.
    expect((await support.browser.get(`/admin/orders/${o.orderId}/audit`)).status).toBe(403);
  });

  it('marks a COD order delivered for the partner and settles it (T15 by admin)', async () => {
    const r = await rider('+919000000401');
    const o = await pickedUp(r, { paymentMethod: 'COD' });
    const admin = await staff(STAFF.admin);
    const noCash = await admin.browser.post(`/admin/orders/${o.orderId}/mark-delivered`, {
      reason: 'Customer confirmed on call; app crashed',
    });
    expect(noCash.status).toBe(400);
    const res = await admin.browser.post(`/admin/orders/${o.orderId}/mark-delivered`, {
      reason: 'Customer confirmed on call; app crashed',
      cashCollected: true,
    });
    expect(res.body.data).toMatchObject({ status: 'DELIVERED' });
    expect(
      await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } }),
    ).toMatchObject({ status: 'DELIVERED', proofType: 'ADMIN' });
    expect(await ctx.prisma.payment.findFirst({ where: { orderId: o.orderId } })).toMatchObject({
      status: 'COLLECTED',
    });
    expect(await liability(o.orderId)).toBe(0);
    expect(
      await ctx.prisma.partnerEarning.findUnique({ where: { deliveryId: o.deliveryId } }),
    ).toMatchObject({ partnerId: r.partnerId });
    expect(
      await ctx.prisma.orderStatusHistory.findFirst({
        where: { orderId: o.orderId, toStatus: 'DELIVERED' },
      }),
    ).toMatchObject({ actorType: 'ADMIN', reason: 'Customer confirmed on call; app crashed' });
    expect((await ctx.container.presence.get(r.partnerId))?.state).toBe('ONLINE_IDLE');
    expect(await ctx.container.ledger.verify()).toEqual([]);
    expect(
      (
        await admin.browser.post(`/admin/orders/${o.orderId}/mark-delivered`, {
          reason: 'Trying a second time',
          cashCollected: true,
        })
      ).status,
    ).toBe(409);
  });

  it('marks deliveries failed: unreachable returns only the tip; a lost order refunds everything (T16)', async () => {
    const r = await rider('+919000000401');
    const admin = await staff(STAFF.admin);
    const o = await pickedUp(r, { tipAmount: 3_000 });
    const res = await admin.browser.post(`/admin/orders/${o.orderId}/mark-failed`, {
      cause: 'CUSTOMER_UNREACHABLE',
      reason: 'Waited 10 minutes; 3 calls unanswered',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'FAILED',
      failureReason: 'CUSTOMER_UNREACHABLE',
      refunds: [{ amount: 3_000, destination: 'SOURCE' }],
    });
    expect(await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({
      status: 'FAILED',
      failureReason: 'CUSTOMER_UNREACHABLE',
    });
    expect(
      (await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } })).status,
    ).toBe('FAILED');
    // The restaurant is paid as if delivered; the partner is paid for the trip.
    expect(
      await ctx.prisma.ledgerTransaction.count({
        where: { type: 'ORDER_SETTLEMENT', referenceId: o.orderId },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.partnerEarning.findUnique({ where: { deliveryId: o.deliveryId } }),
    ).toMatchObject({ partnerId: r.partnerId });

    const lost = await pickedUp(r, { paymentMethod: 'ONLINE' });
    const failed = await admin.browser.post(`/admin/orders/${lost.orderId}/mark-failed`, {
      cause: 'DELIVERY_FAILED',
      reason: 'Partner had an accident; food lost',
    });
    expect(failed.body.data.refunds).toEqual([
      expect.objectContaining({ amount: lost.payable, destination: 'SOURCE' }),
    ]);
    // Refunds settle through the provider; the liability empties once they succeed.
    for (const id of [o.orderId, lost.orderId]) {
      const refunds = await ctx.prisma.refund.findMany({ where: { orderId: id } });
      for (const rf of refunds) await ctx.container.refunds.submit(rf.id);
      for (const rf of await ctx.prisma.refund.findMany({ where: { orderId: id } }))
        await ctx.container.refunds.applyProviderRefund({
          providerRefundId: rf.providerRefundId!,
          providerPaymentId: 'pay_test',
          status: 'PROCESSED',
          amount: rf.amount,
        });
      expect(await liability(id)).toBe(0);
    }
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('extends the acceptance timeout once (API-ADM-065)', async () => {
    const o = await placed();
    const support = await staff(STAFF.support);
    const res = await support.browser.post(`/admin/orders/${o.orderId}/extend-acceptance`, {
      minutes: 5,
      reason: 'Restaurant asked for more time',
    });
    expect(res.status).toBe(200);
    const acceptBy = new Date(res.body.data.acceptBy);
    expect(
      (ctx.container.jobs as RecordingJobQueue).jobs.find(
        (j) => j.jobId === `${ORDER_JOBS.acceptTimeout}-ext-${o.orderId}`,
      ),
    ).toBeTruthy();
    expect(
      (
        await support.browser.post(`/admin/orders/${o.orderId}/extend-acceptance`, {
          reason: 'And a bit more please',
        })
      ).status,
    ).toBe(409);

    // The original timeout fires but finds the window extended.
    ctx.clock.advance(6 * 60_000);
    await ctx.container.orderTimerJobs.run(ORDER_JOBS.acceptTimeout, o.orderId);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe(
      'PLACED',
    );
    ctx.clock.set(new Date(acceptBy.getTime() + 1_000));
    await ctx.container.orderTimerJobs.run(ORDER_JOBS.acceptTimeout, o.orderId);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe(
      'CANCELLED',
    );
  });
});

suite('dispatch board (API-ADM-070…075, API-DPDEL-012, FR-DISP-009…012)', () => {
  it('lists, ranks candidates and assigns manually; the partner acknowledges', async () => {
    const a = await rider('+919000000401');
    const b = await rider('+919000000402', { lat: 12.938, lng: 77.627 });
    const o = await accepted();
    // Automatic dispatch offered the delivery to someone.
    expect(
      await ctx.prisma.deliveryAssignment.count({
        where: { deliveryId: o.deliveryId, status: 'OFFERED' },
      }),
    ).toBe(1);
    const support = await staff(STAFF.support);
    const board = await support.browser.get('/admin/deliveries', { status: 'SEARCHING' });
    expect(board.body.data.map((d: { id: string }) => d.id)).toContain(o.deliveryId);
    expect((await support.browser.get(`/admin/deliveries/${o.deliveryId}/candidates`)).status).toBe(
      403,
    );

    const admin = await staff(STAFF.admin);
    const offered = await ctx.prisma.deliveryAssignment.findFirstOrThrow({
      where: { deliveryId: o.deliveryId, status: 'OFFERED' },
    });
    const other = offered.partnerId === a.partnerId ? b : a;
    const candidates = (await admin.browser.get(`/admin/deliveries/${o.deliveryId}/candidates`))
      .body.data;
    expect(candidates.map((c: { partnerId: string }) => c.partnerId)).toContain(other.partnerId);
    expect(candidates[0]).toMatchObject({ rank: 1, score: expect.any(Number) });

    const res = await admin.browser.post(`/admin/deliveries/${o.deliveryId}/assign`, {
      partnerId: other.partnerId,
      reason: 'Closest rider who knows the building',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'ASSIGNED',
      partnerId: other.partnerId,
      acknowledgeBy: expect.any(String),
    });
    // The open offer was withdrawn; the manual assignment is ACCEPTED.
    expect(
      (await ctx.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: offered.id } })).status,
    ).toBe('WITHDRAWN');
    expect(
      await ctx.prisma.deliveryAssignment.findFirst({
        where: { deliveryId: o.deliveryId, status: 'ACCEPTED' },
      }),
    ).toMatchObject({ partnerId: other.partnerId, manual: true, assignedBy: admin.userId });
    expect(await audited('admin.delivery_assigned', o.deliveryId)).toMatchObject({
      sensitivity: 'HIGH',
    });

    const notMine = await (other === a ? b : a).browser.post(
      `/partner/deliveries/${o.deliveryId}/acknowledge`,
      {},
      key(),
    );
    expect(notMine.status).toBe(404);
    const ack = await other.browser.post(
      `/partner/deliveries/${o.deliveryId}/acknowledge`,
      {},
      key(),
    );
    expect(ack.body.data).toMatchObject({
      deliveryId: o.deliveryId,
      acknowledgedAt: expect.any(String),
    });
    ctx.clock.advance(2 * 60_000);
    expect(await ctx.container.dispatch.releaseUnacknowledged()).toBe(0);
    expect(
      (await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } })).partnerId,
    ).toBe(other.partnerId);

    // One active delivery per partner, even when forced.
    const o2 = await accepted();
    const busy = await admin.browser.post(`/admin/deliveries/${o2.deliveryId}/assign`, {
      partnerId: other.partnerId,
      force: true,
      reason: 'Trying to double-book',
    });
    expect(busy.body.error.code).toBe('PARTNER_UNAVAILABLE');
  });

  it('gives an unacknowledged manual assignment back to dispatch and alerts ops', async () => {
    const a = await rider('+919000000401');
    const o = await accepted();
    // a holds the automatic offer; take it away by assigning a directly instead.
    const res = await (
      await staff(STAFF.admin)
    ).browser.post(`/admin/deliveries/${o.deliveryId}/assign`, {
      partnerId: a.partnerId,
      force: true,
      reason: 'Rider is right outside',
    });
    expect(res.body.data).toMatchObject({ status: 'ASSIGNED', partnerId: a.partnerId });
    ctx.clock.advance(61_000);
    expect(await ctx.container.dispatch.releaseUnacknowledged()).toBe(1);
    expect(
      await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } }),
    ).toMatchObject({ status: 'SEARCHING', partnerId: null });
    expect(
      await ctx.prisma.deliveryAssignment.findFirst({
        where: { deliveryId: o.deliveryId, manual: true },
      }),
    ).toMatchObject({ status: 'RELEASED' });
    expect(
      await ctx.prisma.opsAlert.count({
        where: { type: 'MANUAL_ASSIGNMENT_UNACKNOWLEDGED', refId: o.deliveryId },
      }),
    ).toBe(1);
    // Too late to acknowledge now.
    expect(
      (await a.browser.post(`/partner/deliveries/${o.deliveryId}/acknowledge`, {}, key())).status,
    ).toBe(404);
  });

  it('reassigns (previous partner REVOKED), re-dispatches and extends the deadline once', async () => {
    const a = await rider('+919000000401');
    const b = await rider('+919000000402', { lat: 12.938, lng: 77.627 });
    const o = await accepted();
    const offer = await ctx.prisma.deliveryAssignment.findFirstOrThrow({
      where: { deliveryId: o.deliveryId, status: 'OFFERED' },
    });
    const holder = offer.partnerId === a.partnerId ? a : b;
    const other = holder === a ? b : a;
    await holder.browser.post(`/partner/offers/${offer.id}/accept`, {}, key());
    const admin = await staff(STAFF.admin);

    const res = await admin.browser.post(`/admin/deliveries/${o.deliveryId}/reassign`, {
      partnerId: other.partnerId,
      reason: 'Assigned rider is stuck in traffic',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      partnerId: other.partnerId,
      previousPartnerId: holder.partnerId,
    });
    expect(
      (await ctx.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: offer.id } })).status,
    ).toBe('REVOKED');
    expect((await ctx.container.presence.get(holder.partnerId))?.state).toBe('ONLINE_IDLE');
    await other.browser.post(`/partner/deliveries/${o.deliveryId}/acknowledge`, {}, key());

    // Re-dispatch takes it from `other` and offers it again automatically.
    const again = await admin.browser.post(`/admin/deliveries/${o.deliveryId}/redispatch`, {
      reason: 'Let dispatch pick again',
    });
    expect(again.body.data).toMatchObject({ status: 'SEARCHING' });
    expect(
      await ctx.prisma.deliveryAssignment.count({
        where: { deliveryId: o.deliveryId, partnerId: other.partnerId, status: 'REVOKED' },
      }),
    ).toBe(1);
    expect(await audited('admin.delivery_redispatched', o.deliveryId)).toBeTruthy();

    const d = await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } });
    const ext = await admin.browser.post(`/admin/deliveries/${o.deliveryId}/extend-deadline`, {
      minutes: 20,
      reason: 'Heavy rain; riders slow to log in',
    });
    expect(ext.status).toBe(200);
    expect(new Date(ext.body.data.noPartnerDeadline).getTime()).toBe(
      d.noPartnerDeadline!.getTime() + 20 * 60_000,
    );
    expect(
      (
        await admin.browser.post(`/admin/deliveries/${o.deliveryId}/extend-deadline`, {
          reason: 'Once more please',
        })
      ).status,
    ).toBe(409);
  });
});

suite('payments and refunds (API-ADM-080…087, FR-ADMIN-050/051, FR-REFUND-008)', () => {
  it('lists and syncs payments and shows the webhook log', async () => {
    const o = await placed();
    const admin = await staff(STAFF.admin);
    const list = await admin.browser.get('/admin/payments', { q: o.order.number });
    expect(list.body.data[0]).toMatchObject({
      id: o.payment.paymentId,
      status: 'CAPTURED',
      order: { id: o.orderId },
    });
    const detail = (await admin.browser.get(`/admin/payments/${o.payment.paymentId}`)).body.data;
    expect(detail.attempts[0]).toMatchObject({ status: 'CAPTURED' });
    const synced = await admin.browser.post(`/admin/payments/${o.payment.paymentId}/sync`, {
      reason: 'Customer says charged twice',
    });
    expect(synced.body.data).toMatchObject({ status: 'CAPTURED', sync: { seen: 1 } });
    expect(await audited('admin.payment_synced', o.payment.paymentId)).toMatchObject({
      sensitivity: 'HIGH',
    });
    expect((await admin.browser.get('/admin/webhook-events')).status).toBe(200);
    const support = await staff(STAFF.support);
    expect(
      (
        await support.browser.post(`/admin/payments/${o.payment.paymentId}/sync`, {
          reason: 'Customer says charged twice',
        })
      ).status,
    ).toBe(403);
  });

  it('refunds to wallet and source, never past what was paid', async () => {
    const r = await rider('+919000000401');
    const o = await delivered(r);
    const admin = await staff(STAFF.admin);
    expect(
      (
        await admin.browser.post(`/admin/orders/${o.orderId}/refunds`, {
          amount: 5_000,
          destination: 'WALLET',
          reasonCode: 'GOODWILL',
          note: 'Late delivery goodwill',
          costBearer: 'PLATFORM',
        })
      ).status,
    ).toBe(400); // Idempotency-Key required
    const wallet = await admin.browser.post(
      `/admin/orders/${o.orderId}/refunds`,
      {
        amount: 5_000,
        destination: 'WALLET',
        reasonCode: 'GOODWILL',
        note: 'Late delivery goodwill',
        costBearer: 'PLATFORM',
      },
      key(),
    );
    expect(wallet.status).toBe(201);
    expect(wallet.body.data.refund).toMatchObject({ status: 'SUCCEEDED', amount: 5_000 });
    expect(
      await ctx.container.ledger.balance(ctx.prisma, {
        ownerType: 'CUSTOMER',
        ownerId: o.userId,
        type: 'CUSTOMER_WALLET',
      }),
    ).toBe(5_000);

    const item = await ctx.prisma.orderItem.findFirstOrThrow({ where: { orderId: o.orderId } });
    const source = await admin.browser.post(
      `/admin/orders/${o.orderId}/refunds`,
      {
        amount: 10_000,
        items: [{ orderItemId: item.id, quantity: 1 }],
        destination: 'SOURCE',
        reasonCode: 'ITEM_MISSING',
        note: 'Raita missing from the bag',
        costBearer: 'RESTAURANT',
      },
      key(),
    );
    expect(source.body.data.refund).toMatchObject({
      status: 'PROCESSING',
      paymentId: o.payment.paymentId,
    });
    expect(
      await ctx.prisma.refundItem.count({ where: { refundId: source.body.data.refund.id } }),
    ).toBe(1);

    const tooMuch = await admin.browser.post(
      `/admin/orders/${o.orderId}/refunds`,
      {
        amount: o.payable,
        destination: 'WALLET',
        reasonCode: 'GOODWILL',
        note: 'Refund everything',
        costBearer: 'PLATFORM',
      },
      key(),
    );
    expect(tooMuch.body.error).toMatchObject({
      code: 'REFUND_EXCEEDS_REFUNDABLE',
      details: [{ message: String(o.payable - 15_000) }],
    });
    const list = await admin.browser.get('/admin/refunds', { status: 'SUCCEEDED' });
    expect(list.body.data.map((x: { id: string }) => x.id)).toContain(wallet.body.data.refund.id);

    // Refunds of an in-flight order go through cancellation instead.
    const live = await placed();
    expect(
      (
        await admin.browser.post(
          `/admin/orders/${live.orderId}/refunds`,
          {
            amount: 1_000,
            destination: 'WALLET',
            reasonCode: 'GOODWILL',
            note: 'Too early for this',
            costBearer: 'PLATFORM',
          },
          key(),
        )
      ).body.error.code,
    ).toBe('ORDER_STATE_CONFLICT');
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('holds support refunds above the limit for approval, and retries failed ones', async () => {
    const r = await rider('+919000000401');
    const o = await delivered(r, { quantity: 2 });
    const support = await staff(STAFF.support);
    const body = (amount: number, extra: object = {}) => ({
      amount,
      destination: 'WALLET',
      reasonCode: 'FOOD_QUALITY',
      note: 'Food arrived cold',
      costBearer: 'RESTAURANT',
      ...extra,
    });
    const within = await support.browser.post(
      `/admin/orders/${o.orderId}/refunds`,
      body(40_000),
      key(),
    );
    expect(within.body.data.refund).toMatchObject({ status: 'SUCCEEDED' });
    const over = await support.browser.post(
      `/admin/orders/${o.orderId}/refunds`,
      body(20_000),
      key(),
    );
    expect(over.body.error).toMatchObject({ code: 'REFUND_LIMIT_EXCEEDED' });
    const requested = await support.browser.post(
      `/admin/orders/${o.orderId}/refunds`,
      body(20_000, { requestApproval: true }),
      key(),
    );
    expect(requested.status).toBe(201);
    const refundId = requested.body.data.refund.id;
    expect(requested.body.data.refund).toMatchObject({ status: 'REQUESTED' });
    expect(
      (
        await support.browser.post(`/admin/refunds/${refundId}/approve`, {
          reason: 'Approving mine',
        })
      ).status,
    ).toBe(403);
    const admin = await staff(STAFF.admin);
    const approved = await admin.browser.post(`/admin/refunds/${refundId}/approve`, {
      reason: 'Checked the photos',
    });
    expect(approved.body.data.refund).toMatchObject({ status: 'SUCCEEDED' });
    expect(
      (await admin.browser.post(`/admin/refunds/${refundId}/approve`, { reason: 'Approve again' }))
        .body.error.code,
    ).toBe('REFUND_STATE_CONFLICT');
    expect(await audited('admin.refund_approved', refundId)).toMatchObject({
      actorUserId: admin.userId,
    });

    // A source refund the provider gave up on goes back with fresh attempts.
    const src = await admin.browser.post(
      `/admin/orders/${o.orderId}/refunds`,
      { ...body(1_000), destination: 'SOURCE', costBearer: 'PLATFORM' },
      key(),
    );
    const srcId = src.body.data.refund.id;
    await ctx.prisma.refund.update({
      where: { id: srcId },
      data: { status: 'FAILED', providerRefundId: null, attempts: 5 },
    });
    const retried = await support.browser.post(`/admin/refunds/${srcId}/retry`, {
      reason: 'Provider outage is over',
    });
    expect(retried.body.data.refund).toMatchObject({ status: 'PROCESSING', attempts: 1 });
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });
});

suite('payout batches (API-ADM-091…097, FR-SETTLE-002/003, BR-EARN-004…006)', () => {
  it('creates, approves (maker ≠ checker), exports and pays a partner batch net of cash in hand', async () => {
    const r = await rider('+919000000404');
    // A partner with COD cash in hand and enough earnings to be paid.
    await delivered(r, { paymentMethod: 'COD' });
    const admin = await staff(STAFF.admin);
    const superAdmin = await staff(STAFF.superAdmin);
    await admin.browser.post(
      `/admin/partners/${r.partnerId}/earning-adjustments`,
      { amount: 900_000, note: 'Weekly incentive', reason: 'Incentive programme payout' },
      key(),
    );
    await ctx.prisma.partnerBankAccount.updateMany({
      where: { partnerId: r.partnerId, status: { in: ['VERIFIED', 'PENDING_VERIFICATION'] } },
      data: { status: 'SUPERSEDED' },
    });
    await ctx.prisma.partnerBankAccount.create({
      data: {
        partnerId: r.partnerId,
        holderName: 'Test Rider',
        accountNumberEncrypted: Buffer.from('encrypted'),
        accountLast4: '4321',
        ifsc: 'HDFC0001234',
        status: 'VERIFIED',
        verifiedAt: ctx.clock.now(),
      },
    });
    const payable = {
      ownerType: 'PARTNER' as const,
      ownerId: r.partnerId,
      type: 'PARTNER_PAYABLE' as const,
    };
    const earned = await ctx.container.ledger.balance(ctx.prisma, payable);
    const cash = await ctx.container.partnerAvailability.cashInHand(r.partnerId);
    expect(cash).toBeGreaterThan(0);

    const week = periodBounds('week', ctx.clock.now());
    const support = await staff(STAFF.support);
    expect(
      (
        await support.browser.post(
          '/admin/payout-batches',
          { type: 'PARTNER', periodStart: week.from.toISOString(), reason: 'Weekly payouts' },
          key(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.browser.post(
          '/admin/payout-batches',
          {
            type: 'PARTNER',
            periodStart: new Date(week.from.getTime() + 3_600_000).toISOString(),
            reason: 'Weekly payouts',
          },
          key(),
        )
      ).body.error.code,
    ).toBe('VALIDATION_ERROR');
    const created = await admin.browser.post(
      '/admin/payout-batches',
      { type: 'PARTNER', periodStart: week.from.toISOString(), reason: 'Weekly payouts' },
      key(),
    );
    expect(created.status).toBe(201);
    const batch = created.body.data;
    expect(batch).toMatchObject({ type: 'PARTNER', status: 'DRAFT', createdBy: admin.userId });
    const line = batch.lines.find((l: { payee: { id: string } }) => l.payee.id === r.partnerId);
    expect(line).toMatchObject({
      amount: earned - cash,
      cashDeduction: cash,
      status: 'PENDING',
      bank: { accountMasked: 'XXXXXX4321', ifsc: 'HDFCXXXXXXX' },
    });
    expect(
      (
        await admin.browser.post(
          '/admin/payout-batches',
          { type: 'PARTNER', periodStart: week.from.toISOString(), reason: 'Weekly payouts' },
          key(),
        )
      ).body.error.code,
    ).toBe('PAYOUT_STATE_CONFLICT');

    expect((await admin.browser.get(`/admin/payout-batches/${batch.id}/export`)).status).toBe(409);
    expect(
      (
        await admin.browser.post(`/admin/payout-batches/${batch.id}/approve`, {
          reason: 'Looks right',
        })
      ).body.error.code,
    ).toBe('FORBIDDEN');
    expect(
      (
        await admin.browser.post(
          `/admin/payout-batches/${batch.id}/lines/${line.id}/mark-paid`,
          { utr: 'UTR12345678', reason: 'Bank confirmed' },
          key(),
        )
      ).body.error.code,
    ).toBe('PAYOUT_STATE_CONFLICT');
    const approved = await superAdmin.browser.post(`/admin/payout-batches/${batch.id}/approve`, {
      reason: 'Totals reconciled',
    });
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', approvedBy: superAdmin.userId });

    const exported = (await superAdmin.browser.get(`/admin/payout-batches/${batch.id}/export`)).body
      .data;
    expect(exported.contentType).toBe('text/csv');
    expect(exported.csv.split('\n')[0]).toContain('payout_id,payee_type');
    expect(exported.csv).toContain(`${line.id},PARTNER,${r.partnerId}`);
    expect(exported.csv).toContain('XXXXXX4321');
    expect(exported.csv).not.toContain('HDFC0001234');

    const paid = await admin.browser.post(
      `/admin/payout-batches/${batch.id}/lines/${line.id}/mark-paid`,
      { utr: 'UTR12345678', reason: 'Bank confirmed the transfer' },
      key(),
    );
    expect(paid.status).toBe(200);
    expect(paid.body.data.lines.find((l: { id: string }) => l.id === line.id)).toMatchObject({
      status: 'PAID',
      utr: 'UTR12345678',
    });
    expect(['PROCESSING', 'PAID']).toContain(paid.body.data.status);
    // The payable and the cash in hand are both settled; the money left through clearing.
    expect(await ctx.container.ledger.balance(ctx.prisma, payable)).toBe(0);
    expect(await ctx.container.partnerAvailability.cashInHand(r.partnerId)).toBe(0);
    expect(await ctx.container.ledger.verify()).toEqual([]);

    const mine = (await r.browser.get('/partner/me/payouts')).body.data;
    expect(mine.items[0]).toMatchObject({
      id: line.id,
      amount: earned - cash,
      cashDeduction: cash,
      status: 'PAID',
      utr: 'UTR12345678',
    });
    expect((await r.browser.get(`/partner/me/payouts/${line.id}`)).body.data).toMatchObject({
      bank: { accountMasked: 'XXXXXX4321' },
    });
    const listed = await admin.browser.get('/admin/payout-batches', { type: 'PARTNER' });
    expect(listed.body.data.map((b: { id: string }) => b.id)).toContain(batch.id);
  });

  it('records a failed restaurant line, then pays it on retry; the batch ends PAID', async () => {
    await ctx.prisma.restaurantBankAccount.updateMany({
      where: { restaurantId: saffronRestaurant, status: 'PENDING_VERIFICATION' },
      data: { status: 'SUPERSEDED' },
    });
    if (
      !(await ctx.prisma.restaurantBankAccount.count({
        where: { restaurantId: saffronRestaurant, status: 'VERIFIED' },
      }))
    ) {
      const bank = await ctx.prisma.restaurantBankAccount.create({
        data: {
          restaurantId: saffronRestaurant,
          holderName: 'Saffron Foods',
          accountNumberEncrypted: Buffer.from('encrypted'),
          accountLast4: '9876',
          ifsc: 'ICIC0000123',
          status: 'VERIFIED',
          verifiedAt: ctx.clock.now(),
        },
      });
      verifiedBanks.push(bank.id);
    }
    const owed = await ctx.container.ledger.balance(ctx.prisma, {
      ownerType: 'RESTAURANT',
      ownerId: saffronRestaurant,
      type: 'RESTAURANT_PAYABLE',
    });
    expect(owed).toBeGreaterThan(0);
    const admin = await staff(STAFF.admin);
    const superAdmin = await staff(STAFF.superAdmin);
    // Default: the last completed Monday–Sunday week.
    const created = await admin.browser.post(
      '/admin/payout-batches',
      { type: 'RESTAURANT', reason: 'Weekly restaurant settlements' },
      key(),
    );
    const batch = created.body.data;
    expect(new Date(batch.periodStart).getTime()).toBe(
      periodBounds('week', new Date(ctx.clock.now().getTime() - 7 * 86_400_000)).from.getTime(),
    );
    const line = batch.lines.find(
      (l: { payee: { id: string } }) => l.payee.id === saffronRestaurant,
    );
    expect(line).toMatchObject({ amount: owed, cashDeduction: 0 });
    await superAdmin.browser.post(`/admin/payout-batches/${batch.id}/approve`, {
      reason: 'Totals reconciled',
    });

    const failed = await admin.browser.post(
      `/admin/payout-batches/${batch.id}/lines/${line.id}/mark-failed`,
      { reason: 'Beneficiary account closed' },
    );
    expect(failed.body.data.lines.find((l: { id: string }) => l.id === line.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'Beneficiary account closed',
    });
    for (const other of batch.lines.filter((l: { id: string }) => l.id !== line.id))
      await admin.browser.post(
        `/admin/payout-batches/${batch.id}/lines/${other.id}/mark-paid`,
        { utr: `UTR${other.id.replace(/-/g, '').slice(0, 12)}`, reason: 'Bank confirmed' },
        key(),
      );
    expect((await admin.browser.get(`/admin/payout-batches/${batch.id}`)).body.data.status).toBe(
      'PARTIALLY_FAILED',
    );
    // Nothing moved for the failed line.
    expect(
      await ctx.container.ledger.balance(ctx.prisma, {
        ownerType: 'RESTAURANT',
        ownerId: saffronRestaurant,
        type: 'RESTAURANT_PAYABLE',
      }),
    ).toBe(owed);
    const retried = await admin.browser.post(
      `/admin/payout-batches/${batch.id}/lines/${line.id}/mark-paid`,
      { utr: 'UTRRETRY0001', reason: 'Paid to the new account' },
      key(),
    );
    expect(retried.body.data.status).toBe('PAID');
    expect(
      await ctx.container.ledger.balance(ctx.prisma, {
        ownerType: 'RESTAURANT',
        ownerId: saffronRestaurant,
        type: 'RESTAURANT_PAYABLE',
      }),
    ).toBe(0);
    expect(await audited('admin.payout_failed', line.id)).toMatchObject({ sensitivity: 'HIGH' });
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });
});
