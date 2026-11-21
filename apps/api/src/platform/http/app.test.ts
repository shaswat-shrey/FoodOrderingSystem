import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { createApp } from './app';
import { AppError } from './errors';
import type { ReadinessChecks } from '../health/readiness';

const logger = createLogger({ level: 'silent', service: 'api' });
const up = async () => {};
const down = async () => {
  throw new Error('connection refused');
};

function makeApp(
  readiness: ReadinessChecks = { critical: { database: up }, degradable: { redisCore: up } },
) {
  return createApp({ logger, corsOrigins: ['http://localhost:5173'], readiness });
}

describe('HTTP platform', () => {
  it('API-SYS-001 liveness returns ok without the envelope', async () => {
    const res = await request(makeApp()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('API-SYS-002 readiness is ok when all dependencies are up', async () => {
    const res = await request(makeApp()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.status).toBe('up');
  });

  it('NFR-AVAIL-004 readiness is degraded (200) when only Redis is down', async () => {
    const res = await request(
      makeApp({ critical: { database: up }, degradable: { redisCore: down } }),
    ).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redisCore).toEqual({ status: 'down', error: 'unreachable' });
    // The raw driver message must not leak to callers.
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });

  it('NFR-AVAIL-005 readiness is unavailable (503) when the database is down', async () => {
    const res = await request(
      makeApp({ critical: { database: down }, degradable: { redisCore: up } }),
    ).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');
  });

  it('returns 404 in the standard error envelope with a request id', async () => {
    const res = await request(makeApp()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', details: [], retryable: false },
    });
    expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
  });

  it('NFR-OBS-002 echoes a safe client request id and replaces unsafe ones', async () => {
    const ok = await request(makeApp()).get('/health/live').set('X-Request-Id', 'client-req-12345');
    expect(ok.headers['x-request-id']).toBe('client-req-12345');
    const unsafe = await request(makeApp())
      .get('/health/live')
      .set('X-Request-Id', 'bad id <script>');
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('NFR-SEC-004 rejects malformed JSON, oversized and non-JSON bodies', async () => {
    const app = makeApp();
    const malformed = await request(app)
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');

    const huge = await request(app)
      .post('/api/v1/anything')
      .send({ blob: 'x'.repeat(110 * 1024) });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const text = await request(app)
      .post('/api/v1/anything')
      .set('Content-Type', 'text/plain')
      .send('hi');
    expect(text.status).toBe(415);
    expect(text.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('NFR-SEC-008/009 sets security headers and only allows listed origins', async () => {
    const allowed = await request(makeApp())
      .get('/health/live')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['x-powered-by']).toBeUndefined();
    const denied = await request(makeApp())
      .get('/health/live')
      .set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('NFR-SEC-001/006/008 sends the API security headers', async () => {
    const res = await request(makeApp()).get('/health/live');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['permissions-policy']).toContain('geolocation=()');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('NFR-SEC-009 allows credentials only on auth routes', async () => {
    const origin = 'http://localhost:5173';
    const auth = await request(makeApp())
      .options('/api/v1/auth/refresh')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST');
    expect(auth.headers['access-control-allow-origin']).toBe(origin);
    expect(auth.headers['access-control-allow-credentials']).toBe('true');
    const other = await request(makeApp())
      .options('/api/v1/orders')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST');
    expect(other.headers['access-control-allow-origin']).toBe(origin);
    expect(other.headers['access-control-allow-credentials']).toBeUndefined();
    expect(other.headers['access-control-allow-headers']).toContain('Authorization');
  });
});

describe('refresh cookie flags (NFR-SEC-007, ADR-003)', () => {
  it('is HttpOnly, Secure in production, SameSite=Strict and scoped to /api/v1/auth', async () => {
    const { setRefreshCookie, clearRefreshCookie } = await import('../../modules/auth/cookies');
    const app = express();
    app.get('/set', (_req, res) => {
      const now = new Date();
      setRefreshCookie(res, 'CUSTOMER', 'tok', new Date(now.getTime() + 60_000), true, now);
      res.end();
    });
    app.get('/clear', (_req, res) => {
      clearRefreshCookie(res, 'CUSTOMER', true);
      res.end();
    });
    const set = String((await request(app).get('/set')).headers['set-cookie']);
    expect(set).toMatch(/^fos_rt_customer=tok;/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/v1/auth', 'Max-Age=60'])
      expect(set).toContain(flag);
    const cleared = String((await request(app).get('/clear')).headers['set-cookie']);
    expect(cleared).toContain('Path=/api/v1/auth');
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});

describe('error handler (ERR-002/004)', () => {
  // Mount throwing routes on a minimal app using the same error handler.
  async function errorResponse(error: unknown) {
    const { errorHandler } = await import('./middleware/error-handler');
    const { requestId } = await import('./middleware/request-id');
    const app = express();
    app.use(requestId());
    app.get('/boom', () => {
      throw error;
    });
    app.use(errorHandler(logger));
    return request(app).get('/boom');
  }

  it('maps AppError to its code, status and safe message', async () => {
    const res = await errorResponse(
      new AppError('FORBIDDEN', { details: [{ code: 'NOT_MEMBER', message: 'Not a member' }] }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      message: "You don't have access to this.",
      error: { code: 'FORBIDDEN', retryable: false, details: [{ code: 'NOT_MEMBER' }] },
    });
  });

  it('never leaks internals for unexpected errors', async () => {
    const res = await errorResponse(
      new Error('relation "users" does not exist at /srv/app/db.ts:42'),
    );
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('relation');
    expect(JSON.stringify(res.body)).not.toContain('db.ts');
  });
});
