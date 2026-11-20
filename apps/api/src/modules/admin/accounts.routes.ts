import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@fos/db';
import { PLATFORM_ROLES } from '@fos/shared';
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
import type { AdminMerchantsService } from './merchants.service';
import { MAX_EARNING_ADJUSTMENT, type AdminPartnersService } from './partners.service';
import { MAX_WALLET_ADJUSTMENT, type AdminUsersService } from './users.service';

export interface AdminAccountsRouterDeps extends AdminHttpDeps {
  prisma: PrismaClient;
  adminUsers: AdminUsersService;
  adminMerchants: AdminMerchantsService;
  adminPartners: AdminPartnersService;
}

const USER_STATUS = z.enum([
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
  'ANONYMIZED',
]);
const ONBOARDING = z.enum([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
]);
const ACCOUNT = z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']);
const PARTNER_DOC = z.enum([
  'DL_FRONT',
  'DL_BACK',
  'RC',
  'INSURANCE',
  'PAN',
  'ID_PROOF',
  'BANK_PROOF',
  'PHOTO',
]);
const q = z.string().trim().min(1).max(80).optional();
const future = z.coerce.date().optional();
/** A signed paise amount: never zero, within the per-action bound. */
const adjustment = (max: number) =>
  z
    .number()
    .int()
    .min(-max)
    .max(max)
    .refine((v) => v !== 0, 'Amount must not be zero');
const comments = z.record(z.string().min(1).max(80), z.string().trim().min(1).max(500));

/**
 * Admin accounts: users, restaurant and partner applications, restaurants,
 * branches, change requests, documents and partners (API-ADM-010…054, except
 * 018 and 039). Every mutation is audited; ★ ones need a reason (BR-ADMIN-002).
 */
