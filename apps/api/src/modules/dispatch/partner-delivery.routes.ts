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
import type { MerchantAccess } from '../merchant';
import type { DispatchService } from './dispatch.service';
import type { DeliveryStagesService } from './stages.service';

export interface PartnerDeliveryRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  dispatch: DispatchService;
  deliveryStages: DeliveryStagesService;
  merchantAccess: MerchantAccess;
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

  /* the trip (API-DPDEL-004…011, 013) */
  const stages = deps.deliveryStages;
  const did = z.object({ deliveryId: schema.idSchema }).strict();
  const at = z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .strict();
  const arrival = z.object({ at: at.optional(), confirm: z.boolean().optional() }).strict();
  router.get(
    '/partner/deliveries/active',
    ...partner,
    handle({}, async ({ res }) => sendOk(res, await stages.view(me(res)))),
  );
  router.get(
    '/partner/deliveries',
    ...partner,
    handle(
      {
        query: z
          .object({
            from: z.coerce.date().optional(),
            to: z.coerce.date().optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          })
          .strict(),
      },
      async ({ query, res }) => sendOk(res, await stages.history(me(res), query)),
    ),
  );
  router.get(
    '/partner/deliveries/:deliveryId',
    ...partner,
    handle({ params: did }, async ({ params, res }) =>
      sendOk(res, await stages.view(me(res), params.deliveryId)),
    ),
  );
  router.post(
    '/partner/deliveries/:deliveryId/arrived-at-restaurant',
    ...partner,
    ...actions,
    handle({ params: did, body: arrival }, async ({ params, body, res }) =>
      sendOk(res, await stages.arrivedAtRestaurant(me(res), params.deliveryId, body)),
    ),
  );
  router.post(
    '/partner/deliveries/:deliveryId/picked-up',
    ...partner,
    ...actions,
    handle(
      { params: did, body: z.object({ at: at.optional() }).strict() },
      async ({ params, body, res }) =>
        sendOk(res, await stages.pickedUp(me(res), params.deliveryId, body), {
          message: 'Picked up',
        }),
    ),
  );
  router.post(
    '/partner/deliveries/:deliveryId/arrived-at-customer',
    ...partner,
    ...actions,
    handle({ params: did, body: arrival }, async ({ params, body, res }) =>
      sendOk(res, await stages.arrivedAtCustomer(me(res), params.deliveryId, body)),
    ),
  );
  router.post(
    '/partner/deliveries/:deliveryId/complete',
    ...partner,
    ...actions,
    handle(
      {
        params: did,
        body: z
          .object({
            method: z.enum(['OTP', 'PHOTO']),
            otp: z
              .string()
              .regex(/^\d{4}$/)
              .optional(),
            photoFileId: schema.idSchema.optional(),
            cashCollected: z.boolean().optional(),
            at: at.optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await stages.complete(me(res), params.deliveryId, body), {
          message: 'Delivered',
        }),
    ),
  );
  router.post(
    '/partner/deliveries/:deliveryId/customer-unreachable',
    ...partner,
    ...actions,
    handle(
      {
        params: did,
        body: z
          .object({
            callAttempts: z.number().int().min(0).max(20),
            note: z.string().trim().max(300).optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await stages.customerUnreachable(me(res), params.deliveryId, body)),
    ),
  );
  router.post(
    '/partner/deliveries/:deliveryId/unassign',
    ...partner,
    ...actions,
    handle(
      {
        params: did,
        body: z
          .object({
            reason: z.enum(['ACCIDENT', 'VEHICLE_BREAKDOWN', 'EMERGENCY', 'OTHER']),
            note: z.string().trim().max(300).optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(
          res,
          await stages.unassign(
            me(res),
            params.deliveryId,
            body.note ? `${body.reason}: ${body.note}` : body.reason,
          ),
        ),
    ),
  );

  /** API-RORD-009 (FR-RORD-007): the restaurant confirms handover with the partner's pickup code. */
  router.post(
    '/merchant/orders/:orderId/handover',
    requireClientApp(),
    authenticate(deps),
    requireApp('RESTAURANT'),
    ...actions,
    handle(
      {
        params: z.object({ orderId: schema.idSchema }).strict(),
        body: z.object({ pickupCode: z.string().regex(/^\d{4}$/) }).strict(),
      },
      async ({ params, body, res }) => {
        await deps.merchantAccess.order(res, params.orderId, 'rest.order:handover');
        sendOk(res, await stages.handover(me(res), params.orderId, body.pickupCode), {
          message: 'Handed over',
        });
      },
    ),
  );
  return router;
}
