#!/usr/bin/env node
// Generates docs/api/openapi.json (OpenAPI 3.1) from the routes actually mounted on
// the API's Express app, so the document cannot drift from the implementation
// (NFR-MAINT-006).
//
//   pnpm docs:api            (runs this file with tsx from apps/api)
//   pnpm docs:api --check    (exit 1 if docs/api/openapi.json is out of date)
//
// How it works:
// 1. A module hook (openapi-hooks.mjs) makes `handle()` expose each route's Zod
//    schemas; nothing else about the app changes.
// 2. The app is built with the same factory and route mounting as the server and the
//    integration tests (createApp + mountRoutes/mountRawRoutes), with lazy database
//    and Redis clients that never connect.
// 3. The Express 5 router stack is walked (as in apps/api/test/authz-matrix
//    .integration.test.ts); body/query/params schemas become JSON Schema through
//    zod 4's z.toJSONSchema (input side).
// 4. Summaries, requirement IDs and permissions come from the API-* tables in
//    docs/requirements/API-SPECIFICATION.md, matched on method + path.
//
// Response bodies are described by the common envelope only (handlers build their
// responses in code, not from schemas).

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { register, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

register('./openapi-hooks.mjs', import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = join(ROOT, 'apps', 'api');
const OUT = join(ROOT, 'docs', 'api', 'openapi.json');
const SPEC = join(ROOT, 'docs', 'requirements', 'API-SPECIFICATION.md');
const check = process.argv.includes('--check');

const apiRequire = createRequire(join(API, 'package.json'));
const load = (spec) => import(pathToFileURL(apiRequire.resolve(spec)).href);
const src = (path) => import(pathToFileURL(join(API, 'src', path)).href);

const { z } = await import(
  pathToFileURL(createRequire(join(ROOT, 'packages', 'validation', 'package.json')).resolve('zod'))
    .href
);
const { PrismaClient } = await load('@prisma/client');
const { Redis } = await load('ioredis');
const { loadEnv } = await src('config/env.ts');
const { createContainer } = await src('container.ts');
const { createApp } = await src('platform/http/app.ts');
const { createLogger } = await src('platform/logger.ts');
const { systemClock } = await src('platform/clock.ts');
const { RecordingJobQueue } = await src('platform/jobs.ts');
const { RecordingRealtime } = await src('platform/realtime/publisher.ts');
const { RecordingDispatcher } = await src('modules/notifications/index.ts');
const { LocalStorageProvider } = await src('modules/files/index.ts');
const { mountRoutes, mountRawRoutes } = await src('routes.ts');
const { OPENAPI_SCHEMAS } = await import('./openapi-handler.mjs');

// ---------------------------------------------------------------------------
// 1. Build the app without touching any service.
// ---------------------------------------------------------------------------
const env = loadEnv({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi',
  REDIS_CORE_URL: 'redis://127.0.0.1:1',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1',
  JWT_SIGNING_KEYS: `openapi:${'x'.repeat(40)}`,
  AUTH_HMAC_SECRET: 'x'.repeat(40),
  STORAGE_DRIVER: 'local',
  PAYMENT_PROVIDER: 'mock',
  GEO_PROVIDER: 'mock',
});
const logger = createLogger({ level: 'silent', service: 'openapi' });
const storageDir = mkdtempSync(join(tmpdir(), 'fos-openapi-')); // never written to; removed below
const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
const redisOptions = { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false };
const core = new Redis(env.REDIS_CORE_URL, redisOptions);
const cache = new Redis(env.REDIS_CACHE_URL, redisOptions);
for (const client of [core, cache]) client.on('error', () => undefined);
const container = createContainer({
  env,
  prisma,
  redis: { core, cache },
  logger,
  clock: systemClock,
  messages: new RecordingDispatcher(),
  jobs: new RecordingJobQueue(),
  realtime: new RecordingRealtime(),
  storage: new LocalStorageProvider(
    storageDir,
    'http://localhost:4000',
    'openapi-file-signing-secret',
  ),
});
const app = createApp({
  logger,
  corsOrigins: [],
  readiness: { critical: {}, degradable: {} },
  routes: (api) => mountRoutes(api, container),
  rawRoutes: (a) => mountRawRoutes(a, container),
});

// ---------------------------------------------------------------------------
// 2. Walk the router stack.
// ---------------------------------------------------------------------------
function mountedRoutes(expressApp) {
  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const handlers = layer.route.stack.map((l) => l.handle);
        const schemas = handlers.map((h) => h?.[OPENAPI_SCHEMAS]).find(Boolean);
        for (const m of Object.keys(layer.route.methods)) {
          if (m === '_all') continue;
          out.push({ method: m.toUpperCase(), path: `${prefix}${layer.route.path}`, schemas });
        }
      } else if (layer.handle?.stack) {
        const raw = typeof layer.rawPath === 'string' ? layer.rawPath : '/';
        walk(layer.handle.stack, prefix + (raw === '/' ? '' : raw));
      }
    }
  };
  walk(expressApp.router.stack, '');
  const seen = new Set();
  return out.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 3. The SRS API inventory (summaries, IDs, permissions).
