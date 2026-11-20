import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { NotificationDeliverer, type Message, type PushSender } from '../src/modules/notifications';
import { createLogger } from '../src/platform/logger';
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
let saffron: string;
const ids: Record<string, string> = {};

function todayAt(hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const t = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(t.year, t.month, t.day, h! * 60 + m!, 'Asia/Kolkata');
}
const jobs = () => ctx.container.jobs as RecordingJobQueue;

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
  jobs().jobs.length = 0;
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

const order = () =>
  placeOrder(ctx, {
    branchId: saffron,
    items: [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 1 }],
    paymentMethod: 'COD',
  });
const staff = async (phone: string) =>
  (await ctx.prisma.user.findFirstOrThrow({ where: { phone } })).id;

suite('notifications from order events (FR-NOTIF-001/002/010)', () => {
  it('tells the customer and the branch staff about a new order, once', async () => {
    const c = await order();
    await ctx.container.outboxRelay.runOnce();
    const inbox = (await c.browser.get('/me/notifications')).body.data;
    expect(inbox).toEqual([
      expect.objectContaining({
        title: 'Order placed',
        body: expect.stringContaining('Saffron Handi Biryani has your order'),
        deepLink: `/orders/${c.orderId}`,
        read: false,
      }),
    ]);
    const owner = await staff('+919000000201');
    const kitchen = await staff('+919000000302'); // assigned to Koramangala only
    const ownerInbox = await ctx.prisma.notification.findMany({
      where: { userId: owner, data: { path: ['orderId'], equals: c.orderId } },
    });
    expect(ownerInbox).toEqual([
      expect.objectContaining({ app: 'RESTAURANT', title: expect.stringMatching(/^New order /) }),
    ]);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: kitchen, data: { path: ['orderId'], equals: c.orderId } },
      }),
    ).toBe(1);
    // Staff of other restaurants hear nothing.
    expect(
      await ctx.prisma.notification.count({
        where: {
          data: { path: ['orderId'], equals: c.orderId },
          app: 'RESTAURANT',
          userId: { notIn: [owner, kitchen, await staff('+919000000301')] },
        },
      }),
    ).toBe(0);
    // The customer's app inbox doesn't show restaurant entries and vice versa.
    expect(inbox.every((n: { title: string }) => !n.title.startsWith('New order'))).toBe(true);

    // Push goes through the worker queue (one per external channel per recipient).
    const pushJobs = jobs().jobs.filter((j) => j.name === 'deliver-notification');
    expect(pushJobs.length).toBeGreaterThanOrEqual(2);

    // Replaying the event (relay crash before marking it) sends nothing new.
    const placed = await ctx.prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: c.orderId, eventType: 'order.placed' },
    });
    await ctx.prisma.outboxEvent.update({
      where: { sequence: placed.sequence },
      data: { publishedAt: null },
    });
    await ctx.container.outboxRelay.runOnce();
    expect((await c.browser.get('/me/notifications')).body.data).toHaveLength(1);
  });

  it('explains the refund when an order is cancelled', async () => {
    const c = await order();
    await ctx.container.orderCancellation.cancel({
      orderId: c.orderId,
      actor: { type: 'ADMIN' },
      reasonCode: 'TEST',
      fault: 'PLATFORM',
    });
    await ctx.container.outboxRelay.runOnce();
    const titles = (await c.browser.get('/me/notifications')).body.data.map(
      (n: { title: string; body: string }) => `${n.title}: ${n.body}`,
    );
    expect(titles).toContainEqual(expect.stringMatching(/^Order cancelled: .*not been charged/));
  });

  it('refuses to render a template with a missing variable (FR-NOTIF-005)', async () => {
    const c = await signUpCustomer(ctx);
    await expect(
      ctx.container.notifications.notify({
        eventId: uuidv7(),
        userId: c.userId,
        key: 'order.placed',
        vars: { number: 'X1', orderId: uuidv7() },
      }),
    ).rejects.toThrow(/restaurant/);
    expect(await ctx.prisma.notification.count({ where: { userId: c.userId } })).toBe(0);
  });
});

