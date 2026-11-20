import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { ClientApp } from '@fos/db';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, type AuthMiddlewareDeps } from '../auth';
import { TICKET_CATEGORIES, type SupportService } from './support.service';

export interface SupportRouterDeps extends AuthMiddlewareDeps {
  support: SupportService;
  limiter: RateLimiter;
}

const ticketParams = z.object({ ticketId: schema.idSchema }).strict();
const fileIds = z.array(schema.idSchema).max(3).optional();
const createBody = z
  .object({
    category: z.enum(TICKET_CATEGORIES),
    subject: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().min(10).max(5000),
    orderId: schema.idSchema.optional(),
    attachmentFileIds: fileIds,
  })
  .strict();
const replyBody = z
  .object({ body: z.string().trim().min(1).max(5000), attachmentFileIds: fileIds })
  .strict();
const listQuery = schema.cursorPaginationSchema
  .extend({
    status: z
      .enum(['OPEN', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'RESOLVED', 'CLOSED'])
      .optional(),
  })
  .strict();
const LEGAL = {
  terms: 'TERMS',
  privacy: 'PRIVACY',
  'refund-policy': 'REFUND_POLICY',
  'partner-terms': 'PARTNER_TERMS',
  'restaurant-terms': 'RESTAURANT_TERMS',
  'grievance-officer': 'GRIEVANCE_OFFICER',
} as const;

/** Help centre, legal pages and tickets (API-SUP-001…009). Every route carries its own middleware. */
export function supportRouter(deps: SupportRouterDeps): Router {
  const router = Router();
  const authed: RequestHandler[] = [requireClientApp(), authenticate(deps)];
  const writes = rateLimit(deps.limiter, {
    name: 'rl:write:user',
    limit: 60,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth!.userId,
  });
  const userId = (res: Response) => res.locals.auth!.userId;

  router.get(
    '/help/faqs',
    handle(
      {
        query: z
          .object({
            app: z.enum(['CUSTOMER', 'RESTAURANT', 'DELIVERY', 'ADMIN']).default('CUSTOMER'),
            topic: z.string().trim().max(60).optional(),
          })
          .strict(),
      },
      async ({ query, res }) =>
        sendOk(res, await deps.support.faqs(query.app as ClientApp, query.topic)),
    ),
  );
  router.get(
    '/legal/:documentType',
    handle(
      {
        params: z
          .object({ documentType: z.enum(Object.keys(LEGAL) as [keyof typeof LEGAL]) })
          .strict(),
      },
      async ({ params, res }) => {
        res.setHeader('Cache-Control', 'public, max-age=300');
        sendOk(res, await deps.support.legal(LEGAL[params.documentType]));
      },
    ),
  );

  router.post(
    '/support/tickets',
    ...authed,
    writes,
    handle({ body: createBody }, async ({ body, res }) =>
      sendOk(
        res,
        await deps.support.create(
          { userId: userId(res), app: res.locals.auth!.app as ClientApp },
          body,
        ),
        { status: 201, message: 'We have received your request' },
      ),
    ),
  );
  router.get(
    '/support/tickets',
    ...authed,
    handle({ query: listQuery }, async ({ query, res }) => {
      const page = await deps.support.list(userId(res), {
        status: query.status,
        limit: Math.min(query.limit, 50),
        cursor: query.cursor,
      });
      sendOk(res, page.items, { meta: { pagination: { nextCursor: page.nextCursor } } });
    }),
  );
  router.get(
    '/support/tickets/:ticketId',
    ...authed,
    handle({ params: ticketParams }, async ({ params, res }) =>
      sendOk(res, await deps.support.get(userId(res), params.ticketId)),
    ),
  );
  router.post(
    '/support/tickets/:ticketId/messages',
    ...authed,
    writes,
    handle({ params: ticketParams, body: replyBody }, async ({ params, body, res }) =>
      sendOk(res, await deps.support.reply(userId(res), params.ticketId, body), { status: 201 }),
    ),
  );
  router.post(
    '/support/tickets/:ticketId/close',
    ...authed,
    writes,
    handle({ params: ticketParams }, async ({ params, res }) =>
      sendOk(res, await deps.support.close(userId(res), params.ticketId)),
    ),
  );
  router.post(
    '/support/tickets/:ticketId/reopen',
    ...authed,
    writes,
    handle(
      {
        params: ticketParams,
        body: z.object({ reason: z.string().trim().min(3).max(1000) }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await deps.support.reopen(userId(res), params.ticketId, body.reason)),
    ),
  );
  router.post(
    '/support/tickets/:ticketId/csat',
    ...authed,
    writes,
    handle(
      { params: ticketParams, body: z.object({ score: z.number().int().min(1).max(5) }).strict() },
      async ({ params, body, res }) =>
        sendOk(res, await deps.support.rate(userId(res), params.ticketId, body.score)),
    ),
  );
  return router;
}
