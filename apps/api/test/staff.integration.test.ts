import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import type { MockPaymentProvider } from '../src/modules/payments';
import {
  branchId,
  browser,
  createOwnedRestaurant,
  createTestContext,
  integrationEnabled,
  placeOrder,
  SAFFRON_STAFF,
  signInAs,
  signUpApplicant,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;

beforeAll(async () => {
  if (integrationEnabled) ctx = await createTestContext();
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
});

/** The invitation token from the SMS the invitee received. */
const tokenSentTo = (phone: string) => {
  const msg = [...ctx.messages.sent]
    .reverse()
    .find((m) => m.to === phone && m.template === 'RENDERED');
  const text = msg?.template === 'RENDERED' ? msg.vars.text : '';
  return text.match(/\/invite\/([\w-]+)/)?.[1] ?? '';
};

suite('restaurant staff (API-RSTAFF-001…008, FR-RSTAFF-001/002)', () => {
  it('invites by phone, previews publicly and lets only the invitee accept', async () => {
    const owner = await createOwnedRestaurant(ctx);
    const invitee = await signUpApplicant(ctx);
    const res = await owner.browser.post(
      `/merchant/restaurants/${owner.restaurantId}/invitations`,
      {
        phone: invitee.phone,
        role: 'KITCHEN',
        allBranches: false,
        branchIds: [owner.branchId],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      role: 'KITCHEN',
      status: 'PENDING',
      phone: expect.stringMatching(/^\+91XXXXX\d{4}$/),
    });
    const token = tokenSentTo(invitee.phone);
    expect(token.length).toBeGreaterThan(20);

    const preview = (await browser(ctx, 'RESTAURANT').get(`/merchant/invitations/${token}`)).body
      .data;
    expect(preview).toMatchObject({ role: 'KITCHEN', branches: ['Test Branch'], sentTo: 'PHONE' });
    expect(JSON.stringify(preview)).not.toContain(invitee.phone);

    const stranger = await signUpApplicant(ctx);
    expect(
      (await stranger.browser.post(`/merchant/invitations/${token}/accept`)).body.error.code,
    ).toBe('INVITATION_MISMATCH');
    const accepted = await invitee.browser.post(`/merchant/invitations/${token}/accept`);
    expect(accepted.body.data).toMatchObject({ restaurantId: owner.restaurantId, role: 'KITCHEN' });
    // Effective immediately on the same session.
    expect((await invitee.browser.get('/merchant/me')).body.data.restaurants).toEqual([
      expect.objectContaining({
        id: owner.restaurantId,
        role: 'KITCHEN',
        branches: [expect.objectContaining({ id: owner.branchId })],
      }),
    ]);
    expect((await invitee.browser.get(`/merchant/branches/${owner.branchId}/kds`)).status).toBe(
      200,
    );
    expect(
      (await invitee.browser.post(`/merchant/invitations/${token}/accept`)).body.error.code,
    ).toBe('INVITATION_INVALID');

    const members = (await owner.browser.get(`/merchant/restaurants/${owner.restaurantId}/members`))
      .body.data;
    expect(members.map((m: { role: string }) => m.role)).toEqual(['OWNER', 'KITCHEN']);
  });

  it('keeps managers below their own rank and inside their outlets; invitations expire', async () => {
    const saffronManager = await signInAs(ctx, SAFFRON_STAFF.manager);
    const rid = (
      await ctx.prisma.branch.findFirstOrThrow({
        where: { restaurant: { brandName: 'Saffron Handi Biryani' } },
      })
    ).restaurantId;
    const person = await signUpApplicant(ctx);
    expect(
      (
        await saffronManager.browser.post(`/merchant/restaurants/${rid}/invitations`, {
          phone: person.phone,
          role: 'MANAGER',
          allBranches: true,
        })
      ).status,
    ).toBe(403);
    const ok = await saffronManager.browser.post(`/merchant/restaurants/${rid}/invitations`, {
      phone: person.phone,
      role: 'ORDER_MANAGER',
      allBranches: true,
    });
    expect(ok.status).toBe(201);
    const kitchen = await signInAs(ctx, SAFFRON_STAFF.kitchen);
    expect((await kitchen.browser.get(`/merchant/restaurants/${rid}/members`)).status).toBe(403);

    ctx.clock.advance(8 * 86_400_000);
    expect(
      (await browser(ctx, 'RESTAURANT').get(`/merchant/invitations/${tokenSentTo(person.phone)}`))
        .body.error.code,
    ).toBe('INVITATION_INVALID');
    await ctx.prisma.restaurantInvitation.deleteMany({ where: { restaurantId: rid } });
  });

  it('changes roles, suspends and removes members with immediate effect', async () => {
    const owner = await createOwnedRestaurant(ctx);
    const invitee = await signUpApplicant(ctx);
    await owner.browser.post(`/merchant/restaurants/${owner.restaurantId}/invitations`, {
      phone: invitee.phone,
      role: 'ORDER_MANAGER',
      allBranches: true,
    });
    await invitee.browser.post(`/merchant/invitations/${tokenSentTo(invitee.phone)}/accept`);
    const member = (
      await owner.browser.get(`/merchant/restaurants/${owner.restaurantId}/members`)
    ).body.data.find((m: { role: string }) => m.role === 'ORDER_MANAGER');
    expect((await invitee.browser.get(`/merchant/branches/${owner.branchId}/orders`)).status).toBe(
      200,
    );

    await owner.browser.patch(`/merchant/restaurants/${owner.restaurantId}/members/${member.id}`, {
      role: 'KITCHEN',
    });
    expect((await invitee.browser.get(`/merchant/branches/${owner.branchId}/orders`)).status).toBe(
      403,
    ); // KITCHEN can't read orders
    await owner.browser.patch(`/merchant/restaurants/${owner.restaurantId}/members/${member.id}`, {
      status: 'SUSPENDED',
    });
    expect((await invitee.browser.get(`/merchant/branches/${owner.branchId}/kds`)).status).toBe(
      403,
    ); // onboarding scope again
    await owner.browser.patch(`/merchant/restaurants/${owner.restaurantId}/members/${member.id}`, {
      status: 'ACTIVE',
    });
    expect((await invitee.browser.get(`/merchant/branches/${owner.branchId}/kds`)).status).toBe(
      200,
    );
    expect(
      (
        await owner.browser.delete(
          `/merchant/restaurants/${owner.restaurantId}/members/${member.id}`,
        )
      ).status,
    ).toBe(200);
    expect((await invitee.browser.get('/merchant/me')).body.data.restaurants).toEqual([]);

    // Nobody manages the owner, or themselves.
    const self = (await owner.browser.get(`/merchant/restaurants/${owner.restaurantId}/members`))
      .body.data[0];
    expect(
      (
        await owner.browser.patch(
          `/merchant/restaurants/${owner.restaurantId}/members/${self.id}`,
          { role: 'STAFF' },
        )
      ).status,
    ).toBe(403);
  });
});

suite('restaurant dashboard and analytics (API-RANL-001…004, 007)', () => {
  it('reports today’s orders, revenue, acceptance and top dishes from real orders', async () => {
    const saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
    const rid = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
      .restaurantId;
    const paneer = await ctx.prisma.foodItem.findFirstOrThrow({
      where: { restaurantId: rid, name: 'Paneer Biryani' },
    });
    const mild = await ctx.prisma.customizationOption.findFirstOrThrow({
      where: { name: 'Mild', group: { restaurantId: rid } },
    });
    const owner = await signInAs(ctx, SAFFRON_STAFF.owner);
    const before = (await owner.browser.get(`/merchant/restaurants/${rid}/dashboard`)).body.data;

    const c = await placeOrder(ctx, {
      branchId: saffron,
      items: [{ foodItemId: paneer.id, optionIds: [mild.id], quantity: 3 }],
      paymentMethod: 'ONLINE',
    });
    const mock = ctx.container.paymentProvider as MockPaymentProvider;
    const paid = mock.pay(c.payment.providerOrderId, 'success');
    await c.browser.post(
      `/payments/${c.payment.paymentId}/verify`,
      { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
      { 'Idempotency-Key': uuidv7() },
    );
    await ctx.container.outboxRelay.runOnce();
    ctx.clock.advance(60_000);
    await owner.browser.post(
      `/merchant/orders/${c.orderId}/accept`,
      {},
      { 'Idempotency-Key': uuidv7() },
    );
    ctx.clock.advance(20 * 60_000);
    const kitchenNow = await signInAs(ctx, SAFFRON_STAFF.manager); // the owner's token expired meanwhile
    expect(
      (
        await kitchenNow.browser.post(
          `/merchant/orders/${c.orderId}/ready`,
          {},
          { 'Idempotency-Key': uuidv7() },
        )
      ).status,
    ).toBe(200);
    for (const to of ['PICKED_UP', 'DELIVERED'] as const)
      await ctx.prisma.$transaction((tx) =>
        ctx.container.orderTransitions.apply(tx, {
          orderId: c.orderId,
          to,
          actor: { type: to === 'DELIVERED' ? 'ADMIN' : 'RESTAURANT', id: null },
        }),
      );
    const delivered = await ctx.prisma.order.findUniqueOrThrow({ where: { id: c.orderId } });
    await ctx.prisma.$transaction((tx) => ctx.container.orderSettlement.settle(tx, delivered));

    const owner2 = await signInAs(ctx, SAFFRON_STAFF.owner); // the clock moved past the token
    const after = (await owner2.browser.get(`/merchant/restaurants/${rid}/dashboard`)).body.data;
    expect(after.orders.delivered).toBe(before.orders.delivered + 1);
    const food = delivered.itemsSubtotalAmount - delivered.discountTotalAmount;
    expect(after.revenue.deliveredValue - before.revenue.deliveredValue).toBe(food);
    expect(after.revenue.netPayable - before.revenue.netPayable).toBeGreaterThan(0);
    expect(after.revenue.netPayable - before.revenue.netPayable).toBeLessThan(food + 10_000);
    expect(after.avgAcceptSeconds).toBeGreaterThan(0);

    const from = new Date(ctx.clock.now().getTime() - 86_400_000).toISOString();
    const to = new Date(ctx.clock.now().getTime() + 86_400_000).toISOString();
    const items = (
      await owner2.browser.get(`/merchant/restaurants/${rid}/analytics/items`, { from, to })
    ).body.data;
    expect(
      items.find((i: { name: string }) => i.name === 'Paneer Biryani').quantity,
    ).toBeGreaterThanOrEqual(3);
    const ops = (
      await owner2.browser.get(`/merchant/restaurants/${rid}/analytics/operations`, { from, to })
    ).body.data;
    expect(ops.orders).toBeGreaterThan(0);
    const sales = (
      await owner2.browser.get(`/merchant/restaurants/${rid}/analytics/sales`, {
        from,
        to,
        granularity: 'day',
      })
    ).body.data;
    expect(sales.totals.delivered).toBeGreaterThanOrEqual(1);

    // Kitchen staff have no analytics.
    const kitchen = await signInAs(ctx, SAFFRON_STAFF.kitchen);
    expect((await kitchen.browser.get(`/merchant/restaurants/${rid}/dashboard`)).status).toBe(403);
  });
});
