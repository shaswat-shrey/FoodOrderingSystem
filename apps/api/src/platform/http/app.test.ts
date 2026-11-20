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
