import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { OutboxEvent } from '@fos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { createLogger } from '../src/platform/logger';
import { RedisWatchdog } from '../src/platform/redis-watchdog';
import {
  branchId,
  browser,
  createTestContext,
  integrationEnabled,
  parkActiveDeliveries,
  placeOrder,
  SAFFRON_STAFF,
  signInAs,
  signUpCustomer,
  type TestContext,
} from './helpers';

/**
 * AC-NFR-004 (NFR-AVAIL-004): Redis outage. The API's Redis clients connect through
 * a TCP proxy that the test cuts and restores. While Redis is gone, sign-in and
 * refresh fall back to the database, orders can still be placed and accepted,
 * dispatch pauses with an ops alert, and nothing waits for Redis; once it is back
 * the outbox drains in order and dispatch resumes.
 */
const suite = integrationEnabled ? describe : describe.skip;

/** A cuttable TCP proxy in front of the test Redis (a tiny Toxiproxy). */
class RedisProxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  async up(): Promise<void> {
    if (this.server) return;
    const server = createServer((client) => {
      const upstream = new (client.constructor as typeof Socket)();
      upstream.connect(this.target.port, this.target.host);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => s.destroy());
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', resolve);
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async down(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = null;
  }
}

let ctx: TestContext;
let proxy: RedisProxy;
let saffron: string;
const ids: Record<string, string> = {};
const RIDER = '+919000000404';
const key = () => ({ 'Idempotency-Key': uuidv7() });

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Runs `fn` and fails if it took long enough to have waited for Redis. */
async function quick<T>(what: string, fn: () => Promise<T>, ms = 2_000): Promise<T> {
  const started = Date.now();
  const result = await fn();
  expect(Date.now() - started, `${what} waited for Redis`).toBeLessThan(ms);
  return result;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  const target = new URL(process.env.TEST_REDIS_URL!);
  proxy = new RedisProxy({ host: target.hostname, port: Number(target.port || 6379) });
  await proxy.up();
  ctx = await createTestContext({ redisHost: `127.0.0.1:${proxy.port}` });
  const t = localParts(new Date(), 'Asia/Kolkata');
  ctx.clock.set(zonedInstant(t.year, t.month, t.day, 13 * 60, 'Asia/Kolkata'));
  saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
  const rid = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } })).restaurantId;
  for (const i of await ctx.prisma.foodItem.findMany({ where: { restaurantId: rid } }))
    ids[i.name] = i.id;
  for (const o of await ctx.prisma.customizationOption.findMany({
    where: { group: { restaurantId: rid } },
  }))
    ids[o.name] = o.id;
  await parkActiveDeliveries(ctx);
});
afterAll(async () => {
  if (!integrationEnabled) return;
  await proxy.up();
  await ctx.close();
  await proxy.down();
});

