import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { PrismaClient } from '@fos/db';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { idempotent } from '../../platform/http/middleware/idempotency';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { DispatchService } from './dispatch.service';

export interface PartnerDeliveryRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  dispatch: DispatchService;
  limiter: RateLimiter;
}

/** Offers for partners (API-DPDEL-001…003). Delivery stage routes are added by the stages module. */
export function partnerOfferRouter(deps: PartnerDeliveryRouterDeps): Router {
  const router = Router();
  const partner: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps),
    requireApp('DELIVERY'),
  ];
  const actions = [
    rateLimit(deps.limiter, {
      name: 'rl:offer:user',
      limit: 120,
      windowSeconds: 60,
      key: (_req, res) => res.locals.auth!.userId,
    }),
    idempotent(deps.prisma),
  ];
  const me = (res: Response) => res.locals.auth!.userId;
  const offer = z.object({ offerId: schema.idSchema }).strict();

  router.get(
    '/partner/offers/current',
    ...partner,
    handle({}, async ({ res }) => sendOk(res, await deps.dispatch.currentOffer(me(res)))),
  );
  router.post(
    '/partner/offers/:offerId/accept',
    ...partner,
    ...actions,
    handle({ params: offer }, async ({ params, res }) => {
      const d = await deps.dispatch.accept(me(res), params.offerId);
      sendOk(res, { deliveryId: d.id, status: d.status }, { message: 'Delivery assigned to you' });
    }),
  );
  router.post(
    '/partner/offers/:offerId/reject',
    ...partner,
    ...actions,
    handle(
      {
        params: offer,
        body: z
          .object({ reason: z.enum(['TOO_FAR', 'VEHICLE_ISSUE', 'OTHER']).optional() })
          .strict(),
      },
      async ({ params, body, res }) => {
        await deps.dispatch.reject(me(res), params.offerId, body.reason);
        sendOk(res, null, { message: 'Offer declined' });
      },
    ),
  );
  return router;
}
