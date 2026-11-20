import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { PrismaClient } from '@fos/db';
import { AppError } from '../errors';

const TTL_MS = 24 * 3_600_000; // FR-ORDER-002: kept for 24 h
const WAIT_MS = 5_000;
const POLL_MS = 100;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable JSON: object keys sorted, so field order doesn't change the hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Idempotency-Key handling (FR-ORDER-002, FR-PAY-007, PAYMENT-ARCHITECTURE §5).
 * Requires an authenticated user. The first request with a key runs; repeats
 * with the same body get the stored response with `Idempotent-Replayed: true`;
 * the same key with a different body is 409 IDEMPOTENCY_KEY_REUSED. A
 * concurrent duplicate waits briefly for the first to finish. Server errors
 * (5xx) are not stored, so the client can retry with the same key.
 */
export function idempotent(prisma: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    const key = req.header('idempotency-key');
    if (!key || !KEY.test(key)) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'An Idempotency-Key header (UUID) is required.',
        details: [{ path: 'Idempotency-Key', code: 'REQUIRED', message: 'UUID required' }],
      });
    }
    const userId = res.locals.auth?.userId;
    if (!userId) throw new AppError('AUTH_TOKEN_MISSING');
    const path = req.baseUrl + req.path;
    const requestHash = createHash('sha256')
      .update(`${req.method} ${path}\n${canonical(req.body)}`)
      .digest();

    await prisma.idempotencyKey.deleteMany({
      where: { userId, key, expiresAt: { lt: new Date() } },
    });
    const inserted = await prisma.$executeRaw`
      INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, status, expires_at)
      VALUES (${userId}::uuid, ${key}::uuid, ${req.method}, ${path.slice(0, 255)}, ${requestHash},
        'IN_PROGRESS', ${new Date(Date.now() + TTL_MS)})
      ON CONFLICT DO NOTHING`;

    if (inserted === 0) {
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const row = await prisma.idempotencyKey.findUnique({
          where: { userId_key: { userId, key } },
        });
        if (!row)
          return next(
            new AppError('CONFLICT_STALE_VERSION', { message: 'Please retry.', retryable: true }),
          );
        if (
          row.method !== req.method ||
          row.path !== path.slice(0, 255) ||
          !Buffer.from(row.requestHash).equals(requestHash)
        ) {
          return next(
            new AppError('IDEMPOTENCY_KEY_REUSED', {
              message: 'This Idempotency-Key was used for a different request.',
            }),
          );
        }
        if (row.status === 'COMPLETED') {
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(row.responseCode ?? 200).json(row.responseBody);
          return;
        }
        if (Date.now() > deadline) {
          return next(
            new AppError('IDEMPOTENCY_KEY_REUSED', {
              message: 'The original request is still being processed. Try again shortly.',
              retryable: true,
            }),
          );
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    }

    // First request: capture its JSON response.
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const done =
        status >= 500
          ? prisma.idempotencyKey.delete({ where: { userId_key: { userId, key } } })
          : prisma.idempotencyKey.update({
              where: { userId_key: { userId, key } },
              data: { status: 'COMPLETED', responseCode: status, responseBody: body as object },
            });
      void done.catch(() => undefined).finally(() => json(body));
      return res;
    };
    next();
  };
}