suite('inbox, preferences and push (API-NTF-001…010)', () => {
  it('reads, counts, marks and hides inbox entries; only the recipient can', async () => {
    const c = await order();
    await ctx.container.outboxRelay.runOnce();
    await ctx.container.orderCancellation.cancel({
      orderId: c.orderId,
      actor: { type: 'ADMIN' },
      reasonCode: 'TEST',
      fault: 'PLATFORM',
    });
    await ctx.container.outboxRelay.runOnce();
    const b = c.browser;
    expect((await b.get('/me/notifications/unread-count')).body.data).toEqual({ unread: 2 });
    const [latest, first] = (await b.get('/me/notifications')).body.data;
    expect((await b.post(`/me/notifications/${first.id}/read`)).body.data.read).toBe(true);
    expect(
      (await b.get('/me/notifications', { unread: 'true' })).body.data.map(
        (n: { id: string }) => n.id,
      ),
    ).toEqual([latest.id]);
    expect((await b.post('/me/notifications/read-all')).body.data).toEqual({ updated: 1 });
    expect((await b.get('/me/notifications/unread-count')).body.data).toEqual({ unread: 0 });
    expect((await b.delete(`/me/notifications/${first.id}`)).status).toBe(200);
    expect((await b.get('/me/notifications')).body.data).toHaveLength(1);

    const stranger = await signUpCustomer(ctx);
    expect((await stranger.browser.get(`/me/notifications/${latest.id}`)).status).toBe(404);
    expect((await stranger.browser.post(`/me/notifications/${latest.id}/read`)).status).toBe(404);
  });

  it('lets users mute optional categories only (FR-NOTIF-006, BR-NOTIF-001)', async () => {
    const c = await signUpCustomer(ctx);
    const prefs = (await c.browser.get('/me/notification-preferences')).body.data;
    expect(prefs.mandatory).toEqual(expect.arrayContaining(['TRANSACTIONAL', 'ORDER_UPDATES']));
    expect(prefs.categories).toContainEqual({
      category: 'PROMOTIONS',
      channels: { PUSH: true, SMS: true, EMAIL: true },
    });
    const updated = await c.browser.put('/me/notification-preferences', {
      preferences: [{ category: 'PROMOTIONS', channel: 'SMS', enabled: false }],
    });
    expect(updated.body.data.categories).toContainEqual({
      category: 'PROMOTIONS',
      channels: { PUSH: true, SMS: false, EMAIL: true },
    });
    expect(
      (
        await c.browser.put('/me/notification-preferences', {
          preferences: [{ category: 'ORDER_UPDATES', channel: 'PUSH', enabled: false }],
        })
      ).status,
    ).toBe(400);
  });

  it('registers one push subscription per session and delivers to live sessions (FR-NOTIF-007/009)', async () => {
    const c = await order();
    const sub = {
      endpoint: `https://push.example.test/${uuidv7()}`,
      keys: { p256dh: 'BOr8Qw0n3Yy3c2bWl1aJx0Q', auth: 'k3y-auth-1234' },
    };
    const first = await c.browser.post('/me/push-subscriptions', sub);
    expect(first.status).toBe(201);
    const second = await c.browser.post('/me/push-subscriptions', {
      ...sub,
      endpoint: `https://push.example.test/${uuidv7()}`,
    });
    expect(await ctx.prisma.pushSubscription.count({ where: { userId: c.userId } })).toBe(1);

    await ctx.container.outboxRelay.runOnce();
    const pushed: string[] = [];
    const push: PushSender = {
      send: async (s, p) => {
        pushed.push(`${s.endpoint}|${p.title}`);
        return { gone: false };
      },
    };
    const sent: Message[] = [];
    const deliverer = new NotificationDeliverer(
      ctx.prisma,
      { deliver: async (m) => void sent.push(m) },
      push,
      ctx.clock,
      createLogger({ level: 'silent', service: 'api' }),
    );
    const job = jobs().jobs.find(
      (j) =>
        j.name === 'deliver-notification' &&
        j.data.vars &&
        (j.data.vars as { orderId?: string }).orderId === c.orderId,
    )!;
    await deliverer.deliver(String(job.data.deliveryId), job.data.vars as Record<string, string>);
    expect(pushed).toEqual([expect.stringMatching(/\|Order placed$/)]);
    expect(
      await ctx.prisma.notificationDelivery.findUniqueOrThrow({
        where: { id: String(job.data.deliveryId) },
      }),
    ).toMatchObject({ status: 'SENT', channel: 'PUSH', attempts: 1, sentAt: expect.any(Date) });

    // Signed out everywhere: nothing to push to.
    expect((await c.browser.delete(`/me/push-subscriptions/${second.body.data.id}`)).status).toBe(
      200,
    );
    expect(await ctx.prisma.pushSubscription.count({ where: { userId: c.userId } })).toBe(0);
  });
});