export function adminAccountsRouter(deps: AdminAccountsRouterDeps): Router {
  const router = Router();
  const can = adminGuards(deps);
  const once = idempotent(deps.prisma);
  const users = deps.adminUsers;
  const merchants = deps.adminMerchants;
  const partners = deps.adminPartners;

  /* ---------------- users (API-ADM-010…017, 019) ---------------- */
  router.get(
    '/admin/users',
    ...can('user:read'),
    handle(
      {
        query: pageQuery.extend({
          role: z.enum(PLATFORM_ROLES).optional(),
          status: USER_STATUS.optional(),
          q,
        }),
      },
      async ({ query, res }) => {
        const r = await users.list(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/users/:id',
    ...can('user:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await users.detail(params.id)),
    ),
  );
  router.post(
    '/admin/users/:id/suspend',
    ...can('user:suspend'),
    handle(
      {
        params: idParams,
        body: z.object({ reason: reasonSchema, until: future }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await users.suspend(actorOf(res), params.id, body), {
          message: 'User suspended',
        }),
    ),
  );
  router.post(
    '/admin/users/:id/unsuspend',
    ...can('user:suspend'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await users.unsuspend(actorOf(res), params.id, body.reason), {
        message: 'Suspension lifted',
      }),
    ),
  );
  router.post(
    '/admin/users/:id/logout-all',
    ...can('user:sessions'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await users.logoutAll(actorOf(res), params.id, body.reason), {
        message: 'Signed out everywhere',
      }),
    ),
  );
  router.post(
    '/admin/users/:id/pii-reveal',
    ...can('pii:reveal'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await users.revealPii(actorOf(res), params.id, body.reason)),
    ),
  );
  router.post(
    '/admin/users/:id/wallet-adjustments',
    ...can('wallet:adjust'),
    once,
    handle(
      {
        params: idParams,
        body: z
          .object({
            amount: adjustment(MAX_WALLET_ADJUSTMENT),
            reason: reasonSchema,
            expiresAt: future,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await users.adjustWallet(actorOf(res), params.id, body), {
          status: 201,
          message: 'Wallet adjusted',
        }),
    ),
  );
  router.post(
    '/admin/users/:id/cod-block',
    ...can('user:flags'),
    handle(
      {
        params: idParams,
        body: z.object({ blocked: z.boolean(), reason: reasonSchema }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await users.setCodBlock(actorOf(res), params.id, body)),
    ),
  );
  router.get(
    '/admin/users/:id/sessions',
    ...can('user:sessions'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await users.sessionsOf(params.id)),
    ),
  );

  /* ---------------- restaurant applications (API-ADM-020…025) ---------------- */
  router.get(
    '/admin/restaurant-applications',
    ...can('restaurant:review'),
    handle(
      { query: pageQuery.extend({ status: ONBOARDING.optional() }) },
      async ({ query, res }) => {
        const r = await merchants.applications(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/restaurant-applications/:id',
    ...can('restaurant:review'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await merchants.application(params.id)),
    ),
  );
  router.post(
    '/admin/restaurant-applications/:id/start-review',
    ...can('restaurant:review'),
    handle({ params: idParams, body: z.object({}).strict() }, async ({ params, res }) =>
      sendOk(res, await merchants.startReview(actorOf(res), params.id)),
    ),
  );
  for (const [path, decision] of [
    ['approve', 'APPROVED'],
    ['reject', 'REJECTED'],
  ] as const)
    router.post(
      `/admin/restaurant-applications/:id/${path}`,
      ...can('restaurant:approve'),
      handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
        sendOk(
          res,
          await merchants.decideApplication(actorOf(res), params.id, {
            decision,
            reason: body.reason,
          }),
        ),
      ),
    );
  router.post(
    '/admin/restaurant-applications/:id/request-changes',
    ...can('restaurant:review'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            comments: comments.refine((c) => Object.keys(c).length > 0, 'Add at least one comment'),
            reason: reasonSchema.optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(
          res,
          await merchants.decideApplication(actorOf(res), params.id, {
            decision: 'CHANGES_REQUESTED',
            comments: body.comments,
            reason: body.reason,
          }),
        ),
    ),
  );

  /* ---------------- restaurants and branches (API-ADM-026…033, 037, 038) ---------------- */
  router.get(
    '/admin/restaurants',
    ...can('restaurant:read'),
    handle(
      {
        query: pageQuery.extend({
          status: ACCOUNT.optional(),
          zone: schema.idSchema.optional(),
          q,
        }),
      },
      async ({ query, res }) => {
        const r = await merchants.restaurants(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/restaurants/:id',
    ...can('restaurant:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await merchants.restaurant(params.id)),
    ),
  );
  router.patch(
    '/admin/restaurants/:id',
    ...can('restaurant:update'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            reason: reasonSchema,
            brandName: z.string().trim().min(2).max(120).optional(),
            description: z.string().trim().max(1000).nullable().optional(),
            contactEmail: z.email().max(254).optional(),
            contactPhone: schema.indianMobileSchema.optional(),
            pureVeg: z.boolean().optional(),
            cuisineIds: z.array(schema.idSchema).min(1).max(5).optional(),
          })
          .strict()
          .refine((b) => Object.keys(b).length > 1, 'Change at least one field'),
      },
      async ({ params, body, res }) => {
        const { reason, ...patch } = body;
        sendOk(res, await merchants.updateRestaurant(actorOf(res), params.id, patch, reason));
      },
    ),
  );
  router.post(
    '/admin/restaurants/:id/suspend',
    ...can('restaurant:suspend'),
    handle(
      {
        params: idParams,
        body: z.object({ reason: reasonSchema, cancelActive: z.boolean().default(false) }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await merchants.suspendRestaurant(actorOf(res), params.id, body), {
          message: 'Restaurant suspended',
        }),
    ),
  );
  router.post(
    '/admin/restaurants/:id/unsuspend',
    ...can('restaurant:suspend'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await merchants.unsuspendRestaurant(actorOf(res), params.id, body.reason), {
        message: 'Restaurant unsuspended',
      }),
    ),
  );
  for (const [path, action, permission] of [
    ['suspend', 'SUSPEND', 'restaurant:suspend'],
    ['unsuspend', 'UNSUSPEND', 'restaurant:suspend'],
    ['approve', 'APPROVE', 'restaurant:approve'],
  ] as const)
    router.post(
      `/admin/branches/:id/${path}`,
      ...can(permission),
      handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
        sendOk(res, await merchants.setBranchStatus(actorOf(res), params.id, action, body.reason)),
      ),
    );
  router.put(
    '/admin/restaurants/:id/commission',
    ...can('commission:write'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            rateBps: z.number().int().min(0).max(5_000),
            effectiveFrom: future,
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await merchants.setCommission(actorOf(res), params.id, body)),
    ),
  );
  router.put(
    '/admin/restaurants/:id/cod',
    ...can('restaurant:update'),
    handle(
      {
        params: idParams,
        body: z.object({ enabled: z.boolean(), reason: reasonSchema }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await merchants.setCod(actorOf(res), params.id, body)),
    ),
  );

  /* ---------------- change requests (API-ADM-034…036) ---------------- */
  router.get(
    '/admin/change-requests',
    ...can('restaurant:review'),
    handle(
      {
        query: pageQuery.extend({
          type: z.enum(['LEGAL_NAME', 'PAN', 'GSTIN', 'FSSAI', 'BANK_ACCOUNT']).optional(),
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await merchants.changeRequests(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  for (const [path, decision] of [
    ['approve', 'APPROVED'],
    ['reject', 'REJECTED'],
  ] as const)
    router.post(
      `/admin/change-requests/:id/${path}`,
      ...can('restaurant:approve'),
      handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
        sendOk(
          res,
          await merchants.decideChange(actorOf(res), params.id, { decision, reason: body.reason }),
        ),
      ),
    );

  /* ---------------- documents (API-ADM-040) ---------------- */
  router.get(
    '/admin/documents/:id/url',
    ...can('document:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await merchants.documentUrl(actorOf(res), params.id)),
    ),
  );

  /* ---------------- partner applications (API-ADM-041…045, 054) ---------------- */
  router.get(
    '/admin/partner-applications',
    ...can('partner:review'),
    handle(
      {
        query: pageQuery.extend({
          status: ONBOARDING.optional(),
          zone: schema.idSchema.optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await partners.applications(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/partner-applications/:id',
    ...can('partner:review'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await partners.application(params.id)),
    ),
  );
  for (const [path, decision] of [
    ['approve', 'APPROVED'],
    ['reject', 'REJECTED'],
  ] as const)
    router.post(
      `/admin/partner-applications/:id/${path}`,
      ...can('partner:approve'),
      handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
        sendOk(
          res,
          await partners.decide(actorOf(res), params.id, { decision, reason: body.reason }),
        ),
      ),
    );
  router.post(
    '/admin/partner-applications/:id/request-changes',
    ...can('partner:review'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            reason: reasonSchema,
            documentNotes: z
              .partialRecord(PARTNER_DOC, z.string().trim().min(1).max(500))
              .optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(
          res,
          await partners.decide(actorOf(res), params.id, {
            decision: 'CHANGES_REQUESTED',
            reason: body.reason,
            documentNotes: body.documentNotes,
          }),
        ),
    ),
  );
  router.post(
    '/admin/vehicles/:id/verify',
    ...can('partner:review'),
    handle(
      {
        params: idParams,
        body: z
          .object({ decision: z.enum(['VERIFIED', 'REJECTED']), reason: reasonSchema })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await partners.verifyVehicle(actorOf(res), params.id, body)),
    ),
  );

  /* ---------------- partners (API-ADM-046…053) ---------------- */
  router.get(
    '/admin/partners',
    ...can('partner:read'),
    handle(
      {
        query: pageQuery.extend({
          status: ACCOUNT.optional(),
          online: z
            .enum(['true', 'false'])
            .transform((v) => v === 'true')
            .optional(),
          zone: schema.idSchema.optional(),
          q,
        }),
      },
      async ({ query, res }) => {
        const r = await partners.list(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.get(
    '/admin/partners/:id',
    ...can('partner:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await partners.detail(params.id)),
    ),
  );
  router.post(
    '/admin/partners/:id/suspend',
    ...can('partner:suspend'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await partners.suspend(actorOf(res), params.id, body.reason), {
        message: 'Partner suspended',
      }),
    ),
  );
  router.post(
    '/admin/partners/:id/unsuspend',
    ...can('partner:suspend'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await partners.unsuspend(actorOf(res), params.id, body.reason), {
        message: 'Partner unsuspended',
      }),
    ),
  );
  router.post(
    '/admin/partners/:id/force-offline',
    ...can('partner:ops'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await partners.forceOffline(actorOf(res), params.id, body.reason)),
    ),
  );
  router.post(
    '/admin/partners/:id/cash-deposits',
    ...can('partner:cash'),
    once,
    handle(
      {
        params: idParams,
        body: z
          .object({
            amount: z.number().int().min(1).max(10_000_000),
            method: z.enum(['HUB', 'UPI', 'BANK']),
            reference: z.string().trim().min(1).max(80).optional(),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await partners.recordCashDeposit(actorOf(res), params.id, body), {
          status: 201,
          message: 'Deposit recorded',
        }),
    ),
  );
  router.post(
    '/admin/partners/:id/earning-adjustments',
    ...can('earnings:adjust'),
    once,
    handle(
      {
        params: idParams,
        body: z
          .object({
            amount: adjustment(MAX_EARNING_ADJUSTMENT),
            note: z.string().trim().min(2).max(200).optional(),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await partners.adjustEarnings(actorOf(res), params.id, body), {
          status: 201,
          message: 'Earnings adjusted',
        }),
    ),
  );
  router.get(
    '/admin/partners/:id/location-trail',
    ...can('partner:location'),
    handle(
      { params: idParams, query: z.object({ deliveryId: schema.idSchema }).strict() },
      async ({ params, query, res }) =>
        sendOk(res, await partners.locationTrail(actorOf(res), params.id, query.deliveryId)),
    ),
  );
  return router;
}
