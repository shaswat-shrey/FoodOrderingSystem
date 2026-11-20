import { Writable } from 'node:stream';
import { Redis } from 'ioredis';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { PrismaClient } from '@fos/db';
import { loadEnv } from '../src/config/env';
import { createContainer, type Container } from '../src/container';
import { authRouter } from '../src/modules/auth';
import { hashPassword } from '../src/modules/auth/password';
import { RecordingDispatcher } from '../src/modules/notifications';
import { usersRouter } from '../src/modules/users';
import { ManualClock } from '../src/platform/clock';
import { createApp } from '../src/platform/http/app';
import { createLogger } from '../src/platform/logger';
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
export async function createTestContext(): Promise<TestContext> {
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
  });
  const app = createApp({
    logger,
    corsOrigins: Object.values(container.appOrigins),
    readiness: { critical: {}, degradable: {} },
    routes: (api) => {
      api.use(
        '/auth',
        authRouter({ ...container, cookieSecure: false, hmacSecret: env.AUTH_HMAC_SECRET }),
      );
      api.use(usersRouter(container));
    },
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
    get: (path: string) => withHeaders(agent.get(`/api/v1${path}`)),
    post: (path: string, body?: object) =>
      withHeaders(agent.post(`/api/v1${path}`).send(body ?? {})),
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
