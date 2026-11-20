import type { CookieOptions, Request, Response } from 'express';
import type { ClientApp } from '@fos/shared';

/** Refresh cookie per app so each app has its own session (ADR-003, SYSTEM-ARCHITECTURE §6.4). */
export function refreshCookieName(app: ClientApp): string {
  return `fos_rt_${app.toLowerCase()}`;
}

export const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: REFRESH_COOKIE_PATH };
}

export function setRefreshCookie(
  res: Response,
  app: ClientApp,
  token: string,
  expiresAt: Date,
  secure: boolean,
  now: Date,
): void {
  res.cookie(refreshCookieName(app), token, {
    ...baseOptions(secure),
    maxAge: Math.max(0, expiresAt.getTime() - now.getTime()),
  });
}

export function clearRefreshCookie(res: Response, app: ClientApp, secure: boolean): void {
  res.clearCookie(refreshCookieName(app), baseOptions(secure));
}

export function readRefreshCookie(req: Request, app: ClientApp): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[refreshCookieName(app)];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
