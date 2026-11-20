import { Router, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@fos/db';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { idempotent } from '../../platform/http/middleware/idempotency';
import {
  actorOf,
  adminGuards,
  idParams,
  pageQuery,
  reasonBody,
  reasonSchema,
  type AdminHttpDeps,
} from './admin.http';
import type { AdminDashboardService } from './dashboard.service';
import {
  MAX_DEADLINE_EXTENSION_MINUTES,
  type AdminDispatchService,
} from './dispatch-admin.service';
import type { AdminFinanceService } from './finance.service';
import { MAX_ACCEPT_EXTENSION_MINUTES, type AdminOrdersService } from './orders.service';

export interface AdminOperationsRouterDeps extends AdminHttpDeps {
  prisma: PrismaClient;
  adminDashboard: AdminDashboardService;
  adminOrders: AdminOrdersService;
  adminDispatch: AdminDispatchService;
  adminFinance: AdminFinanceService;
}

const ORDER_STATUS = z.enum([
  'PAYMENT_PENDING',
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'FAILED',
]);
const DELIVERY_STATUS = z.enum([
  'PENDING',
  'SEARCHING',
  'ASSIGNED',
  'AT_RESTAURANT',
  'EN_ROUTE_TO_CUSTOMER',
  'AT_CUSTOMER',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
]);
const PAYMENT_STATUS = z.enum([
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'COLLECTED',
]);
const PROVIDER = z.enum(['RAZORPAY', 'STRIPE', 'MOCK', 'NONE']);
const REFUND_STATUS = z.enum([
  'REQUESTED',
  'APPROVED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
const PAYEE = z.enum(['RESTAURANT', 'PARTNER']);
const BATCH_STATUS = z.enum(['DRAFT', 'APPROVED', 'PROCESSING', 'PAID', 'PARTIALLY_FAILED']);
const code = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use an UPPER_SNAKE_CASE code');
const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();
const when = z.coerce.date().optional();
const lineParams = z.object({ id: schema.idSchema, lineId: schema.idSchema }).strict();

/**
 * Admin operations: dashboard and alerts, orders, the dispatch board,
 * payments, refunds and payout batches (API-ADM-001…003, 060…065, 067,
 * 070…075, 080…087, 091…097). ★ actions need a reason and are audited as
 * high-sensitivity (BR-ADMIN-002); maker-checker (⧉) beyond payout approval is CORE.
 */
export function adminOperationsRouter(deps: AdminOperationsRouterDeps): Router {
  const router = Router();
  const can = adminGuards(deps);
  const once = idempotent(deps.prisma);
  const { adminDashboard: dashboard, adminOrders: orders, adminDispatch: dispatch } = deps;
  const finance = deps.adminFinance;
  /** FR-REFUND-008: does this admin bypass the support refund limit? */
  const approver = async (res: Response) => {
    const auth = res.locals.auth!;
    const perms = await deps.iam.resolve(auth.userId, auth.permissionVersion);
    return perms.platform.includes('refund:approve');
  };

  /* ---------------- dashboard and alerts (API-ADM-001…003) ---------------- */
  router.get(
    '/admin/dashboard',
    ...can('dashboard:read'),
    handle({}, async ({ res }) => sendOk(res, await dashboard.dashboard())),
  );
  router.get(
    '/admin/alerts',
    ...can('ops:monitor'),
    handle(
      {
        query: pageQuery.extend({
          status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional(),
          type: z.string().trim().min(1).max(60).optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await dashboard.alerts(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.post(
    '/admin/alerts/:id/acknowledge',
    ...can('ops:monitor'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            resolve: z.boolean().default(false),
            note: z.string().trim().min(1).max(500).optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await dashboard.acknowledge(actorOf(res), params.id, body)),
    ),
  );

  /* ---------------- orders (API-ADM-060…065, 067) ---------------- */
  router.get(
    '/admin/orders',
    ...can('order:read:any'),
    handle(
      {
        query: pageQuery.extend({
          q: z.string().trim().min(1).max(40).optional(),
          status: ORDER_STATUS.optional(),
          zone: schema.idSchema.optional(),
          restaurantId: schema.idSchema.optional(),
          partnerId: schema.idSchema.optional(),
          from: when,
          to: when,
        }),
      },
      async ({ query, res }) => {
        const r = await orders.list(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/orders/:id',
    ...can('order:read:any'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await orders.detail(params.id)),
    ),
  );
  router.post(
    '/admin/orders/:id/cancel',
    ...can('order:cancel:any'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            reasonCode: code,
            fault: z.enum(['CUSTOMER', 'RESTAURANT', 'PARTNER', 'PLATFORM']),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await orders.cancel(actorOf(res), params.id, body), {
          message: 'Order cancelled',
        }),
    ),
  );
  router.post(
    '/admin/orders/:id/mark-delivered',
    ...can('order:override'),
    handle(
      {
        params: idParams,
        body: z.object({ reason: reasonSchema, cashCollected: z.boolean().optional() }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await orders.markDelivered(actorOf(res), params.id, body), {
          message: 'Order marked delivered',
        }),
    ),
  );
  router.post(
    '/admin/orders/:id/mark-failed',
    ...can('order:override'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            cause: z.enum(['DELIVERY_FAILED', 'CUSTOMER_UNREACHABLE']),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await orders.markFailed(actorOf(res), params.id, body), {
          message: 'Delivery marked failed',
        }),
    ),
  );
  router.post(
    '/admin/orders/:id/extend-acceptance',
    ...can('order:ops'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            minutes: z.number().int().min(1).max(MAX_ACCEPT_EXTENSION_MINUTES).default(5),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await orders.extendAcceptance(actorOf(res), params.id, body)),
    ),
  );
  router.get(
    '/admin/orders/:id/audit',
    ...can('audit:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await orders.auditTrail(params.id)),
    ),
  );

  /* ---------------- dispatch board (API-ADM-070…075) ---------------- */
  router.get(
    '/admin/deliveries',
    ...can('dispatch:read'),
    handle(
      {
        query: pageQuery.extend({
          status: DELIVERY_STATUS.optional(),
          escalated: bool,
          zone: schema.idSchema.optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await dispatch.board(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/deliveries/:id/candidates',
    ...can('dispatch:assign'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await dispatch.candidates(params.id)),
    ),
  );
  const assignBody = z
    .object({ partnerId: schema.idSchema, force: z.boolean().default(false), reason: reasonSchema })
    .strict();
  router.post(
    '/admin/deliveries/:id/assign',
    ...can('dispatch:assign'),
    handle({ params: idParams, body: assignBody }, async ({ params, body, res }) =>
      sendOk(res, await dispatch.assign(actorOf(res), params.id, body), {
        message: 'Partner assigned',
      }),
    ),
  );
  router.post(
    '/admin/deliveries/:id/reassign',
    ...can('dispatch:assign'),
    handle({ params: idParams, body: assignBody }, async ({ params, body, res }) =>
      sendOk(res, await dispatch.reassign(actorOf(res), params.id, body), {
        message: 'Partner reassigned',
      }),
    ),
  );
  router.post(
    '/admin/deliveries/:id/redispatch',
    ...can('dispatch:assign'),
    handle(
      { params: idParams, body: z.object({ reason: reasonSchema.optional() }).strict() },
      async ({ params, body, res }) =>
        sendOk(res, await dispatch.redispatch(actorOf(res), params.id, body.reason)),
    ),
  );
  router.post(
    '/admin/deliveries/:id/extend-deadline',
    ...can('dispatch:assign'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            minutes: z.number().int().min(5).max(MAX_DEADLINE_EXTENSION_MINUTES).default(15),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await dispatch.extendDeadline(actorOf(res), params.id, body)),
    ),
  );

  /* ---------------- payments (API-ADM-080…083) ---------------- */
  router.get(
    '/admin/payments',
    ...can('payment:read'),
    handle(
      {
        query: pageQuery.extend({
          status: PAYMENT_STATUS.optional(),
          provider: PROVIDER.optional(),
          from: when,
          to: when,
          q: z.string().trim().min(1).max(100).optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await finance.paymentList(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/payments/:id',
    ...can('payment:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await finance.payment(params.id)),
    ),
  );
  router.post(
    '/admin/payments/:id/sync',
    ...can('payment:ops'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await finance.syncPayment(actorOf(res), params.id, body.reason)),
    ),
  );
  router.get(
    '/admin/webhook-events',
    ...can('payment:read'),
    handle(
      {
        query: pageQuery.extend({
          provider: PROVIDER.optional(),
          status: z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']).optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await finance.webhookEvents(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );

  /* ---------------- refunds (API-ADM-084…087) ---------------- */
  router.get(
    '/admin/refunds',
    ...can('refund:read'),
    handle(
      { query: pageQuery.extend({ status: REFUND_STATUS.optional() }) },
      async ({ query, res }) => {
        const r = await finance.refundList(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.post(
    '/admin/orders/:id/refunds',
    ...can('refund:create'),
    once,
    handle(
      {
        params: idParams,
        body: z
          .object({
            amount: z.number().int().min(1).max(10_000_000),
            items: z
              .array(
                z
                  .object({
                    orderItemId: schema.idSchema,
                    quantity: z.number().int().min(1).max(100),
                  })
                  .strict(),
              )
              .max(50)
              .optional(),
            destination: z.enum(['SOURCE', 'WALLET']),
            reasonCode: code,
            note: reasonSchema,
            costBearer: z.enum(['PLATFORM', 'RESTAURANT', 'PARTNER']),
            requestApproval: z.boolean().default(false),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(
          res,
          await finance.createRefund(actorOf(res), params.id, body, await approver(res)),
          { status: 201, message: 'Refund created' },
        ),
    ),
  );
  router.post(
    '/admin/refunds/:id/approve',
    ...can('refund:approve'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await finance.approveRefund(actorOf(res), params.id, body.reason), {
        message: 'Refund approved',
      }),
    ),
  );
  router.post(
    '/admin/refunds/:id/retry',
    ...can('refund:create'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await finance.retryRefund(actorOf(res), params.id, body.reason), {
        message: 'Refund queued again',
      }),
    ),
  );

  /* ---------------- payout batches (API-ADM-091…097) ---------------- */
  router.get(
    '/admin/payout-batches',
    ...can('payout:read'),
    handle(
      { query: pageQuery.extend({ type: PAYEE.optional(), status: BATCH_STATUS.optional() }) },
      async ({ query, res }) => {
        const r = await finance.batches(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.post(
    '/admin/payout-batches',
    ...can('payout:create'),
    once,
    handle(
      {
        body: z
          .object({ type: PAYEE, periodStart: z.coerce.date().optional(), reason: reasonSchema })
          .strict(),
      },
      async ({ body, res }) =>
        sendOk(res, await finance.createBatch(actorOf(res), body), {
          status: 201,
          message: 'Payout batch created',
        }),
    ),
  );
  router.get(
    '/admin/payout-batches/:id',
    ...can('payout:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await finance.batch(params.id)),
    ),
  );
  router.post(
    '/admin/payout-batches/:id/approve',
    ...can('payout:approve'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await finance.approveBatch(actorOf(res), params.id, body.reason), {
        message: 'Payout batch approved',
      }),
    ),
  );
  router.get(
    '/admin/payout-batches/:id/export',
    ...can('payout:approve'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await finance.exportBatch(actorOf(res), params.id)),
    ),
  );
  router.post(
    '/admin/payout-batches/:id/lines/:lineId/mark-paid',
    ...can('payout:execute'),
    once,
    handle(
      {
        params: lineParams,
        body: z
          .object({
            utr: z
              .string()
              .trim()
              .regex(/^[A-Za-z0-9]{6,40}$/, 'Enter the bank reference (UTR)'),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await finance.markPaid(actorOf(res), params.id, params.lineId, body), {
          message: 'Payout recorded as paid',
        }),
    ),
  );
  router.post(
    '/admin/payout-batches/:id/lines/:lineId/mark-failed',
    ...can('payout:execute'),
    handle({ params: lineParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await finance.markFailed(actorOf(res), params.id, params.lineId, body.reason), {
        message: 'Payout recorded as failed',
      }),
    ),
  );
  return router;
}
