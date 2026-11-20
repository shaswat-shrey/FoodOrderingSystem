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
import type { BranchOpsService } from './branch-ops.service';
import { weeklyHoursSchema } from './hours';
import type { RestaurantProfileService } from './profile.service';

export interface BranchRouterDeps extends AuthMiddlewareDeps {
  merchantAccess: MerchantAccess;
  branchOps: BranchOpsService;
  restaurantProfile: RestaurantProfileService;
  limiter: RateLimiter;
}

const rid = z.object({ rid: schema.idSchema }).strict();
const bid = z.object({ bid: schema.idSchema }).strict();
const paise = z.number().int().min(0).max(10_000_000);
const fileBody = z.object({ fileId: schema.idSchema }).strict();

const changeBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('LEGAL_NAME'),
      values: z.object({ legalName: z.string().trim().min(2).max(200) }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('PAN'), values: z.object({ pan: schema.panSchema }).strict() })
    .strict(),
  z
    .object({ type: z.literal('GSTIN'), values: z.object({ gstin: schema.gstinSchema }).strict() })
    .strict(),
  z
    .object({
      type: z.literal('FSSAI'),
      values: z
        .object({
          fssaiNumber: schema.fssaiSchema,
          fssaiExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('BANK_ACCOUNT'),
      values: z
        .object({
          holderName: z.string().trim().min(2).max(120),
          accountNumber: schema.bankAccountNumberSchema,
          ifsc: schema.ifscSchema,
        })
        .strict(),
    })
    .strict(),
]);

