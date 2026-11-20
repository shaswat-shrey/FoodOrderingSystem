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
import type { PartnerFinanceService } from './finance.service';

export interface PartnerFinanceRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  partnerFinance: PartnerFinanceService;
  limiter: RateLimiter;
}

const page = (query: { limit: number; cursor?: string | undefined }) => ({
  limit: Math.min(query.limit, 50),
  cursor: query.cursor,
});

/** Partner earnings, cash, payouts, performance and bank details (API-EARN-001…003, 005…012). */
export function partnerFinanceRouter(deps: PartnerFinanceRouterDeps): Router {
  const router = Router();
  const fin = deps.partnerFinance;
  const partner = [requireClientApp(), authenticate(deps), requireApp('DELIVERY')];
  const me = (res: Response) => res.locals.auth!.userId;
  const listed = (res: Response, p: { items: unknown[]; nextCursor: string | null }) =>
    sendOk(res, p.items, { meta: { pagination: { nextCursor: p.nextCursor } } });

  router.get(
    '/partner/me/earnings/summary',
    ...partner,
    handle(
      {
        query: z
          .object({
            period: z.enum(['day', 'week', 'month']).default('day'),
            date: z.coerce.date().optional(),
          })
          .strict(),
      },
      async ({ query, res }) => sendOk(res, await fin.summary(me(res), query.period, query.date)),
    ),
  );
  router.get(
    '/partner/me/earnings',
    ...partner,
    handle(
      {
        query: schema.cursorPaginationSchema.extend({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      },
      async ({ query, res }) =>
        listed(res, await fin.entries(me(res), { ...page(query), from: query.from, to: query.to })),
    ),
  );
  router.get(
    '/partner/me/earnings/deliveries/:deliveryId',
    ...partner,
    handle(
      { params: z.object({ deliveryId: schema.idSchema }).strict() },
      async ({ params, res }) => sendOk(res, await fin.delivery(me(res), params.deliveryId)),
    ),
  );
  router.get(
    '/partner/me/cash',
    ...partner,
    handle({}, async ({ res }) => sendOk(res, await fin.cash(me(res)))),
  );
  router.get(
    '/partner/me/cash/transactions',
    ...partner,
    handle({ query: schema.cursorPaginationSchema }, async ({ query, res }) =>
      listed(res, await fin.cashTransactions(me(res), page(query))),
    ),
  );
  router.get(
    '/partner/me/payouts',
    ...partner,
    handle({ query: schema.cursorPaginationSchema }, async ({ query, res }) => {
      const p = await fin.payouts(me(res), page(query));
      sendOk(
        res,
        { next: p.next, items: p.items },
        { meta: { pagination: { nextCursor: p.nextCursor } } },
      );
    }),
  );
  router.get(
    '/partner/me/payouts/:payoutId',
    ...partner,
    handle({ params: z.object({ payoutId: schema.idSchema }).strict() }, async ({ params, res }) =>
      sendOk(res, await fin.payout(me(res), params.payoutId)),
    ),
  );
  router.get(
    '/partner/me/performance',
    ...partner,
    handle({}, async ({ res }) => sendOk(res, await fin.performance(me(res)))),
  );
  router.get(
    '/partner/me/ratings',
    ...partner,
    handle({ query: schema.cursorPaginationSchema }, async ({ query, res }) => {
      const r = await fin.ratings(me(res), page(query));
      const { items, nextCursor, ...summary } = r;
      sendOk(res, { ...summary, items }, { meta: { pagination: { nextCursor } } });
    }),
  );
  router.get(
    '/partner/me/bank-account',
    ...partner,
    handle({}, async ({ res }) => sendOk(res, await fin.bankAccount(me(res)))),
  );
  router.post(
    '/partner/me/bank-account/change-requests',
    ...partner,
    rateLimit(deps.limiter, {
      name: 'rl:partner-bank:user',
      limit: 5,
      windowSeconds: 86_400,
      key: (_req, res) => res.locals.auth!.userId,
    }),
    idempotent(deps.prisma),
    handle(
      {
        body: z
          .object({
            holderName: z.string().trim().min(2).max(120),
            accountNumber: schema.bankAccountNumberSchema,
            ifsc: schema.ifscSchema,
          })
          .strict(),
      },
      async ({ body, res }) => {
        const { sessionId } = res.locals.auth!;
        await deps.sessions.requireRecentReauth(sessionId); // BR-AUTH-017
        sendOk(res, await fin.requestBankChange(me(res), body, sessionId), {
          status: 201,
          message: 'Sent for verification. Payouts are on hold until it is verified.',
        });
      },
    ),
  );
  return router;
}