// ---------------------------------------------------------------------------
const normalise = (path) =>
  path
    .replace(/^\/api\/v1/, '')
    .replace(/\{[^}]+\}/g, '{}')
    .replace(/:\w+/g, '{}')
    .replace(/\/$/, '');

const inventory = new Map();
let sectionPrefix = '';
for (const line of readFileSync(SPEC, 'utf8').split('\n')) {
  // Sections may say "All paths prefixed `/admin`" (admin, restaurant menu management).
  if (line.startsWith('### ')) sectionPrefix = '';
  const prefixed = line.match(/^All paths prefixed `([^`]+)`/);
  if (prefixed) sectionPrefix = prefixed[1];
  const m = line.match(/^\| (API-[A-Z]+-\d{3}) \| (GET|POST|PUT|PATCH|DELETE) `([^`]+)`[^|]*\|([^|]*)\|([^|]*)\|/);
  if (!m) continue;
  const [, id, method, path, purpose, fourth] = m;
  const auth = /^\s*FR-/.test(fourth) ? undefined : fourth.trim();
  let bare = path.split('?')[0].split(' ')[0];
  if (sectionPrefix && !bare.startsWith(sectionPrefix) && !bare.startsWith('/merchant/'))
    bare = `${sectionPrefix}${bare}`;
  const key = `${method} ${normalise(bare)}`;
  if (!inventory.has(key)) inventory.set(key, { id, purpose: purpose.trim(), auth });
}