/** Restaurant profile and branch operations (API-MER-008…014, 016…027). */
export function branchRouter(deps: BranchRouterDeps): Router {
  const router = Router();
  const member: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps),
    requireApp('RESTAURANT'),
  ];
  const writes = rateLimit(deps.limiter, {
    name: 'rl:write:user',
    limit: 120,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth!.userId,
  });
  const me = (res: Response) => res.locals.auth!.userId;
  const access = deps.merchantAccess;

  /* ---------- restaurant ---------- */
  router.get(
    '/merchant/restaurants/:rid',
    ...member,
    handle({ params: rid }, async ({ params, res }) => {
      await access.restaurant(res, params.rid, 'rest.restaurant:read');
      sendOk(res, await deps.restaurantProfile.view(params.rid));
    }),
  );
  router.patch(
    '/merchant/restaurants/:rid',
    ...member,
    writes,
    handle(
      {
        params: rid,
        body: z
          .object({
            description: z.string().trim().max(1000).nullable().optional(),
            contactEmail: z.email().max(254).optional(),
            contactPhone: schema.indianMobileSchema.optional(),
            cuisineIds: z.array(schema.idSchema).min(1).max(5).optional(),
            pureVeg: z.boolean().optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await access.restaurant(res, params.rid, 'rest.restaurant:update');
        sendOk(res, await deps.restaurantProfile.update(me(res), params.rid, body));
      },
    ),
  );
  for (const kind of ['logo', 'cover'] as const) {
    router.put(
      `/merchant/restaurants/:rid/${kind}`,
      ...member,
      writes,
      handle({ params: rid, body: fileBody }, async ({ params, body, res }) => {
        await access.restaurant(res, params.rid, 'rest.restaurant:update');
        sendOk(res, await deps.restaurantProfile.setImage(me(res), params.rid, kind, body.fileId));
      }),
    );
  }
  router.post(
    '/merchant/restaurants/:rid/change-requests',
    ...member,
    writes,
    handle({ params: rid, body: changeBody }, async ({ params, body, res }) => {
      await access.restaurant(res, params.rid, 'rest.restaurant:legal');
      await deps.sessions.requireRecentReauth(res.locals.auth!.sessionId); // BR-AUTH-017
      sendOk(
        res,
        await deps.restaurantProfile.requestChange(
          me(res),
          params.rid,
          body.type,
          body.values as Record<string, string>,
        ),
        { status: 201, message: 'Sent for verification' },
      );
    }),
  );
  router.get(
    '/merchant/restaurants/:rid/change-requests',
    ...member,
    handle({ params: rid }, async ({ params, res }) => {
      await access.restaurant(res, params.rid, 'rest.restaurant:read');
      sendOk(res, await deps.restaurantProfile.changeRequests(params.rid));
    }),
  );
  router.get(
    '/merchant/restaurants/:rid/branches',
    ...member,
    handle({ params: rid }, async ({ params, res }) => {
      const only = await access.branchesIn(res, params.rid, 'rest.branch:read');
      sendOk(res, await deps.restaurantProfile.branches(params.rid, only));
    }),
  );

  /* ---------- branch ---------- */
  router.get(
    '/merchant/branches/:bid',
    ...member,
    handle({ params: bid }, async ({ params, res }) => {
      await access.branch(res, params.bid, 'rest.branch:read');
      sendOk(res, await deps.branchOps.settings_(params.bid));
    }),
  );
  router.patch(
    '/merchant/branches/:bid',
    ...member,
    writes,
    handle(
      {
        params: bid,
        body: z
          .object({
            name: z.string().trim().min(2).max(120).optional(),
            phone: schema.indianMobileSchema.nullable().optional(),
            deliveryRadiusM: z.number().int().min(500).max(15_000).optional(),
            minOrderAmount: z.number().int().min(0).max(50_000).optional(),
            maxOrderAmount: paise.nullable().optional(),
            priceForTwo: paise.nullable().optional(),
            packagingFeeMode: z.enum(['NONE', 'PER_ITEM', 'PER_ORDER']).optional(),
            packagingFeeAmount: paise.optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await access.branch(res, params.bid, 'rest.branch:update');
        sendOk(res, await deps.branchOps.updateSettings(me(res), params.bid, body));
      },
    ),
  );
  router.put(
    '/merchant/branches/:bid/hours',
    ...member,
    writes,
    handle(
      { params: bid, body: z.object({ hours: weeklyHoursSchema }).strict() },
      async ({ params, body, res }) => {
        await access.branch(res, params.bid, 'rest.branch:hours');
        sendOk(res, await deps.branchOps.replaceHours(me(res), params.bid, body.hours));
      },
    ),
  );
  router.get(
    '/merchant/branches/:bid/holidays',
    ...member,
    handle({ params: bid }, async ({ params, res }) => {
      await access.branch(res, params.bid, 'rest.branch:read');
      sendOk(res, await deps.branchOps.holidays(params.bid));
    }),
  );
  router.post(
    '/merchant/branches/:bid/holidays',
    ...member,
    writes,
    handle(
      {
        params: bid,
        body: z
          .object({
            startsAt: z.coerce.date(),
            endsAt: z.coerce.date(),
            reason: z.string().trim().max(200).optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await access.branch(res, params.bid, 'rest.branch:hours');
        sendOk(res, await deps.branchOps.addHoliday(me(res), params.bid, body), { status: 201 });
      },
    ),
  );
  router.delete(
    '/merchant/branches/:bid/holidays/:hid',
    ...member,
    writes,
    handle(
      { params: z.object({ bid: schema.idSchema, hid: schema.idSchema }).strict() },
      async ({ params, res }) => {
        await access.branch(res, params.bid, 'rest.branch:hours');
        await deps.branchOps.removeHoliday(me(res), params.bid, params.hid);
        sendOk(res, null, { message: 'Closure removed' });
      },
    ),
  );
  router.get(
    '/merchant/branches/:bid/go-live',
    ...member,
    handle({ params: bid }, async ({ params, res }) => {
      await access.branch(res, params.bid, 'rest.branch:read');
      const missing = await deps.branchOps.goLiveMissing(params.bid);
      sendOk(res, { ready: missing.length === 0, missing });
    }),
  );
  router.post(
    '/merchant/branches/:bid/open',
    ...member,
    writes,
    handle({ params: bid }, async ({ params, res }) => {
      await access.branch(res, params.bid, 'rest.branch:status');
      sendOk(res, await deps.branchOps.open(me(res), params.bid));
    }),
  );
  router.post(
    '/merchant/branches/:bid/close',
    ...member,
    writes,
    handle(
      { params: bid, body: z.object({ reason: z.string().trim().max(200).optional() }).strict() },
      async ({ params, body, res }) => {
        await access.branch(res, params.bid, 'rest.branch:status');
        sendOk(res, await deps.branchOps.close(me(res), params.bid, body.reason));
      },
    ),
  );
  router.post(
    '/merchant/branches/:bid/pause',
    ...member,
    writes,
    handle(
      {
        params: bid,
        body: z
          .object({
            // BR-REST-002: 15/30/45/60 minutes, or omitted for "until I resume".
            minutes: z
              .union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)])
              .optional(),
            reason: z.enum(['BUSY_KITCHEN', 'OUT_OF_INGREDIENTS', 'STAFF_SHORTAGE', 'OTHER']),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await access.branch(res, params.bid, 'rest.branch:status');
        sendOk(res, await deps.branchOps.pause(me(res), params.bid, body));
      },
    ),
  );
  router.post(
    '/merchant/branches/:bid/resume',
    ...member,
    writes,
    handle({ params: bid }, async ({ params, res }) => {
      await access.branch(res, params.bid, 'rest.branch:status');
      sendOk(res, await deps.branchOps.resume(me(res), params.bid));
    }),
  );
  router.patch(
    '/merchant/branches/:bid/prep-time',
    ...member,
    writes,
    handle(
      {
        params: bid,
        body: z
          .object({
            defaultPrepMinutes: z.number().int().min(5).max(90).optional(),
            rush: z
              .object({
                extraMinutes: z.union([z.literal(0), z.literal(10), z.literal(20), z.literal(30)]),
                forMinutes: z.number().int().min(15).max(120).default(60),
              })
              .strict()
              .optional(),
          })
          .strict()
          .refine(
            (b) => b.defaultPrepMinutes !== undefined || b.rush !== undefined,
            'Nothing to change.',
          ),
      },
      async ({ params, body, res }) => {
        await access.branch(res, params.bid, 'rest.branch:update');
        sendOk(res, await deps.branchOps.prepTime(me(res), params.bid, body));
      },
    ),
  );
  router.get(
    '/merchant/branches/:bid/status',
    ...member,
    handle({ params: bid }, async ({ params, res }) => {
      await access.branch(res, params.bid, 'rest.branch:read');
      sendOk(res, await deps.branchOps.status(params.bid));
    }),
  );
  return router;
}
