import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { PrismaClient } from '@fos/db';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { MerchantAccess } from './access';
import { weeklyHoursSchema } from './hours';
import type { OnboardingService } from './onboarding.service';

export interface MerchantRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  onboarding: OnboardingService;
  merchantAccess: MerchantAccess;
  limiter: RateLimiter;
}

const ENTITY = [
  'PROPRIETORSHIP',
  'PARTNERSHIP',
  'LLP',
  'PRIVATE_LIMITED',
  'PUBLIC_LIMITED',
  'OTHER',
] as const;
const name = (max: number) => z.string().trim().min(2).max(max);
const appParams = z.object({ id: schema.idSchema }).strict();
const startBody = z
  .object({ brandName: name(120), legalName: name(200), entityType: z.enum(ENTITY) })
  .strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const patchBody = z
  .object({
    brandName: name(120).optional(),
    legalName: name(200).optional(),
    entityType: z.enum(ENTITY).optional(),
    pan: schema.panSchema.optional(),
    gstin: schema.gstinSchema.nullable().optional(),
    fssaiNumber: schema.fssaiSchema.optional(),
    fssaiExpiresOn: date.optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    contactEmail: z.email().max(254).optional(),
    contactPhone: schema.indianMobileSchema.optional(),
    cuisineIds: z.array(schema.idSchema).min(1).max(5).optional(),
    pureVeg: z.boolean().optional(),
    logoFileId: schema.idSchema.optional(),
    branch: z
      .object({
        name: name(120),
        line1: z.string().trim().min(3).max(200),
        line2: z.string().trim().max(200).nullable().optional(),
        area: name(120),
        city: name(80),
        state: name(80),
        pincode: z.string().regex(/^[1-9]\d{5}$/, 'Enter a 6-digit PIN code'),
        location: z
          .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
          .strict(),
        phone: schema.indianMobileSchema.nullable().optional(),
        deliveryRadiusM: z.number().int().min(500).max(15_000),
        defaultPrepMinutes: z.number().int().min(5).max(90),
        priceForTwo: z.number().int().min(0).max(10_000_000).nullable().optional(),
        hours: weeklyHoursSchema.refine((h) => h.length > 0, 'Add at least one opening slot'),
      })
      .strict()
      .optional(),
    bank: z
      .object({
        holderName: name(120),
        accountNumber: schema.bankAccountNumberSchema,
        ifsc: schema.ifscSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
const docBody = z
  .object({
    type: z.enum(['FSSAI', 'PAN', 'GST', 'BANK_PROOF', 'MENU', 'OTHER']),
    fileId: schema.idSchema,
    expiresOn: date.optional(),
  })
  .strict();

/** Restaurant onboarding and the merchant "who am I" (API-MER-001…007). */
export function merchantRouter(deps: MerchantRouterDeps): Router {
  const router = Router();
  const applicant: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps, { allowOnboarding: true }),
    requireApp('RESTAURANT'),
  ];
  const writes = rateLimit(deps.limiter, {
    name: 'rl:write:user',
    limit: 60,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth!.userId,
  });
  const userId = (res: Response) => res.locals.auth!.userId;

  /** API-MER-007: memberships with effective permissions, plus open applications. */
  router.get(
    '/merchant/me',
    ...applicant,
    handle({}, async ({ res }) => {
      const perms = await deps.merchantAccess.permissions(res);
      const ids = perms.restaurants.map((g) => g.restaurantId);
      const restaurants = await deps.prisma.restaurant.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          brandName: true,
          branches: {
            where: { deletedAt: null },
            select: { id: true, name: true, area: true, status: true },
            orderBy: { name: 'asc' },
          },
        },
      });
      sendOk(res, {
        scope: res.locals.auth!.scope,
        restaurants: perms.restaurants.map((g) => {
          const r = restaurants.find((x) => x.id === g.restaurantId);
          return {
            id: g.restaurantId,
            name: r?.brandName ?? '',
            role: g.role,
            permissions: g.permissions,
            branches: (r?.branches ?? []).filter(
              (b) => g.allBranches || g.branchIds.includes(b.id),
            ),
          };
        }),
        applications: await deps.onboarding.applications(userId(res)),
      });
    }),
  );

  router.post(
    '/merchant/applications',
    ...applicant,
    writes,
    handle({ body: startBody }, async ({ body, res }) =>
      sendOk(res, await deps.onboarding.start(userId(res), body), { status: 201 }),
    ),
  );
  router.get(
    '/merchant/applications/:id',
    ...applicant,
    handle({ params: appParams }, async ({ params, res }) =>
      sendOk(res, await deps.onboarding.view(userId(res), params.id)),
    ),
  );
  router.patch(
    '/merchant/applications/:id',
    ...applicant,
    writes,
    handle({ params: appParams, body: patchBody }, async ({ params, body, res }) =>
      sendOk(res, await deps.onboarding.update(userId(res), params.id, body)),
    ),
  );
  router.post(
    '/merchant/applications/:id/documents',
    ...applicant,
    writes,
    handle({ params: appParams, body: docBody }, async ({ params, body, res }) =>
      sendOk(res, await deps.onboarding.addDocument(userId(res), params.id, body), { status: 201 }),
    ),
  );
  router.delete(
    '/merchant/applications/:id/documents/:docId',
    ...applicant,
    writes,
    handle(
      { params: z.object({ id: schema.idSchema, docId: schema.idSchema }).strict() },
      async ({ params, res }) => {
        await deps.onboarding.removeDocument(userId(res), params.id, params.docId);
        sendOk(res, null, { message: 'Document removed' });
      },
    ),
  );
  router.post(
    '/merchant/applications/:id/submit',
    ...applicant,
    writes,
    handle(
      { params: appParams, body: z.object({ declareNoGst: z.boolean().optional() }).strict() },
      async ({ params, body, res }) =>
        sendOk(res, await deps.onboarding.submit(userId(res), params.id, body), {
          message: 'Application submitted',
        }),
    ),
  );
  return router;
}
