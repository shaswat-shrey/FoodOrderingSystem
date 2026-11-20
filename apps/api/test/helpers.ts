import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Redis } from 'ioredis';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { PrismaClient, type OrderStatus } from '@fos/db';
import { loadEnv } from '../src/config/env';
import { createContainer, type Container } from '../src/container';
import { hashPassword } from '../src/modules/auth/password';
import { LocalStorageProvider } from '../src/modules/files';
import type { GeocodingProvider } from '../src/modules/geo';
import { RecordingDispatcher } from '../src/modules/notifications';
import { ManualClock } from '../src/platform/clock';
import { createApp } from '../src/platform/http/app';
import { createLogger } from '../src/platform/logger';
import { RecordingJobQueue } from '../src/platform/jobs';
import { mountRawRoutes, mountRoutes } from '../src/routes';
import { apiTestDatabaseUrl } from './global-setup';

export const integrationEnabled = Boolean(apiTestDatabaseUrl() && process.env.TEST_REDIS_URL);

export const ORIGINS = {
  CUSTOMER: 'http://localhost:5173',
  RESTAURANT: 'http://localhost:5174',
  DELIVERY: 'http://localhost:5175',
  ADMIN: 'http://localhost:5176',
} as const;

export interface TestContext {
  app: ReturnType<typeof createApp>;
  container: Container;
  prisma: PrismaClient;
  redis: { core: Redis; cache: Redis };
  clock: ManualClock;
  messages: RecordingDispatcher;
  logs: string[];
  close(): Promise<void>;
}

/** Real PostgreSQL + Redis, manual clock, recorded messages and captured logs. */
export async function createTestContext(
  options: { geocoder?: GeocodingProvider } = {},
): Promise<TestContext> {
  const url = apiTestDatabaseUrl()!;
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    REDIS_CORE_URL: process.env.TEST_REDIS_URL!,
    REDIS_CACHE_URL: process.env.TEST_REDIS_URL!,
    JWT_SIGNING_KEYS: `test-key:${'t'.repeat(40)}`,
    AUTH_HMAC_SECRET: 'h'.repeat(40),
    COOKIE_SECURE: 'false',
  });
  const logs: string[] = [];
  const logger = createLogger({
    level: 'debug',
    service: 'api',
    destination: new Writable({
      write(chunk, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      },
    }),
  });
  const prisma = new PrismaClient({ datasourceUrl: url });
  const core = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  const cache = new Redis(process.env.TEST_REDIS_URL!.replace(/\/\d+$/, '/14'), {
    maxRetriesPerRequest: null,
  });
  await Promise.all([core.flushdb(), cache.flushdb()]);
  // Start the manual clock at real time so database defaults and our timestamps agree.
  const clock = new ManualClock(new Date());
  const messages = new RecordingDispatcher();
  const container = createContainer({
    env,
    prisma,
    redis: { core, cache },
    logger,
    clock,
    messages,
    ...(options.geocoder ? { geocoder: options.geocoder } : {}),
    jobs: new RecordingJobQueue(),
    storage: new LocalStorageProvider(
      mkdtempSync(join(tmpdir(), 'fos-files-')),
      'http://localhost:4000',
      'test-file-signing-secret',
    ),
  });
  const app = createApp({
    logger,
    corsOrigins: Object.values(container.appOrigins),
    readiness: { critical: {}, degradable: {} },
    routes: (api) => mountRoutes(api, container),
    rawRoutes: (app) => mountRawRoutes(app, container),
  });
  return {
    app,
    container,
    prisma,
    redis: { core, cache },
    clock,
    messages,
    logs,
    async close() {
      await prisma.$disconnect();
      core.disconnect();
      cache.disconnect();
    },
  };
}

let phoneCounter = Math.floor(Math.random() * 1_000_000);
/** Unique valid Indian mobile number per call (tests share one database). */
export function uniquePhone(): string {
  phoneCounter = (phoneCounter + 1) % 100_000_000;
  return `+9198${String(phoneCounter).padStart(8, '0')}`;
}

export type App = 'CUSTOMER' | 'RESTAURANT' | 'DELIVERY' | 'ADMIN';

