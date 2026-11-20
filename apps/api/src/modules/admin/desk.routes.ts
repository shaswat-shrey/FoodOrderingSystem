import { Router } from 'express';
import { z } from 'zod';
import { QUEUE_NAMES } from '@fos/shared';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { TICKET_CATEGORIES } from '../support';
import {
  actorOf,
  adminGuards,
  idParams,
  pageQuery,
  reasonBody,
  reasonSchema,
  type AdminHttpDeps,
} from './admin.http';
import { STAFF_ROLES, type AdminGovernanceService } from './governance.service';
import type { AdminSupportService } from './support-desk.service';

export interface AdminDeskRouterDeps extends AdminHttpDeps {
  adminSupport: AdminSupportService;
  adminGovernance: AdminGovernanceService;
}

const TICKET_STATUS = z.enum([
  'OPEN',
  'PENDING_CUSTOMER',
  'PENDING_INTERNAL',
  'RESOLVED',
  'CLOSED',
]);
const PRIORITY = z.enum(['URGENT', 'HIGH', 'NORMAL', 'LOW']);
const CATEGORY = z.enum(TICKET_CATEGORIES);
const ROLE = z.enum(STAFF_ROLES);

/**
 * The support desk, review moderation, roles, the audit trail and failed jobs
 * (API-ADM-150…155, 163…165, 180, 183…185, 187, 202, 203). ★ actions need a
 * reason and are audited as high-sensitivity (BR-ADMIN-002).
 */
export function adminDeskRouter(deps: AdminDeskRouterDeps): Router {
  const router = Router();
  const can = adminGuards(deps);
  const { adminSupport: desk, adminGovernance: governance } = deps;

  /* ---------------- tickets (API-ADM-150…155) ---------------- */
  router.get(
    '/admin/tickets',
    ...can('support:read'),
    handle(
      {
        query: pageQuery.extend({
          queue: z.enum(['UNASSIGNED', 'MINE', 'OVERDUE']).optional(),
          status: TICKET_STATUS.optional(),
          priority: PRIORITY.optional(),
          category: CATEGORY.optional(),
          assignee: schema.idSchema.optional(),
          q: z.string().trim().min(1).max(40).optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await desk.tickets(actorOf(res), query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/tickets/:id',
    ...can('support:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await desk.ticket(params.id)),
    ),
  );
  router.post(
    '/admin/tickets/:id/messages',
    ...can('support:write'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            body: z.string().trim().min(1).max(5_000),
            internal: z.boolean().default(false),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await desk.message(actorOf(res), params.id, body), {
          status: 201,
          message: body.internal ? 'Note added' : 'Reply sent',
        }),
    ),
  );
  router.post(
    '/admin/tickets/:id/assign',
    ...can('support:assign'),
    handle(
      {
        params: idParams,
        body: z.object({ assigneeId: schema.idSchema.nullable() }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await desk.assign(actorOf(res), params.id, body.assigneeId)),
    ),
  );
  router.patch(
    '/admin/tickets/:id',
    ...can('support:write'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            status: TICKET_STATUS.optional(),
            priority: PRIORITY.optional(),
            category: CATEGORY.optional(),
          })
          .strict()
          .refine((b) => Object.values(b).some((v) => v !== undefined), {
            message: 'Nothing to change',
          }),
      },
      async ({ params, body, res }) =>
        sendOk(res, await desk.update(actorOf(res), params.id, body)),
    ),
  );
  router.post(
    '/admin/tickets/:id/escalate',
    ...can('support:write'),
    handle(
      {
        params: idParams,
        body: z.object({ reason: reasonSchema, assigneeId: schema.idSchema.optional() }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await desk.escalate(actorOf(res), params.id, body), {
          message: 'Ticket escalated',
        }),
    ),
  );

  /* ---------------- review moderation (API-ADM-163…165) ---------------- */
  router.get(
    '/admin/reviews/reports',
    ...can('review:moderate'),
    handle(
      { query: pageQuery.extend({ status: z.enum(['OPEN', 'UPHELD', 'DISMISSED']).optional() }) },
      async ({ query, res }) => {
        const r = await desk.reportedReviews(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.post(
    '/admin/reviews/:id/hide',
    ...can('review:moderate'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await desk.moderateReview(actorOf(res), params.id, true, body.reason), {
        message: 'Review hidden',
      }),
    ),
  );
  router.post(
    '/admin/reviews/:id/unhide',
    ...can('review:moderate'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await desk.moderateReview(actorOf(res), params.id, false, body.reason), {
        message: 'Review restored',
      }),
    ),
  );

  /* ---------------- roles and permissions (API-ADM-180, 183…185) ---------------- */
  router.get(
    '/admin/roles',
    ...can('iam:read'),
    handle({}, async ({ res }) => sendOk(res, await governance.roles())),
  );
  router.get(
    '/admin/permissions',
    ...can('iam:read'),
    handle({}, async ({ res }) => sendOk(res, await governance.permissions())),
  );
  router.post(
    '/admin/users/:id/roles',
    ...can('iam:assign'),
    handle(
      { params: idParams, body: z.object({ role: ROLE, reason: reasonSchema }).strict() },
      async ({ params, body, res }) =>
        sendOk(res, await governance.grantRole(actorOf(res), params.id, body.role, body.reason), {
          message: 'Role granted',
        }),
    ),
  );
  router.delete(
    '/admin/users/:id/roles/:role',
    ...can('iam:assign'),
    handle(
      {
        params: z.object({ id: schema.idSchema, role: ROLE }).strict(),
        body: reasonBody,
      },
      async ({ params, body, res }) =>
        sendOk(
          res,
          await governance.revokeRole(actorOf(res), params.id, params.role, body.reason),
          { message: 'Role revoked' },
        ),
    ),
  );

  /* ---------------- audit (API-ADM-187) ---------------- */
  router.get(
    '/admin/audit-logs',
    ...can('audit:read'),
    handle(
      {
        query: pageQuery.extend({
          actor: schema.idSchema.optional(),
          targetType: z.string().trim().min(1).max(40).optional(),
          targetId: z.string().trim().min(1).max(100).optional(),
          action: z.string().trim().min(1).max(80).optional(),
          sensitivity: z.enum(['NORMAL', 'HIGH']).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await governance.auditLogs(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );

  /* ---------------- failed jobs (API-ADM-202, 203) ---------------- */
  const QUEUE = z.enum(QUEUE_NAMES);
  router.get(
    '/admin/jobs/failed',
    ...can('ops:jobs'),
    handle(
      {
        query: z
          .object({
            queue: QUEUE.optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          })
          .strict(),
      },
      async ({ query, res }) => sendOk(res, await governance.failedJobs(query.queue, query.limit)),
    ),
  );
  router.post(
    '/admin/jobs/:queue/:jobId/retry',
    ...can('ops:jobs'),
    handle(
      {
        params: z
          .object({
            queue: QUEUE,
            jobId: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[\w:.-]+$/),
          })
          .strict(),
        body: reasonBody,
      },
      async ({ params, body, res }) =>
        sendOk(
          res,
          await governance.retryJob(actorOf(res), params.queue, params.jobId, body.reason),
          { message: 'Job re-queued' },
        ),
    ),
  );

  return router;
}
