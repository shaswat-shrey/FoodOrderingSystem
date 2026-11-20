import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { PlatformPermission } from '@fos/shared';
import * as schema from '@fos/validation';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, authorize, requireApp, type AuthMiddlewareDeps } from '../auth';

export interface AdminHttpDeps extends AuthMiddlewareDeps {
  limiter: RateLimiter;
}

/** Who is acting, for audit records (BR-ADMIN-002). */
export interface AdminActor {
  userId: string;
  sessionId: string;
  roles: string[];
}

/**
 * Shared admin-console plumbing (API-ADM-*). Admin routers are mounted without a
 * path prefix, so every route carries its own chain — never router.use() — or
 * the guards would run for unrelated routers' requests too.
 */
export function adminGuards(deps: AdminHttpDeps) {
  const base: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps),
    requireApp('ADMIN'),
    rateLimit(deps.limiter, {
      name: 'rl:admin:user',
      limit: 600,
      windowSeconds: 60,
      key: (_req, res) => res.locals.auth!.userId,
    }),
  ];
  /** The admin chain plus one platform permission check (ADR-002). */
  return (permission: PlatformPermission): RequestHandler[] => [
    ...base,
    authorize(deps.iam, permission),
  ];
}

export const actorOf = (res: Response): AdminActor => {
  const auth = res.locals.auth!;
  return { userId: auth.userId, sessionId: auth.sessionId, roles: [...auth.roles] };
};

/** ★ actions: a mandatory reason, kept in the high-sensitivity audit stream. */
export const reasonSchema = z.string().trim().min(5).max(500);

/** `{ reason }` alone, for ★ actions without other input. */
export const reasonBody = z.object({ reason: reasonSchema }).strict();

export const idParams = z.object({ id: schema.idSchema }).strict();

/** Page-numbered admin tables (`?page&pageSize`), extended with each list's filters. */
export const pageQuery = schema.offsetPaginationSchema;

export interface Page {
  page: number;
  pageSize: number;
}

export const pageArgs = (p: Page) => ({ skip: (p.page - 1) * p.pageSize, take: p.pageSize });

export const pageMeta = (p: Page, total: number) => ({
  pagination: { page: p.page, pageSize: p.pageSize, total, hasMore: p.page * p.pageSize < total },
});

/** `+919876541234` → `+91XXXXXX1234` (FR-ADMIN-010: PII masked by default). */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.startsWith('+91') ? phone.slice(3) : phone;
  return `${phone.startsWith('+91') ? '+91' : ''}${'X'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** `asha.rao@example.com` → `a***@example.com`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
