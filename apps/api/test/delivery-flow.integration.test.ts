import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { deliveryCode } from '../src/modules/orders';
import type { MockPaymentProvider } from '../src/modules/payments';
import type { RecordingJobQueue } from '../src/platform/jobs';
import {
  branchId,
  createTestContext,
  integrationEnabled,
  parkActiveDeliveries,
  placeOrder,
  pushes,
  SAFFRON_STAFF,
  signInAs,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
const ids: Record<string, string> = {};
const BRANCH = { lat: 12.935, lng: 77.6241 };
const HOME = { lat: 12.9352, lng: 77.6245 };

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
  (ctx.container.jobs as RecordingJobQueue).jobs.length = 0;
  await parkActiveDeliveries(ctx);
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

const key = () => ({ 'Idempotency-Key': uuidv7() });

async function rider(phone: string, at = { lat: 12.9355, lng: 77.6245 }) {
  const s = await signInAs(ctx, phone, 'DELIVERY');
  await s.browser.post(
    '/partner/me/online',
    { ...at, accuracyM: 10, recordedAt: ctx.clock.now().toISOString() },
    key(),
  );
  return {
    ...s,
    partnerId: (await ctx.prisma.deliveryPartner.findFirstOrThrow({ where: { user: { phone } } }))
      .id,
  };
}

/** Order placed, accepted, delivery searching and accepted by `r`. */
async function assigned(
  r: Awaited<ReturnType<typeof rider>>,
  opts: { paymentMethod?: 'COD' | 'ONLINE'; tipAmount?: number } = {},
) {
  const c = await placeOrder(ctx, {
    branchId: saffron,
    items: [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 1 }],
    paymentMethod: opts.paymentMethod ?? 'COD',
    tipAmount: opts.tipAmount ?? 0,
  });
  if (opts.paymentMethod === 'ONLINE') {
    const mock = ctx.container.paymentProvider as MockPaymentProvider;
    const paid = mock.pay(c.payment.providerOrderId, 'success');
    await c.browser.post(
      `/payments/${c.payment.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    await ctx.container.outboxRelay.runOnce();
  }
  const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
  expect(
    (await manager.browser.post(`/merchant/orders/${c.orderId}/accept`, { prepMinutes: 12 }, key()))
      .status,
  ).toBe(200);
  await ctx.container.outboxRelay.runOnce();
  const d = await ctx.prisma.delivery.findUniqueOrThrow({ where: { orderId: c.orderId } });
  await ctx.container.dispatch.start(d.id);
  const offer = (await r.browser.get('/partner/offers/current')).body.data;
  expect((await r.browser.post(`/partner/offers/${offer.offerId}/accept`, {}, key())).status).toBe(
    200,
  );
  return { ...c, deliveryId: d.id, manager };
}

const liability = (orderId: string) =>
  ctx.container.ledger.balance(ctx.prisma, {
    ownerType: 'ORDER',
    ownerId: orderId,
    type: 'CUSTOMER_ORDER_LIABILITY',
  });

suite('the trip (API-DPDEL-004…011, FR-DEL-020…035, T13/T15)', () => {
  it('runs a COD order from the restaurant to the door, with geofences, OTP and cash', async () => {
    const r = await rider('+919000000401');
    const o = await assigned(r);
    const b = r.browser;
    const active = (await b.get('/partner/deliveries/active')).body.data;
    expect(active).toMatchObject({
      id: o.deliveryId,
      status: 'ASSIGNED',
      pickupCode: expect.stringMatching(/^\d{4}$/),
      payment: { type: 'COD', collect: o.payable },
      proof: 'OTP',
    });

    // Far from the restaurant: needs a confirmation and is flagged.
    const far = { lat: 12.95, lng: 77.64 };
    expect(
      (
        await b.post(
          `/partner/deliveries/${o.deliveryId}/arrived-at-restaurant`,
          { at: far },
          key(),
        )
      ).body.error.code,
    ).toBe('GEOFENCE_CONFIRMATION_REQUIRED');
    await b.post(
      `/partner/deliveries/${o.deliveryId}/arrived-at-restaurant`,
      { at: far, confirm: true },
      key(),
    );
    expect(
      await ctx.prisma.deliveryStatusHistory.findFirst({
        where: { deliveryId: o.deliveryId, toStatus: 'AT_RESTAURANT' },
      }),
    ).toMatchObject({ flagged: true });

    expect(
      (await b.post(`/partner/deliveries/${o.deliveryId}/picked-up`, { at: BRANCH }, key())).body
        .error.code,
    ).toBe('PICKUP_NOT_READY');
    await o.manager.browser.post(`/merchant/orders/${o.orderId}/ready`, {}, key());
    ctx.clock.advance(4 * 60_000);
    const fresh = await signInAs(ctx, '+919000000401', 'DELIVERY');
    expect(
      (
        await fresh.browser.post(
          `/partner/deliveries/${o.deliveryId}/picked-up`,
          { at: BRANCH },
          key(),
        )
      ).body.data.status,
    ).toBe('EN_ROUTE_TO_CUSTOMER');
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order).toMatchObject({
      status: 'PICKED_UP',
      etaMinAt: expect.any(Date),
      etaMaxAt: expect.any(Date),
    });

    await fresh.browser.post(
      `/partner/deliveries/${o.deliveryId}/arrived-at-customer`,
      { at: HOME },
      key(),
    );
    const wrong = await fresh.browser.post(
      `/partner/deliveries/${o.deliveryId}/complete`,
      {
        method: 'OTP',
        otp:
          '0000' === deliveryCode(ctx.container.env.AUTH_HMAC_SECRET, o.orderId) ? '1111' : '0000',
        cashCollected: true,
      },
      key(),
    );
    expect(wrong.body.error).toMatchObject({
      code: 'DELIVERY_OTP_INVALID',
      details: [{ message: '4' }],
    });
    const otp = deliveryCode(ctx.container.env.AUTH_HMAC_SECRET, o.orderId);
    expect(
      (
        await fresh.browser.post(
          `/partner/deliveries/${o.deliveryId}/complete`,
          { method: 'OTP', otp },
          key(),
        )
      ).status,
    ).toBe(400); // cash not confirmed
    const done = await fresh.browser.post(
      `/partner/deliveries/${o.deliveryId}/complete`,
      { method: 'OTP', otp, cashCollected: true },
      key(),
    );
    expect(done.body.data).toMatchObject({
      status: 'DELIVERED',
      earning: { total: expect.any(Number), tip: 0 },
    });

    expect(await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({
      status: 'DELIVERED',
    });
    expect(await ctx.prisma.payment.findFirst({ where: { orderId: o.orderId } })).toMatchObject({
      status: 'COLLECTED',
      capturedAmount: o.payable,
    });
    expect(await ctx.container.partnerAvailability.cashInHand(r.partnerId)).toBeGreaterThanOrEqual(
      o.payable,
    );
    expect(await liability(o.orderId)).toBe(0);
    expect(
      await ctx.prisma.partnerEarning.findUnique({ where: { deliveryId: o.deliveryId } }),
    ).toMatchObject({ baseAmount: 2500, tipAmount: 0 });
    expect(await ctx.container.ledger.verify()).toEqual([]);
    expect((await ctx.container.presence.get(r.partnerId))?.state).toBe('ONLINE_IDLE');
    expect((await fresh.browser.get('/partner/deliveries')).body.data[0]).toMatchObject({
      id: o.deliveryId,
      status: 'DELIVERED',
    });
  });

  it('passes the tip of a prepaid order to the partner and settles the order to zero', async () => {
    const r = await rider('+919000000402');
    const o = await assigned(r, { paymentMethod: 'ONLINE', tipAmount: 3_000 });
    await o.manager.browser.post(`/merchant/orders/${o.orderId}/ready`, {}, key());
    await r.browser.post(`/partner/deliveries/${o.deliveryId}/picked-up`, {}, key());
    const otp = deliveryCode(ctx.container.env.AUTH_HMAC_SECRET, o.orderId);
    expect(
      (
        await r.browser.post(
          `/partner/deliveries/${o.deliveryId}/complete`,
          { method: 'OTP', otp },
          key(),
        )
      ).status,
    ).toBe(200);
    expect(
      await ctx.prisma.partnerEarning.findUnique({ where: { deliveryId: o.deliveryId } }),
    ).toMatchObject({ tipAmount: 3_000 });
    expect(await liability(o.orderId)).toBe(0);
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('lets the restaurant hand over with the pickup code, straight from preparing (T13c)', async () => {
    const r = await rider('+919000000404');
    const o = await assigned(r);
    await o.manager.browser.post(`/merchant/orders/${o.orderId}/preparing`, {}, key());
    // The order details tell the restaurant who is coming (first name only).
    expect(
      (await o.manager.browser.get(`/merchant/orders/${o.orderId}`)).body.data.partner,
    ).toMatchObject({ firstName: expect.any(String), deliveryStatus: expect.any(String) });
    expect(
      (
        await o.manager.browser.post(
          `/merchant/orders/${o.orderId}/handover`,
          {
            pickupCode:
              '9999' ===
              (await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } }))
                .pickupCode
                ? '8888'
                : '9999',
          },
          key(),
        )
      ).body.error.code,
    ).toBe('PICKUP_CODE_INVALID');
    const code = (await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } }))
      .pickupCode!;
    const res = await o.manager.browser.post(
      `/merchant/orders/${o.orderId}/handover`,
      { pickupCode: code },
      key(),
    );
    expect(res.body.data).toMatchObject({ status: 'PICKED_UP', partner: expect.any(String) });
    const statuses = (
      await ctx.prisma.orderStatusHistory.findMany({
        where: { orderId: o.orderId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map((h) => h.toStatus);
    expect(statuses.slice(-2)).toEqual(['READY_FOR_PICKUP', 'PICKED_UP']);
    expect(
      (await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } })).status,
    ).toBe('EN_ROUTE_TO_CUSTOMER');
    // EVT-DP-016: the partner's trip screen is told about the handover at once.
    pushes(ctx).clear();
    await ctx.container.outboxRelay.runOnce();
    const toPartner = pushes(ctx)
      .of('delivery.status_changed')
      .filter((x) => x.app === 'DELIVERY');
    expect(toPartner).toHaveLength(1);
    expect(toPartner[0]).toMatchObject({
      rooms: [`delivery:${o.deliveryId}`],
      data: { deliveryId: o.deliveryId, orderId: o.orderId, status: 'EN_ROUTE_TO_CUSTOMER' },
    });
  });

  it('re-dispatches when the partner unassigns, and compensates them if the restaurant cancels', async () => {
    const a = await rider('+919000000401');
    const b = await rider('+919000000402', { lat: 12.938, lng: 77.627 });
    const o = await assigned(a);
    await a.browser.post(
      `/partner/deliveries/${o.deliveryId}/unassign`,
      { reason: 'VEHICLE_BREAKDOWN' },
      key(),
    );
    expect(
      await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } }),
    ).toMatchObject({ status: 'SEARCHING', partnerId: null });
    const offer = (await b.browser.get('/partner/offers/current')).body.data;
    expect(offer.deliveryId).toBe(o.deliveryId);
    await b.browser.post(`/partner/offers/${offer.offerId}/accept`, {}, key());

    await o.manager.browser.post(
      `/merchant/orders/${o.orderId}/cancel`,
      { reason: 'KITCHEN_ISSUE', note: 'Gas ran out', confirm: true },
      key(),
    );
    await ctx.container.outboxRelay.runOnce();
    expect(
      (await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } })).status,
    ).toBe('CANCELLED');
    const comp = await ctx.prisma.partnerEarning.findUnique({
      where: { deliveryId: o.deliveryId },
    });
    expect(comp).toMatchObject({ partnerId: b.partnerId });
    expect(comp!.totalAmount).toBeGreaterThanOrEqual(1500);
    expect((await ctx.container.presence.get(b.partnerId))?.state).toBe('ONLINE_IDLE');
    expect(await ctx.container.ledger.verify()).toEqual([]);
  });

  it('releases a silent partner before pickup and locks the code after five wrong tries', async () => {
    const r = await rider('+919000000401');
    const o = await assigned(r);
    ctx.clock.advance(6 * 60_000);
    expect(await ctx.container.deliveryStages.heartbeatSweep()).toMatchObject({ released: 1 });
    expect(
      await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: o.deliveryId } }),
    ).toMatchObject({ status: 'SEARCHING', partnerId: null });
    // Park the released delivery so the next partner is not offered it first.
    await ctx.prisma.delivery.update({
      where: { id: o.deliveryId },
      data: { status: 'CANCELLED' },
    });

    const r2 = await rider('+919000000402');
    const o2 = await assigned(r2);
    await o2.manager.browser.post(`/merchant/orders/${o2.orderId}/ready`, {}, key());
    await r2.browser.post(`/partner/deliveries/${o2.deliveryId}/picked-up`, {}, key());
    const otp = deliveryCode(ctx.container.env.AUTH_HMAC_SECRET, o2.orderId);
    const bad = otp === '0000' ? '1111' : '0000';
    for (let i = 0; i < 5; i++)
      await r2.browser.post(
        `/partner/deliveries/${o2.deliveryId}/complete`,
        { method: 'OTP', otp: bad, cashCollected: true },
        key(),
      );
    expect(
      (
        await r2.browser.post(
          `/partner/deliveries/${o2.deliveryId}/complete`,
          { method: 'OTP', otp, cashCollected: true },
          key(),
        )
      ).body.error.code,
    ).toBe('DELIVERY_OTP_LOCKED');
    expect(
      await ctx.prisma.opsAlert.count({
        where: { type: 'DELIVERY_OTP_LOCKED', refId: o2.orderId },
      }),
    ).toBe(1);
  });
});