// ---------------------------------------------------------------------------
// 4. Who a route is for (same rules as the authorization matrix test).
// ---------------------------------------------------------------------------
const AUDIENCE = [
  [/^\/health\//, 'PUBLIC'],
  [/^\/api\/v1\/auth\//, 'PUBLIC'],
  [/^\/api\/v1\/payments\/webhooks\//, 'WEBHOOK'],
  [/^\/api\/v1\/payments\/methods\/?$/, 'PUBLIC'],
  [/^\/api\/v1\/\^/, 'PUBLIC'],
  [/^\/api\/v1\/(geo|discovery|search|branches|restaurants|help|legal|coupons)(\/|$)/, 'PUBLIC'],
  [/^\/api\/v1\/merchant\/invitations\/:token$/, 'PUBLIC'],
  [/^\/api\/v1\/admin\//, 'ADMIN'],
  [/^\/api\/v1\/merchant\//, 'RESTAURANT'],
  [/^\/api\/v1\/partner\//, 'DELIVERY'],
  [/^\/api\/v1\/support\//, 'ANY_APP'],
  [/^\/api\/v1\/reviews\/:reviewId\/reports$/, 'ANY_APP'],
  [/^\/api\/v1\/(cart|checkout|orders|payments|refunds|reviews)(\/|$)/, 'CUSTOMER'],
  [
    /^\/api\/v1\/me\/(addresses|favorites|wallet|search-history|orders|payments|refunds|reviews)(\/|$)/,
    'CUSTOMER',
  ],
  [/^\/api\/v1\/(me|files)(\/|$)/, 'ANY_APP'],
];
const OPTIONAL_AUTH = new Set(['GET /api/v1/discovery/order-again', 'POST /api/v1/coupons/validate']);
const audienceOf = (method, path) =>
  AUDIENCE.find(([re]) => re.test(path))?.[1] ?? 'ANY_APP';

// ---------------------------------------------------------------------------
// 5. Build the document.
// ---------------------------------------------------------------------------
/** zod adds a regex next to `format` (uuid, email, date-time…); the format says enough. */
function stripFormatPatterns(node) {
  if (Array.isArray(node)) node.forEach(stripFormatPatterns);
  else if (node && typeof node === 'object') {
    if (typeof node.format === 'string' && typeof node.pattern === 'string') delete node.pattern;
    Object.values(node).forEach(stripFormatPatterns);
  }
  return node;
}

function jsonSchema(schema) {
  if (!schema) return undefined;
  try {
    const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' });
    delete out.$schema;
    return stripFormatPatterns(out);
  } catch {
    return {};
  }
}

const TAGS = [
  ['System', /^\/health\//],
  ['Auth', /^\/api\/v1\/auth\//],
  ['Admin', /^\/api\/v1\/admin\//],
  ['Restaurant (merchant)', /^\/api\/v1\/merchant\//],
  ['Delivery partner', /^\/api\/v1\/partner\//],
  ['Payments', /^\/api\/v1\/(payments|refunds)(\/|$)|^\/api\/v1\/me\/(payments|refunds|wallet)/],
  ['Cart & checkout', /^\/api\/v1\/(cart|checkout|coupons)(\/|$)/],
  ['Orders & tracking', /^\/api\/v1\/(orders|me\/orders)(\/|$)/],
  ['Discovery & search', /^\/api\/v1\/(discovery|search|me\/search-history)(\/|$)/],
  ['Restaurants & menus', /^\/api\/v1\/(restaurants|branches)(\/|$)/],
  ['Locations & addresses', /^\/api\/v1\/(geo|me\/addresses)(\/|$)/],
  ['Reviews', /^\/api\/v1\/(reviews|me\/reviews)(\/|$)/],
  ['Support & content', /^\/api\/v1\/(support|help|legal)(\/|$)/],
  ['Notifications', /^\/api\/v1\/me\/notifications/],
  ['Files', /^\/api\/v1\/(files|\^)/],
  ['Account', /^\/api\/v1\/me(\/|$)/],
];
const tagOf = (path) => TAGS.find(([, re]) => re.test(path))?.[0] ?? 'Other';

const toOpenApiPath = (path) =>
  path.startsWith('/api/v1/^')
    ? null // regex routes (signed media links); documented in docs/api/README.md
    : path.replace(/:(\w+)/g, '{$1}').replace(/(.)\/$/, '$1');

function parametersFrom(schema, location, pathParams) {
  const params = [];
  const js = jsonSchema(schema);
  const props = js?.properties ?? {};
  const required = new Set(js?.required ?? []);
  for (const [name, prop] of Object.entries(props)) {
    params.push({
      name,
      in: location,
      required: location === 'path' ? true : required.has(name),
      schema: prop,
    });
  }
  if (location === 'path') {
    for (const name of pathParams)
      if (!props[name]) params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  return params;
}

const routes = mountedRoutes(app);
const paths = {};
let withSchemas = 0;
const withoutHandle = [];
let matched = 0;
const opIds = new Set();

for (const route of routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
  const path = toOpenApiPath(route.path);
  if (!path) continue;
  const spec = inventory.get(`${route.method} ${normalise(route.path)}`);
  if (spec) matched++;
  const audience = OPTIONAL_AUTH.has(`${route.method} ${route.path}`)
    ? 'OPTIONAL'
    : audienceOf(route.method, route.path);
  // /auth routes: public unless the SRS inventory says otherwise (logout, sessions, …).
  const isPublicAuth = route.path.startsWith('/api/v1/auth/')
    ? !spec?.auth || /^public/i.test(spec.auth)
    : true;
  const pathParams = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
  const s = route.schemas ?? {};
  if (s.body || s.query || s.params) withSchemas++;
  if (!route.schemas) withoutHandle.push(`${route.method} ${route.path}`);

  const op = {
    operationId: undefined,
    tags: [tagOf(route.path)],
    summary: spec?.purpose ?? `${route.method} ${path}`,
  };
  const notes = [];
  if (spec) notes.push(`SRS: ${spec.id}.`);
  if (spec?.auth) notes.push(`Access (SRS notation): ${spec.auth}.`);
  if (audience !== 'PUBLIC' && audience !== 'WEBHOOK')
    notes.push(
      audience === 'OPTIONAL'
        ? 'Authentication optional (personalised for a signed-in customer).'
        : audience === 'ANY_APP'
          ? 'Any signed-in user; `X-Client-App` must match the token audience.'
          : `Signed-in ${audience} app user (\`X-Client-App: ${audience}\`).`,
    );
  if (audience === 'WEBHOOK') notes.push('Authenticated by the provider signature, not a session.');
  if (notes.length) op.description = notes.join(' ');

  let base = `${route.method.toLowerCase()}${path
    .replace(/^\/api\/v1/, '')
    .replace(/\{(\w+)\}/g, 'By$1')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')}`;
  let opId = base;
  for (let n = 2; opIds.has(opId); n++) opId = `${base}${n}`;
  opIds.add(opId);
  op.operationId = opId;
  if (spec) op['x-srs-id'] = spec.id;

  const parameters = [
    ...parametersFrom(s.params, 'path', pathParams),
    ...parametersFrom(s.query, 'query', []),
  ];
  if (path.startsWith('/api/v1/'))
    parameters.push({ $ref: '#/components/parameters/ClientApp' });
  if (parameters.length) op.parameters = parameters;

  if (s.body) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: jsonSchema(s.body) } },
    };
  } else if (/\/uploads?(\/|$)|\/files$|avatar/.test(route.path) && route.method !== 'GET' && route.method !== 'DELETE') {
    op.requestBody = {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: ['purpose', 'file'],
            properties: {
              purpose: { type: 'string', description: 'Upload purpose (BR-FILE-001), sent before the file part' },
              file: { type: 'string', format: 'binary' },
            },
          },
        },
      },
    };
  }

  if (audience === 'PUBLIC' && isPublicAuth) op.security = [];
  else if (audience === 'WEBHOOK') op.security = [];
  else if (audience === 'OPTIONAL') op.security = [{}, { bearerAuth: [] }];

  op.responses = path.startsWith('/health/')
    ? { 200: { description: 'Healthy' }, 503: { description: 'Not ready' } }
    : {
        '2XX': { $ref: '#/components/responses/Success' },
        400: { $ref: '#/components/responses/Error' },
        ...(op.security?.length === 0 ? {} : { 401: { $ref: '#/components/responses/Error' } }),
        403: { $ref: '#/components/responses/Error' },
        404: { $ref: '#/components/responses/Error' },
        409: { $ref: '#/components/responses/Error' },
        422: { $ref: '#/components/responses/Error' },
        429: { $ref: '#/components/responses/Error' },
      };

  paths[path] ??= {};
  paths[path][route.method.toLowerCase()] = op;
}

const tagNames = [...new Set(Object.values(paths).flatMap((p) => Object.values(p).flatMap((o) => o.tags)))].sort();

const document = {
  openapi: '3.1.0',
  info: {
    title: 'FoodOrderSystem API',
    version: '1.0.0-mvp',
    summary: 'REST API of the online food ordering and delivery platform (FOS-SRS-001 §14).',
    description:
      'Generated by `pnpm docs:api` from the routes mounted on the Express app and their Zod validators; summaries and SRS IDs come from docs/requirements/API-SPECIFICATION.md. Do not edit by hand. Responses use the common envelope (`success`, `message`, `data`, `meta` or `error`); see docs/api/README.md.',
  },
  servers: [
    { url: 'http://localhost:4000', description: 'Local development' },
  ],
  tags: tagNames.map((name) => ({ name })),
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Access token from /auth/otp/login, /auth/login, /auth/mfa/challenge or /auth/refresh. The refresh token is an httpOnly cookie scoped to /api/v1/auth.',
      },
    },
    parameters: {
      ClientApp: {
        name: 'X-Client-App',
        in: 'header',
        required: false,
        description:
          'Calling app. Required on browser requests and on every authenticated request; must match the token audience and the request Origin.',
        schema: { type: 'string', enum: ['CUSTOMER', 'RESTAURANT', 'DELIVERY', 'ADMIN'] },
      },
    },
    schemas: {
      Meta: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          pagination: { type: 'object', additionalProperties: true },
        },
      },
      SuccessEnvelope: {
        type: 'object',
        required: ['success'],
        properties: {
          success: { const: true },
          message: { type: 'string' },
          data: {},
          meta: { $ref: '#/components/schemas/Meta' },
        },
      },
      ErrorEnvelope: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { const: false },
          message: { type: 'string' },
          error: {
            type: 'object',
            required: ['code'],
            properties: {
              code: { type: 'string', examples: ['VALIDATION_ERROR', 'NOT_FOUND', 'RATE_LIMITED'] },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    code: { type: 'string' },
                    message: { type: 'string' },
                  },
                },
              },
              retryable: { type: 'boolean' },
            },
          },
          meta: { $ref: '#/components/schemas/Meta' },
        },
      },
    },
    responses: {
      Success: {
        description: 'Success envelope',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } },
      },
      Error: {
        description: 'Error envelope (see docs/requirements/ERROR-HANDLING.md for codes)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    },
  },
};

const json = `${JSON.stringify(document, null, 2)}\n`;
const operations = Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0);
const summary = `${Object.keys(paths).length} paths, ${operations} operations (${withSchemas} with request schemas, ${matched} matched to SRS IDs; not validated by handle(): ${withoutHandle.join(', ')})`;

await prisma.$disconnect().catch(() => undefined);
rmSync(storageDir, { recursive: true, force: true });
core.disconnect();
cache.disconnect();

if (check) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== json) {
    console.error(`docs/api/openapi.json is out of date — run pnpm docs:api (${summary})`);
    process.exit(1);
  }
  console.log(`docs/api/openapi.json is up to date: ${summary}`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`Wrote docs/api/openapi.json: ${summary}`);
}
process.exit(0);