suite('Redis outage (AC-NFR-004, NFR-AVAIL-004)', () => {
  it('keeps sign-in, refresh and ordering working, pauses dispatch with an alert, and drains the outbox after recovery', async () => {
    // Before the outage: a customer with a session, a partner online near the restaurant.
    const customer = await signUpCustomer(ctx);
    const rider = await signInAs(ctx, RIDER, 'DELIVERY');
    await rider.browser.post(
      '/partner/me/online',
      { lat: 12.9355, lng: 77.6245, accuracyM: 10, recordedAt: ctx.clock.now().toISOString() },
      key(),
    );
    const manager = await signInAs(ctx, SAFFRON_STAFF.manager);
    const items = [{ foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!], quantity: 1 }];
    // An order accepted just before the outage: its delivery waits for dispatch.
    const before = await placeOrder(ctx, { branchId: saffron, items, paymentMethod: 'COD' });
    await manager.browser.post(
      `/merchant/orders/${before.orderId}/accept`,
      { prepMinutes: 12 },
      key(),
    );
    await ctx.container.outboxRelay.runOnce();
    const waitingDelivery = await ctx.prisma.delivery.findUniqueOrThrow({
      where: { orderId: before.orderId },
    });
    expect(waitingDelivery.status).toBe('PENDING');
    await ctx.prisma.outboxEvent.updateMany({
      where: { publishedAt: null },
      data: { publishedAt: new Date() },
    });
    await ctx.prisma.opsAlert.updateMany({
      where: { type: { in: ['DISPATCH_PAUSED', 'REDIS_UNAVAILABLE'] }, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });

    // The worker's relay (all consumers registered), holding its leader lock in the same Redis.
    const relayed: OutboxEvent[] = [];
    const relay = ctx.container.outboxRelay.on('*', async (e) => {
      relayed.push(e);
    });
    relay.start(50);
    const watchdog = new RedisWatchdog(
      ctx.prisma,
      ctx.redis.core,
      createLogger({ level: 'silent', service: 'worker' }),
      0,
    );
    expect(await watchdog.check()).toBe('ok');

    // ---- Redis goes away ----
    await proxy.down();
    await until(() => ctx.redis.core.status !== 'ready' && ctx.redis.cache.status !== 'ready');

    // Sign-in and refresh fall back to the database (and in-memory rate limits).
    const b = browser(ctx);
    const login = await quick('login', () =>
      b.post('/auth/login', { identifier: customer.phone, password: customer.password }),
    );
    expect(login.status).toBe(200);
    b.remember(login);
    const refreshed = await quick('refresh', () => b.post('/auth/refresh'));
    expect(refreshed.status).toBe(200);
    b.remember(refreshed);
    expect((await quick('authenticated read', () => b.get('/me'))).status).toBe(200);
    // Existing sessions keep working too.
    expect((await quick('existing session', () => customer.browser.get('/me'))).status).toBe(200);

    // An order can be placed (menu from the database, timers left to the sweeper) and accepted.
    const order = await quick(
      'order placement',
      () => placeOrder(ctx, { branchId: saffron, items, paymentMethod: 'COD' }),
      8_000,
    );
    expect(order.order.status).toBe('PLACED');
    const accepted = await quick('acceptance', () =>
      manager.browser.post(`/merchant/orders/${order.orderId}/accept`, { prepMinutes: 12 }, key()),
    );
    expect(accepted.status).toBe(200);

    // Ops are told (through PostgreSQL: every BullMQ-driven check is down with Redis).
    expect(await watchdog.check()).toBe('alerted');
    expect(
      await ctx.prisma.opsAlert.count({ where: { type: 'REDIS_UNAVAILABLE', status: 'OPEN' } }),
    ).toBe(1);
    // Dispatch pauses: a search that starts now is recorded, but no offer is made.
    const d = waitingDelivery;
    await quick('dispatch start', () => ctx.container.dispatch.start(d.id));
    expect((await ctx.prisma.delivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
      'SEARCHING',
    );
    expect(await ctx.prisma.deliveryAssignment.count({ where: { deliveryId: d.id } })).toBe(0);
    expect(
      await ctx.prisma.opsAlert.count({ where: { type: 'DISPATCH_PAUSED', status: 'OPEN' } }),
    ).toBe(1);
    // A partner-facing Redis-only action answers "try again" instead of hanging or crashing.
    const fix = await quick('location while Redis is down', () =>
      rider.browser.post('/partner/me/locations', {
        points: [
          { lat: 12.9356, lng: 77.6246, accuracyM: 8, recordedAt: ctx.clock.now().toISOString() },
        ],
      }),
    );
    expect([200, 202, 503]).toContain(fix.status);

    // The outbox waits: no leader lock without Redis.
    await new Promise((r) => setTimeout(r, 300));
    expect(relayed).toHaveLength(0);
    const waiting = await ctx.prisma.outboxEvent.count({ where: { publishedAt: null } });
    expect(waiting).toBeGreaterThan(0);

    // ---- Redis comes back ----
    await proxy.up();
    await until(() => ctx.redis.core.status === 'ready' && ctx.redis.cache.status === 'ready');

    // The outbox drains, in order, per aggregate; the alert is resolved.
    await until(
      async () => (await ctx.prisma.outboxEvent.count({ where: { publishedAt: null } })) === 0,
    );
    await relay.stop();
    expect(await watchdog.check()).toBe('ok');
    expect(
      await ctx.prisma.opsAlert.count({ where: { type: 'REDIS_UNAVAILABLE', status: 'OPEN' } }),
    ).toBe(0);
    // The order accepted during the outage got its delivery from the drained events.
    expect(
      (await ctx.prisma.delivery.findUniqueOrThrow({ where: { orderId: order.orderId } })).status,
    ).toBe('PENDING');
    expect(relayed.length).toBeGreaterThanOrEqual(waiting);
    const orderEvents = relayed.filter((e) => e.aggregateId === order.orderId);
    expect(orderEvents.map((e) => e.aggregateVersion)).toEqual(
      [...orderEvents.map((e) => e.aggregateVersion)].sort((x, y) => x - y),
    );
    expect(orderEvents.map((e) => e.eventType)).toContain('order.accepted');

    // Dispatch resumes on the next sweep and offers the waiting delivery.
    await ctx.container.dispatch.sweep();
    expect(
      await ctx.prisma.deliveryAssignment.count({ where: { deliveryId: d.id, status: 'OFFERED' } }),
    ).toBe(1);
  });
});