/** A browser for one app: keeps cookies and always sends X-Client-App and Origin. */
export function browser(ctx: TestContext, app: App = 'CUSTOMER') {
  const agent: TestAgent = request.agent(ctx.app);
  let accessToken: string | undefined;
  const withHeaders = (r: request.Test) => {
    r.set('X-Client-App', app).set('Origin', ORIGINS[app]);
    if (accessToken) r.set('Authorization', `Bearer ${accessToken}`);
    return r;
  };
  return {
    agent,
    get token() {
      return accessToken;
    },
    set token(value: string | undefined) {
      accessToken = value;
    },
    get: (path: string, query?: Record<string, string | number | boolean>) =>
      withHeaders(agent.get(`/api/v1${path}`).query(query ?? {})),
    post: (path: string, body?: object, headers: Record<string, string> = {}) =>
      withHeaders(
        agent
          .post(`/api/v1${path}`)
          .set(headers)
          .send(body ?? {}),
      ),
    patch: (path: string, body?: object) =>
      withHeaders(agent.patch(`/api/v1${path}`).send(body ?? {})),
    put: (path: string, body?: object) => withHeaders(agent.put(`/api/v1${path}`).send(body ?? {})),
    delete: (path: string) => withHeaders(agent.delete(`/api/v1${path}`)),
    /** Stores the access token from a sign-in/refresh response. */
    remember(res: request.Response) {
      if (res.body?.data?.accessToken) accessToken = res.body.data.accessToken;
      return res;
    },
  };
}

/** Refresh cookie value from a response, or undefined when absent/cleared. */
export function refreshCookie(res: request.Response, app: App = 'CUSTOMER'): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = header?.find((c) => c.startsWith(`fos_rt_${app.toLowerCase()}=`));
  const value = line?.split(';')[0]?.split('=')[1];
  return value ? decodeURIComponent(value) : undefined;
}

export async function setPassword(
  prisma: PrismaClient,
  userId: string,
  password: string,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  await prisma.userCredential.upsert({
    where: { userId },
    create: { userId, passwordHash },
    update: { passwordHash },
  });
}

/** Registers via the API and verifies the phone, returning a signed-in customer browser. */
export async function signUpCustomer(
  ctx: TestContext,
  overrides: Partial<{ email: string; password: string }> = {},
) {
  const b = browser(ctx, 'CUSTOMER');
  const phone = uniquePhone();
  const email = overrides.email ?? `user${phone.slice(-8)}@example.com`;
  const password = overrides.password ?? 'masala dosa every sunday';
  const res = b.remember(
    await b.post('/auth/register', {
      fullName: 'Test User',
      email,
      phone,
      password,
      acceptTerms: true,
    }),
  );
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const code = ctx.messages.lastOtp(phone)!;
  const verified = await b.post('/auth/phone/verify', { code });
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);
  return {
    browser: b,
    phone,
    email,
    password,
    userId: res.body.data.user.id as string,
    /** Raw refresh token from the sign-up cookie (lets tests replay a stolen token). */
    initialRefreshToken: refreshCookie(res)!,
  };
}

/** ID of a seeded branch, by brand and branch name. */
export async function branchId(
  ctx: TestContext,
  brandName: string,
  branchName: string,
): Promise<string> {
  const branch = await ctx.prisma.branch.findFirstOrThrow({
    where: { name: branchName, restaurant: { brandName } },
    select: { id: true },
  });
  return branch.id;
}

/**
 * Inserts a minimal order (with its cart, address and checkout session) for
 * tests of payments, coupons and the ledger before order creation exists
 * (Phase 7). Amounts are paise.
 */
