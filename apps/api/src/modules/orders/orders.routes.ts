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
import { CUSTOMER_REASONS, type OrderCancellationService } from './cancellation.service';
import type { OrderCreationService } from './order-creation.service';

export interface OrdersRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  orderCreation: OrderCreationService;
  orderCancellation: OrderCancellationService;
  limiter: RateLimiter;
}

const confirmBody = z
  .object({ expectedPayable: z.number().int().min(0).max(100_000_000) })
  .strict();
const orderParams = z.object({ orderId: schema.idSchema }).strict();
const cancelBody = z
  .object({
    quoteId: z.uuid(),
    reasonCode: z.enum(CUSTOMER_REASONS),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

/** Customer order endpoints. Mounted at /api/v1 before other routers, so middleware is path-scoped. */
export function ordersRouter(deps: OrdersRouterDeps): Router {
  const router = Router();
  const paths = [
    '/checkout/sessions/:sessionId/confirm',
    '/orders/:orderId/cancellation-preview',
    '/orders/:orderId/cancel',
    '/payments/:paymentId/cancel',
  ];
  router.use(paths, requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  router.use(
    paths,
    rateLimit(deps.limiter, {
      name: 'rl:write:user',
      limit: 60,
      windowSeconds: 60,
      key: (_req, res) => res.locals.auth!.userId,
    }),
  );
  const userId = (res: Response) => res.locals.auth!.userId;

  /** API-CHK-004 (FR-CHK-002, FR-ORDER-001/002). */
  router.post(
    '/checkout/sessions/:sessionId/confirm',
    idempotent(deps.prisma),
    handle(
      { params: schema.checkoutSessionParams, body: confirmBody },
      async ({ params, body, res }) => {
        const result = await deps.orderCreation.confirm(
          userId(res),
          params.sessionId,
          body.expectedPayable,
        );
        sendOk(res, result, {
          status: 201,
          message:
            result.order.status === 'PLACED' ? 'Order placed' : 'Order created — complete payment',
        });
      },
    ),
  );

  /** API-ORD-006 (FR-ORDER-020). */
  router.get(
    '/orders/:orderId/cancellation-preview',
    handle({ params: orderParams }, async ({ params, res }) =>
      sendOk(res, await deps.orderCancellation.preview(userId(res), params.orderId)),
    ),
  );

  /** API-ORD-007 (FR-CORD-007, BR-ORDER-010…013). */
  router.post(
    '/orders/:orderId/cancel',
    idempotent(deps.prisma),
    handle({ params: orderParams, body: cancelBody }, async ({ params, body, res }) =>
      sendOk(
        res,
        await deps.orderCancellation.cancelByCustomer(userId(res), params.orderId, body),
        { message: 'Order cancelled' },
      ),
    ),
  );

  /** API-PAY-005 (FR-PAY-016): abandon an unpaid order (T05). */
  router.post(
    '/payments/:paymentId/cancel',
    idempotent(deps.prisma),
    handle({ params: z.object({ paymentId: schema.idSchema }).strict() }, async ({ params, res }) =>
      sendOk(res, await deps.orderCancellation.abandonPayment(userId(res), params.paymentId), {
        message: 'Order cancelled',
      }),
    ),
  );
  return router;
}
