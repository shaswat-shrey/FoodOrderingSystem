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
import { CUSTOMER_REASONS, type OrderCancellationService } from './cancellation.service';
import type { InvoiceService } from './invoice.service';
import type { OrderCreationService } from './order-creation.service';
import { STATUS_GROUPS, type OrderQueryService } from './order-query.service';
import type { ReorderService } from './reorder.service';

export interface OrdersRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  orderCreation: OrderCreationService;
  orderCancellation: OrderCancellationService;
  orderQueries: OrderQueryService;
  reorders: ReorderService;
  invoices: InvoiceService;
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
const historyQuery = schema.cursorPaginationSchema
  .extend({
    status: z.enum(Object.keys(STATUS_GROUPS) as [keyof typeof STATUS_GROUPS]).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();
const deliveryDetailsBody = z
  .object({
    deliveryInstructions: z.string().trim().max(200).nullable().optional(),
    contactPhone: schema.indianMobileSchema.optional(),
  })
  .strict()
  .refine((b) => b.deliveryInstructions !== undefined || b.contactPhone !== undefined, {
    message: 'Nothing to change.',
  });
const reorderBody = z.object({ replaceCart: z.boolean().default(false) }).strict();

/**
 * Customer order endpoints. Mounted at /api/v1 without a prefix, so every route
 * carries its own middleware (routes.ts) instead of a path-wide router.use.
 */
export function ordersRouter(deps: OrdersRouterDeps): Router {
  const router = Router();
  const customer: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps),
    requireApp('CUSTOMER'),
  ];
  const writes = rateLimit(deps.limiter, {
    name: 'rl:write:user',
    limit: 60,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth!.userId,
  });
  const userId = (res: Response) => res.locals.auth!.userId;

  /** API-CHK-004 (FR-CHK-002, FR-ORDER-001/002). */
  router.post(
    '/checkout/sessions/:sessionId/confirm',
    ...customer,
    writes,
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

  /** API-ORD-001 (FR-CORD-002). */
  router.get(
    '/me/orders',
    ...customer,
    handle({ query: historyQuery }, async ({ query, res }) => {
      const page = await deps.orderQueries.history(userId(res), {
        status: query.status,
        from: query.from,
        to: query.to,
        limit: Math.min(query.limit, 50),
        cursor: query.cursor,
      });
      sendOk(res, page.items, { meta: { pagination: { nextCursor: page.nextCursor } } });
    }),
  );

  /** API-ORD-002 (FR-CORD-001). */
  router.get(
    '/me/orders/active',
    ...customer,
    handle({}, async ({ res }) => sendOk(res, await deps.orderQueries.active(userId(res)))),
  );

  /** API-ORD-003 (FR-CORD-003). */
  router.get(
    '/orders/:orderId',
    ...customer,
    handle({ params: orderParams }, async ({ params, res }) =>
      sendOk(res, await deps.orderQueries.details(userId(res), params.orderId)),
    ),
  );

  /** API-ORD-004 */
  router.get(
    '/orders/:orderId/status',
    ...customer,
    handle({ params: orderParams }, async ({ params, res }) =>
      sendOk(res, await deps.orderQueries.status(userId(res), params.orderId)),
    ),
  );

  /** API-ORD-005 */
  router.get(
    '/orders/:orderId/timeline',
    ...customer,
    handle({ params: orderParams }, async ({ params, res }) =>
      sendOk(res, await deps.orderQueries.timeline(userId(res), params.orderId)),
    ),
  );

  /** API-ORD-006 (FR-ORDER-020). */
  router.get(
    '/orders/:orderId/cancellation-preview',
    ...customer,
    handle({ params: orderParams }, async ({ params, res }) =>
      sendOk(res, await deps.orderCancellation.preview(userId(res), params.orderId)),
    ),
  );

  /** API-ORD-007 (FR-CORD-007, BR-ORDER-010…013). */
  router.post(
    '/orders/:orderId/cancel',
    ...customer,
    writes,
    idempotent(deps.prisma),
    handle({ params: orderParams, body: cancelBody }, async ({ params, body, res }) =>
      sendOk(
        res,
        await deps.orderCancellation.cancelByCustomer(userId(res), params.orderId, body),
        { message: 'Order cancelled' },
      ),
    ),
  );

  /** API-ORD-008 (FR-CORD-008). */
  router.post(
    '/orders/:orderId/reorder',
    ...customer,
    writes,
    handle({ params: orderParams, body: reorderBody }, async ({ params, body, res }) =>
      sendOk(res, await deps.reorders.reorder(userId(res), params.orderId, body)),
    ),
  );

  /** API-ORD-009 (FR-CORD-009): PDF download. */
  router.get(
    '/orders/:orderId/invoice',
    ...customer,
    handle({ params: orderParams }, async ({ params, res }) => {
      const pdf = await deps.invoices.pdf(userId(res), params.orderId);
      res
        .status(200)
        .type('application/pdf')
        .setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`)
        .setHeader('Cache-Control', 'private, no-store')
        .send(pdf.body);
    }),
  );

  /** API-ORD-010 (FR-ORDER-031). */
  router.patch(
    '/orders/:orderId/delivery-details',
    ...customer,
    writes,
    handle({ params: orderParams, body: deliveryDetailsBody }, async ({ params, body, res }) =>
      sendOk(res, await deps.orderQueries.updateDeliveryDetails(userId(res), params.orderId, body)),
    ),
  );

  /** API-PAY-005 (FR-PAY-016): abandon an unpaid order (T05). */
  router.post(
    '/payments/:paymentId/cancel',
    ...customer,
    writes,
    idempotent(deps.prisma),
    handle({ params: z.object({ paymentId: schema.idSchema }).strict() }, async ({ params, res }) =>
      sendOk(res, await deps.orderCancellation.abandonPayment(userId(res), params.paymentId), {
        message: 'Order cancelled',
      }),
    ),
  );
  return router;
}
