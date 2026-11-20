import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import type { MockPaymentProvider } from '../src/modules/payments';
import type { RecordingJobQueue } from '../src/platform/jobs';
import {
  branchId,
  createTestContext,
  integrationEnabled,
  placeOrder,
  SAFFRON_STAFF,
  signInAs,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let saffron: string;
const ids: Record<string, string> = {};

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
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
  (ctx.container.jobs as RecordingJobQueue).jobs.length = 0;
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

const key = () => ({ 'Idempotency-Key': uuidv7() });
const order = (opts: { paymentMethod?: 'COD' | 'ONLINE'; coupon?: string } = {}) =>
  placeOrder(ctx, {
    branchId: saffron,
    items: [
      { foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 2 },
      { foodItemId: ids['Double Ka Meetha']!, optionIds: [], quantity: 1 },
    ],
    paymentMethod: opts.paymentMethod ?? 'COD',
    ...(opts.coupon ? { coupon: opts.coupon } : {}),
  });
const statusOf = async (id: string) =>
  (await ctx.prisma.order.findUniqueOrThrow({ where: { id } })).status;

suite('restaurant order queue (API-RORD-001…012, FR-RORD-001…012)', () => {
  it('shows new orders without customer details, then accepts, prepares and marks ready', async () => {
    const c = await order();
    await ctx.prisma.order.update({
      where: { id: c.orderId },
      data: { contactName: 'Asha Ramesh Rao', cookingInstructions: 'Less oil' },
    });
    const manager = (await signInAs(ctx, SAFFRON_STAFF.manager)).browser;

    const queue = (await manager.get(`/merchant/branches/${saffron}/orders`, { status: 'NEW' }))
      .body.data;
    const card = queue.find((o: { id: string }) => o.id === c.orderId);
    expect(card).toMatchObject({
      customer: 'Asha R.',
      area: 'Koramangala',
      payment: 'COD',
      itemCount: 3,
      cookingInstructions: 'Less oil',
      acceptBy: expect.any(String),
    });
    expect(JSON.stringify(card)).not.toMatch(/\+91|Flat 9|Ramesh/);
    expect(
      (await manager.get(`/merchant/branches/${saffron}/orders/counts`)).body.data.NEW,
    ).toBeGreaterThanOrEqual(1);

    // Prep time within ±50 % of the default.
    expect(
      (await manager.post(`/merchant/orders/${c.orderId}/accept`, { prepMinutes: 90 }, key()))
        .status,
    ).toBe(400);
    const accepted = (
      await manager.post(`/merchant/orders/${c.orderId}/accept`, { prepMinutes: 25 }, key())
    ).body.data;
    expect(accepted).toMatchObject({ status: 'ACCEPTED', prepMinutes: 25 });
    expect(new Date(accepted.readyBy).getTime()).toBe(ctx.clock.now().getTime() + 25 * 60_000);
    expect(accepted.value.restaurantShare).toBeGreaterThan(0);
    const jobs = (ctx.container.jobs as RecordingJobQueue).jobs.map((j) => j.name);
    expect(jobs).toContain('auto-preparing');

    const kitchen = (await signInAs(ctx, SAFFRON_STAFF.kitchen)).browser;
    const kds = (await kitchen.get(`/merchant/branches/${saffron}/kds`)).body.data;
    const ticket = kds.find((t: { id: string }) => t.id === c.orderId);
    expect(ticket).toMatchObject({
      urgency: 'GREEN',
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'Paneer Biryani', options: ['Mild'] }),
      ]),
    });
    expect(JSON.stringify(ticket)).not.toMatch(/Amount|Asha|area/);
    expect((await kitchen.post(`/merchant/orders/${c.orderId}/accept`, {}, key())).status).toBe(
      403,
    );

    // "Mark ready" from ACCEPTED records PREPARING and READY_FOR_PICKUP together.
    const ready = (await kitchen.post(`/merchant/orders/${c.orderId}/ready`, {}, key())).body.data;
    expect(ready.status).toBe('READY_FOR_PICKUP');
    expect(ready.timeline.map((t: { status: string }) => t.status)).toEqual([
      'PLACED',
      'ACCEPTED',
      'PREPARING',
      'READY_FOR_PICKUP',
    ]);
    expect((ctx.container.jobs as RecordingJobQueue).jobs.map((j) => j.name)).toContain(
      'pickup-delay',
    );
    expect(
      (
        await manager.get(`/merchant/branches/${saffron}/orders`, { status: 'READY' })
      ).body.data.map((o: { id: string }) => o.id),
    ).toContain(c.orderId);
  });

  it('lets exactly one of two simultaneous accepts win', async () => {
    const c = await order();
    const a = (await signInAs(ctx, SAFFRON_STAFF.manager)).browser;
    const b = (await signInAs(ctx, SAFFRON_STAFF.owner)).browser;
    const [r1, r2] = await Promise.all([
      a.post(`/merchant/orders/${c.orderId}/accept`, {}, key()),
      b.post(`/merchant/orders/${c.orderId}/accept`, {}, key()),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: c.orderId, toStatus: 'ACCEPTED' },
      }),
    ).toBe(1);
  });

  it('rejects with named items, refunds in full, and can switch those items off (BR-ORDER-014)', async () => {
    const c = await order({ coupon: 'WELCOME50' });
    const manager = (await signInAs(ctx, SAFFRON_STAFF.manager)).browser;
    const dessertLine = await ctx.prisma.orderItem.findFirstOrThrow({
      where: { orderId: c.orderId, itemName: 'Double Ka Meetha' },
    });
    expect(
      (
        await manager.post(
          `/merchant/orders/${c.orderId}/reject`,
          { reason: 'ITEM_UNAVAILABLE' },
          key(),
        )
      ).status,
    ).toBe(400);
    try {
      const res = await manager.post(
        `/merchant/orders/${c.orderId}/reject`,
        { reason: 'ITEM_UNAVAILABLE', itemIds: [dessertLine.id], markUnavailable: true },
        key(),
      );
      expect(res.body.data.status).toBe('REJECTED');
      expect(
        await ctx.prisma.orderCancellation.findUnique({ where: { orderId: c.orderId } }),
      ).toMatchObject({
        initiatorType: 'RESTAURANT',
        fault: 'RESTAURANT',
        reasonCode: 'REJECTED_ITEM_UNAVAILABLE',
      });
      expect(
        await ctx.prisma.couponRedemption.findUnique({ where: { orderId: c.orderId } }),
      ).toMatchObject({ status: 'RELEASED' });
      expect(
        await ctx.prisma.branchItemAvailability.findUnique({
          where: {
            branchId_foodItemId: { branchId: saffron, foodItemId: ids['Double Ka Meetha']! },
          },
        }),
      ).toMatchObject({ isAvailable: false });
      await ctx.container.outboxRelay.runOnce();
      expect(
        await ctx.prisma.notification.count({
          where: { userId: c.userId, title: 'Restaurant couldn’t accept' },
        }),
      ).toBe(1);
    } finally {
      await ctx.prisma.branchItemAvailability.deleteMany({
        where: { branchId: saffron, foodItemId: ids['Double Ka Meetha']! },
      });
    }
  });

  it('extends prep time once and lets only owners and managers cancel accepted orders', async () => {
    const c = await order({ paymentMethod: 'ONLINE' });
    const mock = ctx.container.paymentProvider as MockPaymentProvider;
    const paid = mock.pay(c.payment.providerOrderId, 'success');
    await c.browser.post(
      `/payments/${c.payment.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      key(),
    );
    await ctx.container.outboxRelay.runOnce();
    const manager = (await signInAs(ctx, SAFFRON_STAFF.manager)).browser;
    const accepted = (await manager.post(`/merchant/orders/${c.orderId}/accept`, {}, key())).body
      .data;
    const ext = (
      await manager.post(
        `/merchant/orders/${c.orderId}/prep-time`,
        { minutes: 15, reason: 'Rush' },
        key(),
      )
    ).body.data;
    expect(new Date(ext.readyBy).getTime()).toBe(
      new Date(accepted.readyBy).getTime() + 15 * 60_000,
    );
    expect(
      (
        await manager.post(
          `/merchant/orders/${c.orderId}/prep-time`,
          { minutes: 5, reason: 'Again' },
          key(),
        )
      ).body.error.code,
    ).toBe('ORDER_STATE_CONFLICT');

    const kitchen = (await signInAs(ctx, SAFFRON_STAFF.kitchen)).browser;
    expect(
      (
        await kitchen.post(
          `/merchant/orders/${c.orderId}/cancel`,
          { reason: 'KITCHEN_ISSUE', note: 'Gas ran out', confirm: true },
          key(),
        )
      ).status,
    ).toBe(403);
    const cancelled = await manager.post(
      `/merchant/orders/${c.orderId}/cancel`,
      { reason: 'KITCHEN_ISSUE', note: 'Gas ran out', confirm: true },
      key(),
    );
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(await ctx.prisma.refund.findMany({ where: { orderId: c.orderId } })).toEqual([
      expect.objectContaining({
        amount: c.payable,
        costBearer: 'RESTAURANT',
        reasonCode: 'CANCELLED_RESTAURANT',
      }),
    ]);
    expect(await statusOf(c.orderId)).toBe('CANCELLED');
  });

  it('hides orders of other branches and restaurants', async () => {
    const c = await order();
    const indiranagar = await branchId(ctx, 'Saffron Handi Biryani', 'Indiranagar');
    const kitchen = (await signInAs(ctx, SAFFRON_STAFF.kitchen)).browser; // Koramangala only
    expect((await kitchen.get(`/merchant/branches/${indiranagar}/kds`)).status).toBe(404);
    const otherOwner = await ctx.prisma.restaurantMember.findFirstOrThrow({
      where: {
        role: 'OWNER',
        restaurant: { brandName: { not: 'Saffron Handi Biryani' }, onboardingStatus: 'APPROVED' },
        user: { phone: { not: null } },
      },
      include: { user: true },
    });
    const stranger = (await signInAs(ctx, otherOwner.user.phone!)).browser;
    expect((await stranger.get(`/merchant/orders/${c.orderId}`)).status).toBe(404);
    expect((await stranger.post(`/merchant/orders/${c.orderId}/accept`, {}, key())).status).toBe(
      404,
    );
  });
});
