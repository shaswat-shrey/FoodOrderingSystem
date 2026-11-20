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
});

/** A paid order (2 × Paneer Biryani) taken all the way to DELIVERED, by an established customer. */
async function delivered(opts: { accountAgeDays?: number } = {}) {
  const c = await placeOrder(ctx, {
    branchId: saffron,
    items: [
      { foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 2 },
      { foodItemId: ids['Double Ka Meetha']!, optionIds: [], quantity: 1 },
    ],
    paymentMethod: 'ONLINE',
  });
  await ctx.prisma.user.update({
    where: { id: c.userId },
    data: {
      createdAt: new Date(ctx.clock.now().getTime() - (opts.accountAgeDays ?? 40) * 86_400_000),
    },
  });
  const paid = mock.pay(c.payment.providerOrderId, 'success');
  await c.browser.post(
    `/payments/${c.payment.paymentId}/verify`,
    { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
    key(),
  );
  await ctx.container.outboxRelay.runOnce();
  for (const to of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED'])
    await ctx.prisma.$transaction((tx) =>
      ctx.container.orderTransitions.apply(tx, {
        orderId: c.orderId,
        to: to as 'ACCEPTED',
        actor: { type: to === 'DELIVERED' ? 'ADMIN' : 'RESTAURANT', id: null },
      }),
    );
  const item = await ctx.prisma.orderItem.findFirstOrThrow({
    where: { orderId: c.orderId, itemName: 'Paneer Biryani' },
  });
  const dessert = await ctx.prisma.orderItem.findFirstOrThrow({
    where: { orderId: c.orderId, itemName: 'Double Ka Meetha' },
  });
  return { ...c, item, dessert };
}

suite('support tickets (API-SUP-002…008, BR-SUP-001…004)', () => {
  it('runs a ticket from creation to rating, hiding internal notes', async () => {
    const c = await signUpCustomer(ctx);
    const created = await c.browser.post('/support/tickets', {
      category: 'ACCOUNT',
      description: 'I cannot change my email address from the profile page.',
    });
    expect(created.status).toBe(201);
    const t = created.body.data;
    expect(t).toMatchObject({
      status: 'OPEN',
      priority: 'NORMAL',
      number: expect.stringMatching(/^S\d{6}-[0-9A-Z]{6}$/),
      messages: [expect.objectContaining({ from: 'YOU' })],
    });
    expect(
      (await ctx.prisma.supportTicket.findUniqueOrThrow({ where: { id: t.id } })).slaDueAt,
    ).toEqual(new Date(ctx.clock.now().getTime() + 24 * 3_600_000));

    // Support answers (admin tools arrive later) with a public reply and an internal note.
    const agent = await signUpCustomer(ctx);
    await ctx.prisma.supportTicketMessage.createMany({
      data: [
        {
          ticketId: t.id,
          authorId: agent.userId,
          authorType: 'ADMIN',
          body: 'Internal: check logs',
          isInternal: true,
          createdAt: new Date(ctx.clock.now().getTime() + 1_000),
        },
        {
          ticketId: t.id,
          authorId: agent.userId,
          authorType: 'ADMIN',
          body: 'Please try again now.',
          createdAt: new Date(ctx.clock.now().getTime() + 2_000),
        },
      ],
    });
    await ctx.prisma.supportTicket.update({
      where: { id: t.id },
      data: { status: 'PENDING_CUSTOMER' },
    });
    ctx.clock.advance(5_000);
    const replied = await c.browser.post(`/support/tickets/${t.id}/messages`, {
      body: 'Still failing.',
    });
    expect(replied.body.data.status).toBe('OPEN');
    expect(replied.body.data.messages.map((m: { body: string }) => m.body)).toEqual([
      'I cannot change my email address from the profile page.',
      'Please try again now.',
      'Still failing.',
    ]);

    expect(
      (await c.browser.post(`/support/tickets/${t.id}/csat`, { score: 5 })).body.error.code,
    ).toBe('TICKET_STATE_CONFLICT');
    await ctx.prisma.supportTicket.update({
      where: { id: t.id },
      data: { status: 'RESOLVED', resolvedAt: ctx.clock.now() },
    });
    expect(
      (await c.browser.post(`/support/tickets/${t.id}/messages`, { body: 'x' })).body.error.code,
    ).toBe('TICKET_STATE_CONFLICT');
    expect(
      (await c.browser.post(`/support/tickets/${t.id}/csat`, { score: 4 })).body.data.csat,
    ).toBe(4);
    expect((await c.browser.post(`/support/tickets/${t.id}/csat`, { score: 5 })).status).toBe(409);

    // Days pass (the access token would have expired): straight to the service.
    ctx.clock.advance(6 * 86_400_000);
    expect((await ctx.container.support.reopen(c.userId, t.id, 'Broke again')).status).toBe('OPEN');
    await ctx.prisma.supportTicket.update({
      where: { id: t.id },
      data: { status: 'RESOLVED', resolvedAt: ctx.clock.now() },
    });
    ctx.clock.advance(8 * 86_400_000);
    await expect(ctx.container.support.reopen(c.userId, t.id, 'Again')).rejects.toMatchObject({
      code: 'TICKET_STATE_CONFLICT',
    });

    const list = await ctx.container.support.list(c.userId, { limit: 10 });
    expect(list.items.map((x) => x.id)).toEqual([t.id]);
    await expect(ctx.container.support.get(agent.userId, t.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('caps customer tickets per day and marks active-order tickets urgent', async () => {
    const c = await placeOrder(ctx, {
      branchId: saffron,
      items: [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 1 }],
      paymentMethod: 'COD',
    });
    const first = await c.browser.post('/support/tickets', {
      category: 'DELIVERY',
      description: 'Where is my order? It has been a while.',
      orderId: c.orderId,
    });
    expect(first.body.data.priority).toBe('URGENT');
    for (let i = 0; i < 4; i++)
      expect(
        (
          await c.browser.post('/support/tickets', {
            category: 'OTHER',
            description: `Question number ${i} about the app`,
          })
        ).status,
      ).toBe(201);
    const sixth = await c.browser.post('/support/tickets', {
      category: 'OTHER',
      description: 'One more question about the app',
    });
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
  });
});

suite('order issues (API-ORD-011…013, FR-CORD-010…012, BR-REFUND-006)', () => {
  it('auto-approves a small item refund to the wallet for an established customer', async () => {
    const c = await delivered();
    const res = await c.browser.post(
      `/orders/${c.orderId}/issues`,
      {
        type: 'MISSING_ITEM',
        description: 'The dessert was missing from the bag.',
        items: [{ orderItemId: c.dessert.id, quantity: 1 }],
        requestRefund: true,
      },
      key(),
    );
    expect(res.status).toBe(201);
    const issue = res.body.data;
    expect(issue).toMatchObject({
      status: 'APPROVED',
      refund: { status: 'APPROVED', destination: 'WALLET' },
      ticket: { number: expect.any(String) },
    });
    expect(issue.refund.amount).toBeGreaterThan(0);
    expect(issue.refund.amount).toBeLessThanOrEqual(25_000);

    const refund = await ctx.prisma.refund.findFirstOrThrow({
      where: { orderId: c.orderId, reasonCode: 'ISSUE_MISSING_ITEM' },
      include: { items: true },
    });
    expect(refund).toMatchObject({ amount: issue.refund.amount, costBearer: 'RESTAURANT' });
    expect(refund.items).toEqual([
      expect.objectContaining({ quantity: 1, amount: issue.refund.amount }),
    ]);
    await ctx.container.refunds.submit(refund.id);
    expect(await ctx.container.wallet.summary(c.userId)).toMatchObject({
      availableAmount: issue.refund.amount,
    });
    expect(
      await ctx.prisma.supportTicket.findUniqueOrThrow({ where: { id: issue.ticket.id } }),
    ).toMatchObject({ status: 'RESOLVED', orderId: c.orderId, category: 'ORDER_ISSUE' });

    // The same unit can't be reported twice.
    expect(
      (
        await c.browser.post(
          `/orders/${c.orderId}/issues`,
          {
            type: 'WRONG_ITEM',
            description: 'The dessert was the wrong one too.',
            items: [{ orderItemId: c.dessert.id, quantity: 1 }],
          },
          key(),
        )
      ).body.error.code,
    ).toBe('ISSUE_ITEMS_INVALID');
    expect((await c.browser.get(`/orders/${c.orderId}/issues`)).body.data).toHaveLength(1);
  });

  it('sends new accounts and large refunds to support, and closes the window after 48 h', async () => {
    const fresh = await delivered({ accountAgeDays: 2 });
    const res = await fresh.browser.post(
      `/orders/${fresh.orderId}/issues`,
      {
        type: 'QUALITY',
        description: 'The rice was undercooked and cold.',
        items: [{ orderItemId: fresh.item.id, quantity: 1 }],
        requestRefund: true,
      },
      key(),
    );
    expect(res.body.data).toMatchObject({ status: 'OPEN', refund: { status: 'UNDER_REVIEW' } });
    expect(
      await ctx.prisma.refund.count({
        where: { orderId: fresh.orderId, reasonCode: { startsWith: 'ISSUE_' } },
      }),
    ).toBe(0);

    const big = await delivered();
    const both = await big.browser.post(
      `/orders/${big.orderId}/issues`,
      {
        type: 'SPILLAGE',
        description: 'Everything leaked inside the bag.',
        items: [{ orderItemId: big.item.id, quantity: 2 }],
        requestRefund: true,
      },
      key(),
    );
    expect(both.body.data.refund.amount).toBeGreaterThan(25_000);
    expect(both.body.data.status).toBe('OPEN');

    ctx.clock.advance(49 * 3_600_000);
    await expect(
      ctx.container.orderIssues.report(big.userId, big.orderId, {
        type: 'OTHER',
        description: 'Something else went wrong here.',
      }),
    ).rejects.toMatchObject({ code: 'ISSUE_WINDOW_CLOSED' });
  });

  it('opens one urgent ticket for "not delivered" within the hour', async () => {
    const c = await delivered();
    const first = await c.browser.post(`/orders/${c.orderId}/not-delivered`, {}, key());
    expect(first.status).toBe(201);
    const again = await c.browser.post(`/orders/${c.orderId}/not-delivered`, {}, key());
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(
      await ctx.prisma.supportTicket.findUniqueOrThrow({
        where: { id: first.body.data.ticket.id },
      }),
    ).toMatchObject({ priority: 'URGENT', category: 'DELIVERY' });

    const later = await delivered();
    ctx.clock.advance(61 * 60_000);
    await expect(
      ctx.container.orderIssues.notDelivered(later.userId, later.orderId, 'Never came'),
    ).rejects.toMatchObject({ code: 'ISSUE_WINDOW_CLOSED' });
  });
});

suite('help centre and legal pages (API-SUP-001, 009, FR-CSUP-006)', () => {
  it('serves FAQs by topic, the current legal text and the grievance officer', async () => {
    const topic = `t-${uuidv7().slice(-6)}`;
    await ctx.prisma.faq.createMany({
      data: [
        { app: 'CUSTOMER', topic, question: 'Second?', answer: 'B', position: 2 },
        { app: 'CUSTOMER', topic, question: 'First?', answer: 'A', position: 1 },
        { app: 'CUSTOMER', topic, question: 'Hidden?', answer: 'C', position: 3, isActive: false },
      ],
    });
    const anon = (await signUpCustomer(ctx)).browser;
    const faqs = await anon.get('/help/faqs', { topic });
    expect(faqs.body.data).toEqual([
      {
        topic,
        items: [
          expect.objectContaining({ question: 'First?' }),
          expect.objectContaining({ question: 'Second?' }),
        ],
      },
    ]);
    const terms = await anon.get('/legal/terms');
    expect(terms.body.data).toMatchObject({ type: 'TERMS', version: expect.any(String) });
    expect((await anon.get('/legal/grievance-officer')).body.data.officer).toMatchObject({
      email: expect.any(String),
    });
    expect((await anon.get('/legal/cookies')).status).toBe(400);
  });
});
