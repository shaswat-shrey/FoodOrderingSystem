import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors';
import type { RateLimiter } from '../../rate-limit';

export interface RateLimitRule {
  /** Logical bucket name, e.g. "auth:login:ip". */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Key within the bucket; return null to skip this rule for the request. */
  key: (req: Request, res: Response) => string | null;
}

/** Applies one or more rate-limit rules (SRS §14.1 tiers); 429 with Retry-After when exceeded. */
export function rateLimit(limiter: RateLimiter, ...rules: RateLimitRule[]): RequestHandler {
  return async (req, res, next) => {
    for (const rule of rules) {
      const key = rule.key(req, res);
      if (key === null) continue;
      const result = await limiter.hit(`${rule.name}:${key}`, rule.limit, rule.windowSeconds);
      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        next(
          new AppError('RATE_LIMITED', {
            message: `Too many attempts. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
            details: [{ code: 'RETRY_AFTER', message: String(result.retryAfterSeconds) }],
          }),
        );
        return;
      }
    }
    next();
  };
}

/** Client IP as seen through the trusted proxy (app sets `trust proxy`). */
export const byIp = (req: Request) => req.ip ?? 'unknown';
