import express, { Router, type Express, type Response } from 'express';
import type { PrismaClient } from '@fos/db';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { AppError } from '../../platform/http/errors';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { idempotent } from '../../platform/http/middleware/idempotency';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requestMeta, requireApp, type AuthMiddlewareDeps } from '../auth';
import { MockPaymentProvider, type MockScenario } from './mock-provider';
import type { PaymentProvider } from './provider';
import type { PaymentsService } from './payments.service';
import type { RefundService } from './refunds.service';

export interface PaymentsRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  payments: PaymentsService;
  refunds: RefundService;
  paymentProvider: PaymentProvider;
  limiter: RateLimiter;
  env: { NODE_ENV: string };
}

const paymentParams = z.object({ paymentId: schema.idSchema }).strict();
const verifyBody = z
  .object({ providerPaymentId: z.string().min(1).max(100), signature: z.string().min(1).max(200) })
  .strict();

/** API-PAY-007: provider webhooks, verified over the raw body before parsing (FR-PAY-004). */
export function mountPaymentWebhooks(app: Express, deps: PaymentsRouterDeps): void {
  app.post(
    '/api/v1/payments/webhooks/:provider',
    express.raw({ type: '*/*', limit: '256kb' }),
    async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]),
      );
      const result = await deps.payments.ingestWebhook(
        String(req.params.provider),
        raw,
        headers,
        req.ip ?? null,
      );
      sendOk(res, result);
    },
  );
}

/** API-PAY-002…004, 006 and API-REF-001/002 (customer). */
export function paymentsRouter(deps: PaymentsRouterDeps): Router {
  const router = Router();
  // Mounted at /api/v1 with other routers after it, so its middleware is scoped to its own paths.
  const paths = [
    '/orders/:orderId/payments',
    '/payments',
    '/me/payments',
    '/me/refunds',
    '/refunds',
  ];
  router.use(paths, requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  router.use(
    paths,
    rateLimit(deps.limiter, {
      name: 'rl:payments:user',
      limit: 30,
      windowSeconds: 60,
      key: (req, res) => (req.method === 'GET' ? null : res.locals.auth!.userId),
    }),
  );
  const userId = (res: Response) => res.locals.auth!.userId;
  const once = idempotent(deps.prisma); // FR-PAY-007

  router.post(
    '/orders/:orderId/payments',
    once,
    handle({ params: z.object({ orderId: schema.idSchema }).strict() }, async ({ params, res }) => {
      sendOk(res, await deps.payments.initiate(userId(res), params.orderId), { status: 201 });
    }),
  );
  router.get(
    '/payments/:paymentId',
    handle({ params: paymentParams }, async ({ params, res }) =>
      sendOk(res, await deps.payments.get(userId(res), params.paymentId)),
    ),
  );
  router.post(
    '/payments/:paymentId/verify',
    once,
    handle({ params: paymentParams, body: verifyBody }, async ({ params, body, req, res }) => {
      const m = requestMeta(req, res);
      sendOk(
        res,
        await deps.payments.verify(userId(res), params.paymentId, body, {
          ip: m.ip,
          ...(m.requestId ? { requestId: m.requestId } : {}),
        }),
      );
    }),
  );
  router.get(
    '/me/payments',
    handle({ query: schema.cursorPaginationSchema }, async ({ query, res }) => {
      const page = await deps.payments.history(userId(res), {
        limit: Math.min(query.limit, 50),
        cursor: query.cursor,
      });
      sendOk(res, page.items, { meta: { pagination: { nextCursor: page.nextCursor } } });
    }),
  );
  router.get(
    '/me/refunds',
    handle({}, async ({ res }) => sendOk(res, await deps.refunds.listForUser(userId(res)))),
  );
  router.get(
    '/refunds/:refundId',
    handle(
      { params: z.object({ refundId: schema.idSchema }).strict() },
      async ({ params, res }) => {
        sendOk(res, await deps.refunds.getForUser(userId(res), params.refundId));
      },
    ),
  );

  // Development only: stands in for the provider's hosted checkout so the apps can be exercised end to end.
  if (deps.paymentProvider instanceof MockPaymentProvider && deps.env.NODE_ENV !== 'production') {
    const mock = deps.paymentProvider;
    router.post(
      '/payments/:paymentId/mock-checkout',
      handle(
        {
          params: paymentParams,
          body: z
            .object({
              scenario: z
                .enum(['success', 'fail', 'authorize_only', 'amount_mismatch'])
                .default('success'),
            })
            .strict(),
        },
        async ({ params, body, res }) => {
          const payment = await deps.payments.get(userId(res), params.paymentId);
          const row = await deps.prisma.payment.findUniqueOrThrow({
            where: { id: payment.id },
            select: { providerOrderId: true },
          });
          if (!row.providerOrderId) throw new AppError('PAYMENT_ORDER_MISMATCH');
          const paid = mock.pay(row.providerOrderId, body.scenario as MockScenario);
          // The provider would also send a webhook.
          await deps.payments.ingestWebhook('mock', paid.webhook.body, paid.webhook.headers, null);
          sendOk(res, { providerPaymentId: paid.providerPaymentId, signature: paid.signature });
        },
      ),
    );
  }
  return router;
}
