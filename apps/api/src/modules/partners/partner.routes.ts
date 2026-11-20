import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { AppError } from '../../platform/http/errors';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { PrismaClient } from '@fos/db';
import { idempotent } from '../../platform/http/middleware/idempotency';
import type { PartnerAvailabilityService } from './availability.service';
import type { PartnerOnboardingService } from './onboarding.service';

export interface PartnerRouterDeps extends AuthMiddlewareDeps {
  partnerOnboarding: PartnerOnboardingService;
  partnerAvailability: PartnerAvailabilityService;
  prisma: PrismaClient;
  limiter: RateLimiter;
}

const VEHICLE = z.enum(['BICYCLE', 'E_BIKE', 'MOTORCYCLE', 'SCOOTER']);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const registration = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/[\s-]/g, ''))
  .pipe(
    z
      .string()
      .regex(
        /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/,
        'Enter a valid registration number, like KA01AB1234',
      ),
  );
const emergency = z
  .object({
    name: z.string().trim().min(2).max(80),
    relation: z.string().trim().min(2).max(40),
    phone: schema.indianMobileSchema,
  })
  .strict();
const patchBody = z
  .object({
    legalName: z.string().trim().min(2).max(120).optional(),
    dateOfBirth: date.optional(),
    homeZoneId: schema.idSchema.optional(),
    photoFileId: schema.idSchema.optional(),
    pan: schema.panSchema.optional(),
    // Only the last four digits are ever stored (SRS §20).
    aadhaarLast4: z
      .string()
      .regex(/^\d{4}$/, 'Only the last 4 digits')
      .optional(),
    emergencyContact: emergency.optional(),
    vehicle: z
      .object({ type: VEHICLE, registrationNumber: registration.nullable().optional() })
      .strict()
      .optional(),
    bank: z
      .object({
        holderName: z.string().trim().min(2).max(120),
        accountNumber: schema.bankAccountNumberSchema,
        ifsc: schema.ifscSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
const docBody = z
  .object({
    type: z.enum([
      'DL_FRONT',
      'DL_BACK',
      'RC',
      'INSURANCE',
      'PAN',
      'ID_PROOF',
      'BANK_PROOF',
      'PHOTO',
    ]),
    fileId: schema.idSchema,
    numberLast4: z
      .string()
      .regex(/^[A-Z0-9]{4}$/i)
      .optional(),
    expiresOn: date.optional(),
  })
  .strict();

const fix = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(5_000),
    recordedAt: z.coerce.date().optional(),
    heading: z.number().int().min(0).max(359).optional(),
    speedKmh: z.number().int().min(0).max(400).optional(),
  })
  .strict();

/** Partner application, profile, vehicles, guidelines and availability (API-DP-001…020). */
export function partnerRouter(deps: PartnerRouterDeps): Router {
  const router = Router();
  const applicant: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps, { allowOnboarding: true }),
    requireApp('DELIVERY'),
  ];
  const writes = rateLimit(deps.limiter, {
    name: 'rl:partner:user',
    limit: 60,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth!.userId,
  });
  const me = (res: Response) => res.locals.auth!.userId;
  const svc = deps.partnerOnboarding;

  router.post(
    '/partner/applications',
    ...applicant,
    writes,
    handle({}, async ({ res }) => sendOk(res, await svc.start(me(res)), { status: 201 })),
  );
  router.get(
    '/partner/applications/me',
    ...applicant,
    handle({}, async ({ res }) => {
      const v = await svc.view(me(res));
      if (!v)
        throw new AppError('NOT_FOUND', { message: 'You haven’t started an application yet.' });
      sendOk(res, v);
    }),
  );
  router.patch(
    '/partner/applications/me',
    ...applicant,
    writes,
    handle({ body: patchBody }, async ({ body, res }) =>
      sendOk(res, await svc.update(me(res), body)),
    ),
  );
  router.post(
    '/partner/applications/me/documents',
    ...applicant,
    writes,
    handle({ body: docBody }, async ({ body, res }) =>
      sendOk(res, await svc.addDocument(me(res), body), { status: 201 }),
    ),
  );
  router.delete(
    '/partner/applications/me/documents/:docId',
    ...applicant,
    writes,
    handle({ params: z.object({ docId: schema.idSchema }).strict() }, async ({ params, res }) =>
      sendOk(res, await svc.removeDocument(me(res), params.docId)),
    ),
  );
  router.post(
    '/partner/applications/me/submit',
    ...applicant,
    writes,
    handle({}, async ({ res }) =>
      sendOk(res, await svc.submit(me(res)), { message: 'Application submitted' }),
    ),
  );

  router.get(
    '/partner/me',
    ...applicant,
    handle({}, async ({ res }) => {
      const v = await svc.view(me(res));
      if (!v)
        throw new AppError('NOT_FOUND', { message: 'You haven’t started an application yet.' });
      sendOk(res, v);
    }),
  );
  router.patch(
    '/partner/me',
    ...applicant,
    writes,
    handle(
      {
        body: z
          .object({
            emergencyContact: emergency.optional(),
            homeZoneId: schema.idSchema.optional(),
          })
          .strict(),
      },
      async ({ body, res }) => sendOk(res, await svc.updateProfile(me(res), body)),
    ),
  );
  router.get(
    '/partner/me/vehicles',
    ...applicant,
    handle({}, async ({ res }) => sendOk(res, (await svc.view(me(res)))?.vehicles ?? [])),
  );
  router.post(
    '/partner/me/vehicles',
    ...applicant,
    writes,
    handle(
      {
        body: z
          .object({ type: VEHICLE, registrationNumber: registration.nullable().optional() })
          .strict(),
      },
      async ({ body, res }) => sendOk(res, await svc.addVehicle(me(res), body), { status: 201 }),
    ),
  );
  router.post(
    '/partner/me/vehicles/:id/activate',
    ...applicant,
    writes,
    handle({ params: z.object({ id: schema.idSchema }).strict() }, async ({ params, res }) =>
      sendOk(res, await svc.activateVehicle(me(res), params.id)),
    ),
  );
  router.post(
    '/partner/me/guidelines/ack',
    ...applicant,
    writes,
    handle({ body: z.object({ version: z.string().max(20) }).strict() }, async ({ body, res }) =>
      sendOk(res, await svc.acknowledgeGuidelines(me(res), body.version)),
    ),
  );

  /** Zones an applicant can choose as their preferred zone (API-DP-002 support). */
  router.get(
    '/partner/zones',
    ...applicant,
    handle({}, async ({ res }) =>
      sendOk(
        res,
        await deps.prisma.zone.findMany({
          where: { status: 'ACTIVE', deletedAt: null },
          select: { id: true, name: true, city: true },
          orderBy: [{ city: 'asc' }, { name: 'asc' }],
        }),
      ),
    ),
  );

  /* availability (approved partners, delivery app) */
  const partner: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps),
    requireApp('DELIVERY'),
  ];
  const av = deps.partnerAvailability;
  router.get(
    '/partner/me/availability',
    ...partner,
    handle({}, async ({ res }) => sendOk(res, await av.availability(me(res)))),
  );
  router.post(
    '/partner/me/online',
    ...partner,
    writes,
    idempotent(deps.prisma),
    handle({ body: fix }, async ({ body, res }) =>
      sendOk(res, await av.goOnline(me(res), body), { message: 'You are online' }),
    ),
  );
  router.post(
    '/partner/me/offline',
    ...partner,
    writes,
    idempotent(deps.prisma),
    handle({}, async ({ res }) => sendOk(res, await av.goOffline(me(res)))),
  );
  router.post(
    '/partner/me/pause',
    ...partner,
    writes,
    handle(
      { body: z.object({ minutes: z.union([z.literal(15), z.literal(30)]) }).strict() },
      async ({ body, res }) => sendOk(res, await av.pause(me(res), body.minutes)),
    ),
  );
  router.post(
    '/partner/me/resume',
    ...partner,
    writes,
    handle({}, async ({ res }) => sendOk(res, await av.resume(me(res)))),
  );
  router.get(
    '/partner/me/dashboard',
    ...partner,
    handle({}, async ({ res }) => sendOk(res, await av.dashboard(me(res)))),
  );
  router.post(
    '/partner/me/locations',
    ...partner,
    rateLimit(deps.limiter, {
      name: 'rl:loc:user',
      limit: 120,
      windowSeconds: 60,
      key: (_req, res) => res.locals.auth!.userId,
    }),
    handle(
      { body: z.object({ points: z.array(fix).min(1).max(60) }).strict() },
      async ({ body, res }) => sendOk(res, await av.ingest(me(res), body.points)),
    ),
  );
  return router;
}
