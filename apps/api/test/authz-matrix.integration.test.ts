import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@fos/shared';
import {
  browser,
  createTestContext,
  integrationEnabled,
  ORIGINS,
  SAFFRON_STAFF,
  setPassword,
  signInAs,
  signUpCustomer,
  uniquePhone,
  type App,
  type TestContext,
} from './helpers';

/**
 * Authorization matrix (TESTING-STRATEGY §2, SRS §22): generated from the routes
 * actually mounted on the Express app × role fixtures. Every protected route must
 * turn away anonymous callers and callers from the wrong app or role with
 * 401/403/404 — never a 2xx (it ran) or a 5xx (it crashed before deciding).
 * Requests carry random ids and empty bodies, so nothing is created even if a
 * check were missing; rejected requests never reach a handler.
 */
const suite = integrationEnabled ? describe : describe.skip;

type Audience = 'PUBLIC' | 'ANY_APP' | App;

/** Who a route is for, by path (first match wins). Unknown paths fail the test. */
const AUDIENCE: [RegExp, Audience][] = [
  [/^\/health\//, 'PUBLIC'],
  [/^\/api\/v1\/auth\//, 'PUBLIC'], // sign-in flows; covered by auth.integration
  [/^\/api\/v1\/payments\/webhooks\//, 'PUBLIC'], // provider signature, not a session
  [/^\/api\/v1\/payments\/methods\/$/, 'PUBLIC'],
  [/^\/api\/v1\/\^/, 'PUBLIC'], // signed media and private-file links
  [/^\/api\/v1\/(geo|discovery|search|branches|restaurants|help|legal|coupons)(\/|$)/, 'PUBLIC'],
  [/^\/api\/v1\/merchant\/invitations\/:token$/, 'PUBLIC'], // invitation preview by its secret
  [/^\/api\/v1\/admin\//, 'ADMIN'],
  [/^\/api\/v1\/merchant\//, 'RESTAURANT'],
  [/^\/api\/v1\/partner\//, 'DELIVERY'],
  [/^\/api\/v1\/support\//, 'ANY_APP'], // every app has a help desk (FR-SUP)
  [/^\/api\/v1\/reviews\/:reviewId\/reports$/, 'ANY_APP'], // FR-REV-005
  [/^\/api\/v1\/(cart|checkout|orders|payments|refunds|reviews)(\/|$)/, 'CUSTOMER'],
  [
    /^\/api\/v1\/me\/(addresses|favorites|wallet|search-history|orders|payments|refunds|reviews)(\/|$)/,
    'CUSTOMER',
  ],
  [/^\/api\/v1\/(me|files)(\/|$)/, 'ANY_APP'],
];

/** Public routes that still personalise for a signed-in customer (optional authentication). */
const PUBLIC_EXCEPTIONS: Record<string, Audience> = {
  'GET /api/v1/discovery/order-again': 'CUSTOMER',
  'POST /api/v1/coupons/validate': 'CUSTOMER',
};

interface Route {
  method: string;
  path: string;
}

/** Walks the Express 5 router stack, joining mount paths. */
function mountedRoutes(app: unknown): Route[] {
  const out: Route[] = [];
  type Layer = {
    rawPath?: unknown;
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
  };
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods))
          out.push({ method: m.toUpperCase(), path: `${prefix}${layer.route.path}` });
      } else if (layer.handle?.stack) {
        const raw = typeof layer.rawPath === 'string' ? layer.rawPath : '/';
        walk(layer.handle.stack, prefix + (raw === '/' ? '' : raw));
      }
    }
  };
  walk((app as { router: { stack: Layer[] } }).router.stack, '');
  return out;
}

function audienceOf(route: Route): Audience | undefined {
  const exception = PUBLIC_EXCEPTIONS[`${route.method} ${route.path}`];
  if (exception) return exception;
  return AUDIENCE.find(([re]) => re.test(route.path))?.[1];
}

/** Concrete URL: every `:param` becomes a random (nonexistent) UUID. */
const concrete = (path: string) => path.replace(/:\w+/g, () => uuidv7());

interface Caller {
  name: string;
  app: App;
  token?: string;
  /** For ADMIN routes: a platform role below the route's permission is "wrong" only by permission. */
}

let ctx: TestContext;
const callers: Caller[] = [];

/**
 * A fresh platform user with one role (seeded admins may have been changed by other
 * test files), signed in to the admin app with the emailed second factor (BR-AUTH-018).
 */
async function signInAdmin(role: 'SUPPORT_AGENT' | 'ADMIN'): Promise<string> {
  const suffix = uniquePhone().slice(-8);
  const email = `matrix-${role.toLowerCase()}-${suffix}@example.com`;
  const now = new Date();
  const user = await ctx.prisma.user.create({
    data: {
      fullName: `Matrix ${role}`,
      email,
      phone: uniquePhone(),
      status: 'ACTIVE',
      emailVerifiedAt: now,
      phoneVerifiedAt: now,
      roles: { create: { role: { connect: { key: role } } } },
    },
  });
  await setPassword(ctx.prisma, user.id, 'matrix admin passphrase');
  const b = browser(ctx, 'ADMIN');
  const first = await b.post('/auth/login', {
    identifier: email,
    password: 'matrix admin passphrase',
  });
  if (!first.body.data?.mfaToken) throw new Error(`admin sign-in: ${JSON.stringify(first.body)}`);
  const done = await b.post('/auth/mfa/challenge', {
    mfaToken: first.body.data.mfaToken,
    code: ctx.messages.lastOtp(email)!,
  });
  return done.body.data.accessToken as string;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  const customer = await signUpCustomer(ctx);
  const partner = await signInAs(ctx, '+919000000404', 'DELIVERY');
  const staff = await signInAs(ctx, SAFFRON_STAFF.manager, 'RESTAURANT');
  callers.push(
    { name: 'anonymous', app: 'CUSTOMER' },
    { name: 'customer', app: 'CUSTOMER', token: customer.browser.token! },
    { name: 'partner', app: 'DELIVERY', token: partner.browser.token! },
    { name: 'restaurant staff', app: 'RESTAURANT', token: staff.browser.token! },
    { name: 'support agent', app: 'ADMIN', token: await signInAdmin('SUPPORT_AGENT') },
    { name: 'admin', app: 'ADMIN', token: await signInAdmin('ADMIN') },
  );
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});

function call(route: Route, caller: Caller) {
  const url = concrete(route.path);
  const agent = request(ctx.app);
  const req =
    route.method === 'GET'
      ? agent.get(url)
      : route.method === 'DELETE'
        ? agent.delete(url)
        : route.method === 'PATCH'
          ? agent.patch(url).send({})
          : route.method === 'PUT'
            ? agent.put(url).send({})
            : agent.post(url).send({});
  req
    .set('X-Client-App', caller.app)
    .set('Origin', ORIGINS[caller.app])
    .set('Idempotency-Key', uuidv7())
    .set('If-Match', '"1"');
  if (caller.token) req.set('Authorization', `Bearer ${caller.token}`);
  return req;
}

suite('authorization matrix (routes × roles)', () => {
  it('knows the audience of every mounted route', () => {
    const routes = mountedRoutes(ctx.app);
    expect(routes.length).toBeGreaterThan(300);
    const unknown = routes.filter((r) => !audienceOf(r)).map((r) => `${r.method} ${r.path}`);
    expect(unknown, 'add these routes to AUDIENCE').toEqual([]);
  });

  it('rejects the wrong app or role on every protected route with 401/403/404', async () => {
    const routes = mountedRoutes(ctx.app);
    const failures: string[] = [];
    let checked = 0;
    for (const route of routes) {
      const audience = audienceOf(route);
      if (!audience || audience === 'PUBLIC') continue;
      for (const caller of callers) {
        const wrong = !caller.token || (audience !== 'ANY_APP' && caller.app !== audience);
        if (!wrong) continue;
        const res = await call(route, caller);
        checked++;
        const expected = caller.token ? [401, 403, 404] : [401];
        if (!expected.includes(res.status))
          failures.push(
            `${route.method} ${route.path} as ${caller.name}: ${res.status} ${res.body?.error?.code ?? ''}`,
          );
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(failures).toEqual([]);
  });

  it('never fails with a server error for the right app (reads only)', async () => {
    // Right-app GETs with unknown ids: 2xx, 403 (permission) or 404 — not 5xx.
    const failures: string[] = [];
    for (const route of mountedRoutes(ctx.app)) {
      if (route.method !== 'GET') continue;
      const audience = audienceOf(route);
      if (!audience || audience === 'PUBLIC') continue;
      for (const caller of callers.filter(
        (c) => c.token && (audience === 'ANY_APP' || c.app === audience),
      )) {
        const res = await call(route, caller);
        if (res.status >= 500)
          failures.push(`${route.method} ${route.path} as ${caller.name}: ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
