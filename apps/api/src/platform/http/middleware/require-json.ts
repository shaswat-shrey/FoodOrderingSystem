import type { RequestHandler } from 'express';
import { AppError } from '../errors';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Rejects bodies that are not JSON on JSON routes (415). Routes that legitimately
 * take other bodies (uploads, provider webhooks) are mounted before this middleware.
 */
export function requireJsonBody(): RequestHandler {
  return (req, _res, next) => {
    const hasBody = Number(req.header('content-length') ?? 0) > 0 || req.header('transfer-encoding');
    if (BODY_METHODS.has(req.method) && hasBody && !req.is('application/json')) {
      next(new AppError('UNSUPPORTED_MEDIA_TYPE', { message: 'Request body must be JSON.' }));
      return;
    }
    next();
  };
}
