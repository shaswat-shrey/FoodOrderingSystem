import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { MerchantAccess } from './access';
import type { RestaurantAnalyticsService } from './analytics.service';
import { INVITABLE_ROLES, type StaffService } from './staff.service';

export interface StaffRouterDeps extends AuthMiddlewareDeps {
  merchantAccess: MerchantAccess;
  staff: StaffService;
  restaurantAnalytics: RestaurantAnalyticsService;
  limiter: RateLimiter;
}

const rid = z.object({ rid: schema.idSchema }).strict();
const scope = {
  allBranches: z.boolean(),
  branchIds: z.array(schema.idSchema).max(100).optional(),
};
const range = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    branchIds: z.string().optional(),
  })
  .strict()
  .refine(
    (r) => r.to > r.from && r.to.getTime() - r.from.getTime() <= 366 * 86_400_000,
    'Pick a range of up to a year.',
  );

/** Staff (API-RSTAFF-001…008) and analytics (API-RANL-001…004, 007). */
export function staffRouter(deps: StaffRouterDeps): Router {
  const router = Router();
  const member: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps),
    requireApp('RESTAURANT'),
  ];
  const writes = rateLimit(deps.limiter, {
    name: 'rl:staff:user',
    limit: 30,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth!.userId,
  });
  const me = (res: Response) => res.locals.auth!.userId;
  const access = deps.merchantAccess;

  router.get(
    '/merchant/restaurants/:rid/members',
    ...member,
    handle({ params: rid }, async ({ params, res }) => {
      await access.restaurant(res, params.rid, 'rest.staff:read');
      sendOk(res, await deps.staff.members(params.rid));
    }),
  );
  router.post(
    '/merchant/restaurants/:rid/invitations',
    ...member,
    writes,
    handle(
      {
        params: rid,
        body: z
          .object({
            phone: schema.indianMobileSchema.optional(),
            email: z.email().max(254).optional(),
            role: z.enum(INVITABLE_ROLES),
            ...scope,
          })
          .strict()
          .refine((b) => b.phone || b.email, 'Give a phone number or an email.'),
      },
      async ({ params, body, res }) => {
        const grant = await access.grant(res, params.rid, 'rest.staff:manage');
        sendOk(res, await deps.staff.invite(me(res), grant, params.rid, body), {
          status: 201,
          message: 'Invitation sent',
        });
      },
    ),
  );
  router.get(
    '/merchant/restaurants/:rid/invitations',
    ...member,
    handle({ params: rid }, async ({ params, res }) => {
      await access.restaurant(res, params.rid, 'rest.staff:read');
      sendOk(res, await deps.staff.invitations(params.rid));
    }),
  );
  router.delete(
    '/merchant/restaurants/:rid/invitations/:id',
    ...member,
    writes,
    handle(
      { params: z.object({ rid: schema.idSchema, id: schema.idSchema }).strict() },
      async ({ params, res }) => {
        const grant = await access.grant(res, params.rid, 'rest.staff:manage');
        await deps.staff.revokeInvitation(me(res), grant, params.rid, params.id);
        sendOk(res, null, { message: 'Invitation withdrawn' });
      },
    ),
  );
  router.patch(
    '/merchant/restaurants/:rid/members/:mid',
    ...member,
    writes,
    handle(
      {
        params: z.object({ rid: schema.idSchema, mid: schema.idSchema }).strict(),
        body: z
          .object({
            role: z.enum(INVITABLE_ROLES).optional(),
            status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
            scope: z.object(scope).strict().optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        const grant = await access.grant(res, params.rid, 'rest.staff:manage');
        sendOk(res, await deps.staff.update(me(res), grant, params.rid, params.mid, body));
      },
    ),
  );
  router.delete(
    '/merchant/restaurants/:rid/members/:mid',
    ...member,
    writes,
    handle(
      { params: z.object({ rid: schema.idSchema, mid: schema.idSchema }).strict() },
      async ({ params, res }) => {
        const grant = await access.grant(res, params.rid, 'rest.staff:manage');
        await deps.staff.remove(me(res), grant, params.rid, params.mid);
        sendOk(res, null, { message: 'Removed from the team' });
      },
    ),
  );

  // Invitation preview is public; accepting needs a signed-in (possibly new) restaurant-app user.
  router.get(
    '/merchant/invitations/:token',
    handle(
      { params: z.object({ token: z.string().min(20).max(100) }).strict() },
      async ({ params, res }) => {
        res.setHeader('Cache-Control', 'no-store');
        sendOk(res, await deps.staff.preview(params.token));
      },
    ),
  );
  router.post(
    '/merchant/invitations/:token/accept',
    requireClientApp(),
    authenticate(deps, { allowOnboarding: true }),
    requireApp('RESTAURANT'),
    writes,
    handle(
      { params: z.object({ token: z.string().min(20).max(100) }).strict() },
      async ({ params, res }) => {
        sendOk(res, await deps.staff.accept(me(res), params.token), {
          message: 'Welcome to the team',
        });
      },
    ),
  );

  /* analytics */
  const scoped = async (res: Response, restaurantId: string, raw?: string) => {
    const allowed = await access.branchesIn(res, restaurantId, 'rest.analytics:read');
    const asked = raw ? raw.split(',').filter(Boolean) : null;
    if (!asked) return allowed;
    if (allowed && asked.some((b) => !allowed.includes(b)))
      return allowed.filter((b) => asked.includes(b));
    return asked;
  };
  router.get(
    '/merchant/restaurants/:rid/dashboard',
    ...member,
    handle(
      { params: rid, query: z.object({ branchIds: z.string().optional() }).strict() },
      async ({ params, query, res }) => {
        sendOk(
          res,
          await deps.restaurantAnalytics.dashboard(
            params.rid,
            await scoped(res, params.rid, query.branchIds),
          ),
        );
      },
    ),
  );
  router.get(
    '/merchant/restaurants/:rid/analytics/sales',
    ...member,
    handle(
      {
        params: rid,
        query: z
          .object({
            from: z.coerce.date(),
            to: z.coerce.date(),
            granularity: z.enum(['day', 'week', 'month']).default('day'),
            branchIds: z.string().optional(),
          })
          .strict(),
      },
      async ({ params, query, res }) => {
        sendOk(
          res,
          await deps.restaurantAnalytics.sales(
            params.rid,
            await scoped(res, params.rid, query.branchIds),
            query,
          ),
        );
      },
    ),
  );
  for (const [path, fn] of [
    ['items', 'items'],
    ['categories', 'categories'],
    ['operations', 'operations'],
  ] as const) {
    router.get(
      `/merchant/restaurants/:rid/analytics/${path}`,
      ...member,
      handle({ params: rid, query: range }, async ({ params, query, res }) => {
        const branches = await scoped(res, params.rid, query.branchIds);
        sendOk(
          res,
          await deps.restaurantAnalytics[fn](params.rid, branches, {
            from: query.from,
            to: query.to,
          }),
        );
      }),
    );
  }
  return router;
}
