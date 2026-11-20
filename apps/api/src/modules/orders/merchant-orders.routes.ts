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
import {
  CANCEL_REASONS,
  QUEUE_TABS,
  REJECT_REASONS,
  type RestaurantOrdersService,
} from './restaurant-orders.service';

export interface MerchantOrdersRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  merchantAccess: MerchantAccess;
  restaurantOrders: RestaurantOrdersService;
  limiter: RateLimiter;
}

const bid = z.object({ bid: schema.idSchema }).strict();
const oid = z.object({ orderId: schema.idSchema }).strict();

/** Restaurant order handling (API-RORD-001…012). */
export function merchantOrdersRouter(deps: MerchantOrdersRouterDeps): Router {
  const router = Router();
  const member: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps),
    requireApp('RESTAURANT'),
  ];
  const actions = [
    rateLimit(deps.limiter, {
      name: 'rl:rorder:user',
      limit: 300,
      windowSeconds: 60,
      key: (_req, res) => res.locals.auth!.userId,
    }),
    idempotent(deps.prisma),
  ];
  const me = (res: Response) => res.locals.auth!.userId;
  const access = deps.merchantAccess;
  const svc = deps.restaurantOrders;

  router.get(
    '/merchant/branches/:bid/orders',
    ...member,
    handle(
      {
        params: bid,
        query: schema.cursorPaginationSchema
          .extend({
            status: z.enum(Object.keys(QUEUE_TABS) as [keyof typeof QUEUE_TABS]).optional(),
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            q: z.string().trim().min(2).max(16).optional(),
          })
          .strict(),
      },
      async ({ params, query, res }) => {
        await access.branch(res, params.bid, 'rest.order:read');
        const page = await svc.queue(params.bid, {
          tab: query.status,
          date: query.date,
          q: query.q,
          limit: Math.min(query.limit, 50),
          cursor: query.cursor,
        });
        sendOk(res, page.items, { meta: { pagination: { nextCursor: page.nextCursor } } });
      },
    ),
  );
  router.get(
    '/merchant/branches/:bid/orders/counts',
    ...member,
    handle({ params: bid }, async ({ params, res }) => {
      await access.branch(res, params.bid, 'rest.order:read');
      sendOk(res, await svc.counts(params.bid));
    }),
  );
  router.get(
    '/merchant/branches/:bid/kds',
    ...member,
    handle({ params: bid }, async ({ params, res }) => {
      await access.branch(res, params.bid, 'rest.kds:view');
      sendOk(res, await svc.kds(params.bid));
    }),
  );
  router.get(
    '/merchant/orders/:orderId',
    ...member,
    handle({ params: oid }, async ({ params, res }) => {
      await access.order(res, params.orderId, 'rest.order:read');
      sendOk(res, await svc.details(params.orderId));
    }),
  );
  router.get(
    '/merchant/orders/:orderId/kot',
    ...member,
    handle({ params: oid }, async ({ params, res }) => {
      await access.order(res, params.orderId, 'rest.order:read');
      sendOk(res, await svc.kot(params.orderId));
    }),
  );
  router.post(
    '/merchant/orders/:orderId/accept',
    ...member,
    ...actions,
    handle(
      {
        params: oid,
        body: z
          .object({
            prepMinutes: z.number().int().min(5).max(90).optional(),
            expectedVersion: z.number().int().min(0).optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await access.order(res, params.orderId, 'rest.order:accept');
        sendOk(res, await svc.accept(me(res), params.orderId, body), { message: 'Order accepted' });
      },
    ),
  );
  router.post(
    '/merchant/orders/:orderId/reject',
    ...member,
    ...actions,
    handle(
      {
        params: oid,
        body: z
          .object({
            reason: z.enum(REJECT_REASONS),
            note: z.string().trim().max(300).optional(),
            itemIds: z.array(schema.idSchema).max(50).optional(),
            markUnavailable: z.boolean().optional(),
          })
          .strict()
          .refine((b) => b.reason !== 'OTHER' || (b.note && b.note.length >= 3), {
            message: 'Add a note for “Other”.',
            path: ['note'],
          }),
      },
      async ({ params, body, res }) => {
        await access.order(res, params.orderId, 'rest.order:accept');
        sendOk(res, await svc.reject(me(res), params.orderId, body), { message: 'Order rejected' });
      },
    ),
  );
  router.post(
    '/merchant/orders/:orderId/preparing',
    ...member,
    ...actions,
    handle({ params: oid }, async ({ params, res }) => {
      await access.order(res, params.orderId, 'rest.order:prepare');
      sendOk(res, await svc.preparing(me(res), params.orderId));
    }),
  );
  router.post(
    '/merchant/orders/:orderId/ready',
    ...member,
    ...actions,
    handle({ params: oid }, async ({ params, res }) => {
      await access.order(res, params.orderId, 'rest.order:prepare');
      sendOk(res, await svc.ready(me(res), params.orderId), { message: 'Marked ready' });
    }),
  );
  router.post(
    '/merchant/orders/:orderId/prep-time',
    ...member,
    ...actions,
    handle(
      {
        params: oid,
        body: z
          .object({
            minutes: z.number().int().min(1).max(20),
            reason: z.string().trim().min(3).max(200),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await access.order(res, params.orderId, 'rest.order:prepare');
        sendOk(res, await svc.extendPrep(me(res), params.orderId, body));
      },
    ),
  );
  router.post(
    '/merchant/orders/:orderId/cancel',
    ...member,
    ...actions,
    handle(
      {
        params: oid,
        body: z
          .object({
            reason: z.enum(CANCEL_REASONS),
            note: z.string().trim().min(3).max(300),
            confirm: z.literal(true),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await access.order(res, params.orderId, 'rest.order:cancel');
        sendOk(res, await svc.cancel(me(res), params.orderId, body), {
          message: 'Order cancelled',
        });
      },
    ),
  );
  return router;
}
