import type { Response } from 'express';
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
import { PARTNER_TAGS, RESTAURANT_TAGS, type ReviewService } from './review.service';

export interface ReviewRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  reviews: ReviewService;
  merchantAccess: MerchantAccess;
  limiter: RateLimiter;
}

const rating = z.number().int().min(1).max(5);
const text = z.string().trim().max(1000);
const reviewId = z.object({ reviewId: schema.idSchema }).strict();
const reportBody = z
  .object({
    reason: z.enum(['SPAM', 'ABUSIVE', 'IRRELEVANT', 'FAKE', 'OTHER']),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
const responseBody = z.object({ text: z.string().trim().min(2).max(1000) }).strict();

/** Customer reviews (API-REV-001…005) and the restaurant side (API-RREV-001…004). */
export function reviewRouter(deps: ReviewRouterDeps): Router {
  const router = Router();
  const me = (res: Response) => res.locals.auth!.userId;
  const writes = [
    rateLimit(deps.limiter, {
      name: 'rl:review:user',
      limit: 30,
      windowSeconds: 3600,
      key: (_req, res) => res.locals.auth!.userId,
    }),
    idempotent(deps.prisma),
  ];
  const customer = [requireClientApp(), authenticate(deps), requireApp('CUSTOMER')];
  const merchant = [requireClientApp(), authenticate(deps), requireApp('RESTAURANT')];

  router.post(
    '/orders/:orderId/reviews',
    ...customer,
    ...writes,
    handle(
      {
        params: z.object({ orderId: schema.idSchema }).strict(),
        body: z
          .object({
            restaurant: z
              .object({
                rating,
                text: text.optional(),
                tags: z.array(z.enum(RESTAURANT_TAGS)).max(4).optional(),
                photoFileIds: z.array(schema.idSchema).max(3).optional(),
              })
              .strict()
              .optional(),
            partner: z
              .object({
                rating,
                text: text.optional(),
                tags: z.array(z.enum(PARTNER_TAGS)).max(5).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .refine((b) => b.restaurant || b.partner, {
            message: 'Rate the restaurant or the delivery',
          }),
      },
      async ({ params, body, res }) =>
        sendOk(res, await deps.reviews.submit(me(res), params.orderId, body), {
          status: 201,
          message: 'Thanks for your feedback',
        }),
    ),
  );
  router.patch(
    '/reviews/:reviewId',
    ...customer,
    ...writes,
    handle(
      {
        params: reviewId,
        body: z
          .object({
            rating: rating.optional(),
            text: text.nullable().optional(),
            tags: z.array(z.string().max(40)).max(5).optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await deps.reviews.edit(me(res), params.reviewId, body)),
    ),
  );
  router.delete(
    '/reviews/:reviewId',
    ...customer,
    ...writes,
    handle({ params: reviewId }, async ({ params, res }) => {
      await deps.reviews.remove(me(res), params.reviewId);
      sendOk(res, null, { message: 'Review deleted' });
    }),
  );
  router.get(
    '/me/reviews',
    ...customer,
    handle({ query: schema.cursorPaginationSchema }, async ({ query, res }) => {
      const page = await deps.reviews.mine(me(res), {
        limit: Math.min(query.limit, 50),
        cursor: query.cursor,
      });
      sendOk(res, page.items, { meta: { pagination: { nextCursor: page.nextCursor } } });
    }),
  );
  // Any signed-in user, from any app (FR-REV-005).
  router.post(
    '/reviews/:reviewId/reports',
    requireClientApp(),
    authenticate(deps),
    ...writes,
    handle({ params: reviewId, body: reportBody }, async ({ params, body, res }) =>
      sendOk(res, await deps.reviews.report(me(res), params.reviewId, body), {
        status: 201,
        message: 'Thanks, we will take a look',
      }),
    ),
  );

  /* ---------- restaurant ---------- */
  router.get(
    '/merchant/branches/:bid/reviews',
    ...merchant,
    handle(
      {
        params: z.object({ bid: schema.idSchema }).strict(),
        query: schema.cursorPaginationSchema.extend({
          rating: z.coerce.number().int().min(1).max(5).optional(),
          responded: z
            .enum(['true', 'false'])
            .transform((v) => v === 'true')
            .optional(),
        }),
      },
      async ({ params, query, res }) => {
        await deps.merchantAccess.branch(res, params.bid, 'rest.review:read');
        const page = await deps.reviews.forBranch(params.bid, {
          limit: Math.min(query.limit, 50),
          cursor: query.cursor,
          rating: query.rating,
          responded: query.responded,
        });
        sendOk(res, page.items, { meta: { pagination: { nextCursor: page.nextCursor } } });
      },
    ),
  );
  const canRespond = async (res: Response, id: string) =>
    deps.merchantAccess.branch(res, await deps.reviews.branchOf(id), 'rest.review:respond');
  router.post(
    '/merchant/reviews/:reviewId/response',
    ...merchant,
    ...writes,
    handle({ params: reviewId, body: responseBody }, async ({ params, body, res }) => {
      await canRespond(res, params.reviewId);
      sendOk(res, await deps.reviews.respond(me(res), params.reviewId, body.text), {
        status: 201,
        message: 'Response posted',
      });
    }),
  );
  router.patch(
    '/merchant/reviews/:reviewId/response',
    ...merchant,
    ...writes,
    handle({ params: reviewId, body: responseBody }, async ({ params, body, res }) => {
      await canRespond(res, params.reviewId);
      sendOk(res, await deps.reviews.editResponse(params.reviewId, body.text));
    }),
  );
  router.post(
    '/merchant/reviews/:reviewId/reports',
    ...merchant,
    ...writes,
    handle({ params: reviewId, body: reportBody }, async ({ params, body, res }) => {
      await canRespond(res, params.reviewId);
      sendOk(res, await deps.reviews.report(me(res), params.reviewId, body), {
        status: 201,
        message: 'Reported for moderation',
      });
    }),
  );
  return router;
}
