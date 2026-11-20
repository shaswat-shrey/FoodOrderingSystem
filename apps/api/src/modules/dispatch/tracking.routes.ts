import { Router } from 'express';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { OrderTrackingService } from './tracking.service';

/** API-TRK-001/002. */
export function trackingRouter(
  deps: AuthMiddlewareDeps & { tracking: OrderTrackingService; limiter: RateLimiter },
): Router {
  const router = Router();
  const customer = [requireClientApp(), authenticate(deps), requireApp('CUSTOMER')];
  const params = z.object({ orderId: schema.idSchema }).strict();
  router.get(
    '/orders/:orderId/tracking',
    ...customer,
    handle({ params }, async ({ params, res }) =>
      sendOk(res, await deps.tracking.snapshot(res.locals.auth!.userId, params.orderId)),
    ),
  );
  router.get(
    '/orders/:orderId/tracking/location',
    ...customer,
    // Poll fallback at most once every 5 s per user (API-TRK-002), with a little slack.
    rateLimit(deps.limiter, {
      name: 'rl:track:user',
      limit: 15,
      windowSeconds: 60,
      key: (_req, res) => res.locals.auth!.userId,
    }),
    handle({ params }, async ({ params, res }) =>
      sendOk(res, await deps.tracking.latest(res.locals.auth!.userId, params.orderId)),
    ),
  );
  return router;
}