export async function createFixtureOrder(
  ctx: TestContext,
  input: {
    userId: string;
    branchId: string;
    status?: OrderStatus;
    paymentMethod?: 'ONLINE' | 'COD' | 'WALLET';
    payableAmount?: number;
    walletAppliedAmount?: number;
  },
): Promise<{ orderId: string; number: string; sessionId: string }> {
  const { uuidv7 } = await import('@fos/shared');
  const branch = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: input.branchId } });
  const fees = await ctx.prisma.feeSchedule.findFirstOrThrow({
    orderBy: { effectiveFrom: 'desc' },
  });
  const payable = input.payableAmount ?? 50_000;
  const wallet = input.walletAppliedAmount ?? 0;
  const cart = await ctx.prisma.cart.create({
    data: { userId: input.userId, branchId: branch.id, status: 'CONVERTED' },
  });
  const addressId = uuidv7();
  await ctx.prisma.$executeRaw`
    INSERT INTO customer_addresses (id, user_id, label, line1, area, city, state, pincode, location, contact_name, contact_phone, updated_at, deleted_at)
    VALUES (${addressId}::uuid, ${input.userId}::uuid, 'OTHER', 'Fixture', 'Koramangala', 'Bengaluru', 'Karnataka', '560095',
      ST_SetSRID(ST_MakePoint(77.6245, 12.9352), 4326)::geography, 'Fixture', '+919000000999', now(), now())`;
  const session = await ctx.prisma.checkoutSession.create({
    data: {
      userId: input.userId,
      cartId: cart.id,
      cartHash: 'f'.repeat(64),
      addressId,
      paymentMethod: input.paymentMethod ?? 'ONLINE',
      quote: {},
      payableAmount: payable,
      feeScheduleId: fees.id,
      status: 'CONFIRMED',
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  const number = `T${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 1000)}`.slice(0, 16);
  const status = input.status ?? 'PAYMENT_PENDING';
  const order = await ctx.prisma.order.create({
    data: {
      number,
      userId: input.userId,
      restaurantId: branch.restaurantId,
      branchId: branch.id,
      checkoutSessionId: session.id,
      status,
      ...(status === 'FAILED' ? { failureReason: 'PAYMENT_EXPIRED' as const } : {}),
      paymentMethod: input.paymentMethod ?? 'ONLINE',
      itemsSubtotalAmount: payable + wallet,
      totalAmount: payable + wallet,
      walletAppliedAmount: wallet,
      payableAmount: payable,
      feeScheduleId: fees.id,
      commissionRateBps: 2000,
      contactName: 'Fixture',
      contactPhone: '+919000000999',
      ...(status === 'PAYMENT_PENDING' ? {} : { placedAt: ctx.clock.now() }),
      ...(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED'].includes(status)
        ? { acceptedAt: ctx.clock.now() }
        : {}),
      ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
    },
  });
  return { orderId: order.id, number, sessionId: session.id };
}

/**
 * A signed-up customer places a real order through checkout (API-CHK-004).
 * `walletCredit` is granted first and applied; `coupon` is applied to the cart.
 */
export async function placeOrder(
  ctx: TestContext,
  input: {
    branchId: string;
    items: { foodItemId: string; variantId?: string; optionIds: string[]; quantity: number }[];
    paymentMethod: 'COD' | 'ONLINE';
    walletCredit?: number;
    coupon?: string;
    tipAmount?: number;
  },
) {
  const { uuidv7 } = await import('@fos/shared');
  const c = await signUpCustomer(ctx);
  if (input.walletCredit) {
    await ctx.prisma.$transaction((tx) =>
      ctx.container.wallet.credit(tx, {
        userId: c.userId,
        amount: input.walletCredit!,
        source: 'GOODWILL',
        referenceType: 'test',
        referenceId: uuidv7(),
        description: 'Test credit',
      }),
    );
  }
  const home = (
    await c.browser.post('/me/addresses', {
      label: 'HOME',
      line1: 'Flat 9',
      area: 'Koramangala',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560095',
      location: { lat: 12.9352, lng: 77.6245 },
    })
  ).body.data;
  for (const item of input.items) {
    const added = await c.browser.post('/cart/items', { branchId: input.branchId, ...item });
    if (added.status >= 300) throw new Error(`add to cart failed: ${JSON.stringify(added.body)}`);
  }
  if (input.coupon) await c.browser.post('/cart/coupon', { code: input.coupon });
  const s = (
    await c.browser.post('/checkout/sessions', {
      addressId: home.id,
      paymentMethod: input.paymentMethod,
      useWallet: Boolean(input.walletCredit),
      tipAmount: input.tipAmount ?? 0,
    })
  ).body;
  if (!s.data) throw new Error(`checkout failed: ${JSON.stringify(s)}`);
  const res = await c.browser.post(
    `/checkout/sessions/${s.data.id}/confirm`,
    { expectedPayable: s.data.payableAmount },
    { 'Idempotency-Key': uuidv7() },
  );
  if (res.status !== 201) throw new Error(`confirm failed: ${JSON.stringify(res.body)}`);
  const { order, payment } = res.body.data;
  return {
    ...c,
    orderId: order.id as string,
    order,
    payment,
    payable: s.data.payableAmount as number,
    session: s.data,
    addressId: home.id as string,
  };
}

/** Signs a seeded user into an app with a known password (staff, partners, admins without MFA). */
export async function signInAs(ctx: TestContext, phone: string, app: App = 'RESTAURANT') {
  const user = await ctx.prisma.user.findFirstOrThrow({ where: { phone } });
  const password = 'kitchen pass phrase 42';
  await setPassword(ctx.prisma, user.id, password);
  const b = browser(ctx, app);
  const res = b.remember(await b.post('/auth/login', { identifier: phone, password }));
  if (res.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(res.body)}`);
  return { browser: b, userId: user.id };
}

/** Seeded Saffron Handi Biryani staff (packages/db seed). */
export const SAFFRON_STAFF = {
  owner: '+919000000201',
  manager: '+919000000301',
  kitchen: '+919000000302',
} as const;
