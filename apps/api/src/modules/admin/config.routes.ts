import { Router } from 'express';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { COUPON_CODE } from '../offers';
import {
  actorOf,
  adminGuards,
  idParams,
  pageQuery,
  reasonBody,
  reasonSchema,
  type AdminHttpDeps,
} from './admin.http';
import type { AdminConfigService } from './config.service';
import type { AdminCouponsService } from './coupons.service';
import { MAX_SURGE_AMOUNT, type AdminZonesService } from './zones.service';

export interface AdminConfigRouterDeps extends AdminHttpDeps {
  adminCoupons: AdminCouponsService;
  adminZones: AdminZonesService;
  adminConfig: AdminConfigService;
}

const paise = (max: number) => z.number().int().min(0).max(max);
const when = z.coerce.date();
const ids = z.array(schema.idSchema).max(500);
const text = (max: number) => z.string().trim().min(1).max(max);

/* ------------------------------ coupons ------------------------------ */

const couponFields = {
  description: text(300),
  discountType: z.enum(['FLAT', 'PERCENT', 'FREE_DELIVERY']),
  value: z.number().int().min(0).max(10_000_000),
  maxDiscountAmount: paise(10_000_000).nullable(),
  minSubtotalAmount: paise(10_000_000),
  startsAt: when,
  endsAt: when,
  usageLimitTotal: z.number().int().min(1).max(10_000_000).nullable(),
  usageLimitPerUser: z.number().int().min(1).max(100),
  userSegment: z.enum(['ALL', 'NEW_USERS', 'TARGETED']),
  userIds: ids,
  paymentMethodRestriction: z.enum(['ONLINE', 'COD']).nullable(),
  funding: z.enum(['PLATFORM', 'RESTAURANT', 'SHARED']),
  restaurantShareBps: z.number().int().min(0).max(10_000),
  restaurantIds: ids,
  zoneIds: ids,
  stackableWithPromotion: z.boolean(),
  visibility: z.enum(['PUBLIC', 'HIDDEN']),
  status: z.enum(['DRAFT', 'ACTIVE']),
};

const couponCreate = z
  .object({
    ...couponFields,
    code: z
      .string()
      .trim()
      .transform((c) => c.toUpperCase())
      .pipe(z.string().regex(COUPON_CODE, 'Use 4–20 letters and digits')),
    maxDiscountAmount: couponFields.maxDiscountAmount.optional(),
    startsAt: when.optional(),
    usageLimitTotal: couponFields.usageLimitTotal.optional(),
    usageLimitPerUser: couponFields.usageLimitPerUser.default(1),
    userSegment: couponFields.userSegment.default('ALL'),
    userIds: ids.optional(),
    paymentMethodRestriction: couponFields.paymentMethodRestriction.optional(),
    funding: couponFields.funding.default('PLATFORM'),
    restaurantShareBps: couponFields.restaurantShareBps.optional(),
    restaurantIds: ids.optional(),
    zoneIds: ids.optional(),
    minSubtotalAmount: couponFields.minSubtotalAmount.default(0),
    stackableWithPromotion: couponFields.stackableWithPromotion.default(false),
    visibility: couponFields.visibility.default('PUBLIC'),
    status: couponFields.status.default('ACTIVE'),
    reason: reasonSchema,
  })
  .strict();

const couponPatch = z
  .object({ ...couponFields, reason: reasonSchema })
  .partial()
  .required({ reason: true })
  .strict();

/* ------------------------------ zones ------------------------------ */

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const polygon = z
  .object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(lngLat).min(4).max(1000)).min(1).max(1),
  })
  .strict();
const radius = z.number().int().min(500).max(15_000);

/* ------------------------------ pricing ------------------------------ */

const effectiveFrom = when.optional();
const feeSchedule = z
  .object({
    zoneId: schema.idSchema.nullable().optional(),
    platformFeeAmount: paise(10_000),
    smallOrderThresholdAmount: paise(100_000),
    smallOrderFeeAmount: paise(10_000),
    perKmBeyondSlabsAmount: paise(10_000),
    packagingCapPerItemAmount: paise(100_000),
    packagingCapPerOrderAmount: paise(100_000),
    surgeCapAmount: paise(MAX_SURGE_AMOUNT),
    slabs: z
      .array(
        z
          .object({
            fromM: z.number().int().min(0).max(100_000),
            toM: z.number().int().min(1).max(100_000),
            feeAmount: paise(50_000),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    effectiveFrom,
    reason: reasonSchema,
  })
  .strict();
const taxRule = z
  .object({
    component: z.enum([
      'FOOD',
      'PACKAGING',
      'DELIVERY_FEE',
      'PLATFORM_FEE',
      'SMALL_ORDER_FEE',
      'SURGE_FEE',
    ]),
    taxCode: z.enum(['GST', 'CGST', 'SGST', 'IGST']).default('GST'),
    // GST slabs top out at 28 %.
    rateBps: z.number().int().min(0).max(2_800),
    collectedBy: z.enum(['PLATFORM', 'RESTAURANT']),
    effectiveFrom,
    reason: reasonSchema,
  })
  .strict();
const commissionPlan = z
  .object({
    name: text(80),
    rateBps: z.number().int().min(0).max(5_000),
    effectiveFrom,
    reason: reasonSchema,
  })
  .strict();
const payPlan = z
  .object({
    zoneId: schema.idSchema.nullable().optional(),
    baseAmount: paise(50_000),
    perKmAmount: paise(10_000),
    freeKmM: z.number().int().min(0).max(20_000),
    waitAfterMinutes: z.number().int().min(0).max(60),
    perWaitMinuteAmount: paise(1_000),
    waitCapAmount: paise(20_000),
    // BR-EARN-001: zone surge / rain bonus ₹10–₹30 (0 = none).
    rainBonusAmount: z.union([z.literal(0), z.number().int().min(1_000).max(3_000)]),
    cancellationMinAmount: paise(20_000),
    effectiveFrom,
    reason: reasonSchema,
  })
  .strict();
const zoneQuery = z.object({ zoneId: schema.idSchema.optional() }).strict();

/**
 * Admin configuration: coupons, zones, platform settings, the effective-dated
 * pricing tables and cuisines (API-ADM-100…105, 120…126, 130…140, 196…198).
 * ★ actions need a reason and are audited as high-sensitivity (BR-ADMIN-002);
 * maker-checker on pricing (⧉) is CORE.
 */
export function adminConfigRouter(deps: AdminConfigRouterDeps): Router {
  const router = Router();
  const can = adminGuards(deps);
  const { adminCoupons: coupons, adminZones: zones, adminConfig: config } = deps;

  /* ---------------- coupons (API-ADM-100…105) ---------------- */
  router.get(
    '/admin/coupons',
    ...can('coupon:read'),
    handle(
      {
        query: pageQuery.extend({
          status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
          q: z.string().trim().min(1).max(40).optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await coupons.list(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.post(
    '/admin/coupons',
    ...can('coupon:write'),
    handle({ body: couponCreate }, async ({ body, res }) =>
      sendOk(res, await coupons.create(actorOf(res), body), {
        status: 201,
        message: 'Coupon created',
      }),
    ),
  );
  router.get(
    '/admin/coupons/:id',
    ...can('coupon:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await coupons.detail(params.id)),
    ),
  );
  router.patch(
    '/admin/coupons/:id',
    ...can('coupon:write'),
    handle({ params: idParams, body: couponPatch }, async ({ params, body, res }) =>
      sendOk(res, await coupons.update(actorOf(res), params.id, body)),
    ),
  );
  router.post(
    '/admin/coupons/:id/deactivate',
    ...can('coupon:write'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await coupons.deactivate(actorOf(res), params.id, body.reason), {
        message: 'Coupon deactivated',
      }),
    ),
  );
  router.get(
    '/admin/coupons/:id/redemptions',
    ...can('coupon:read'),
    handle({ params: idParams, query: pageQuery }, async ({ params, query, res }) => {
      const r = await coupons.redemptions(params.id, query);
      sendOk(res, r.items, { meta: r.meta });
    }),
  );

  /* ---------------- zones (API-ADM-120…126) ---------------- */
  router.get(
    '/admin/zones',
    ...can('zone:read'),
    handle(
      {
        query: pageQuery.extend({
          status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']).optional(),
          city: z.string().trim().min(1).max(80).optional(),
        }),
      },
      async ({ query, res }) => {
        const r = await zones.list(query);
        sendOk(res, r.items, { meta: r.meta });
      },
    ),
  );
  router.post(
    '/admin/zones',
    ...can('zone:write'),
    handle(
      {
        body: z
          .object({
            name: text(80),
            city: text(80),
            polygon,
            maxDeliveryRadiusM: radius.optional(),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ body, res }) =>
        sendOk(res, await zones.create(actorOf(res), body), {
          status: 201,
          message: 'Zone created',
        }),
    ),
  );
  router.get(
    '/admin/zones/:id',
    ...can('zone:read'),
    handle({ params: idParams }, async ({ params, res }) =>
      sendOk(res, await zones.detail(params.id)),
    ),
  );
  router.patch(
    '/admin/zones/:id',
    ...can('zone:write'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            name: text(80).optional(),
            city: text(80).optional(),
            polygon: polygon.optional(),
            maxDeliveryRadiusM: radius.optional(),
            rainMode: z.boolean().optional(),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await zones.update(actorOf(res), params.id, body)),
    ),
  );
  router.post(
    '/admin/zones/:id/suspend',
    ...can('zone:ops'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await zones.setStatus(actorOf(res), params.id, 'SUSPENDED', body.reason), {
        message: 'Zone suspended',
      }),
    ),
  );
  router.post(
    '/admin/zones/:id/activate',
    ...can('zone:ops'),
    handle({ params: idParams, body: reasonBody }, async ({ params, body, res }) =>
      sendOk(res, await zones.setStatus(actorOf(res), params.id, 'ACTIVE', body.reason), {
        message: 'Zone activated',
      }),
    ),
  );
  router.put(
    '/admin/zones/:id/surge',
    ...can('zone:ops'),
    handle(
      {
        params: idParams,
        body: z
          .object({
            amount: paise(MAX_SURGE_AMOUNT),
            until: when.optional(),
            label: text(100).optional(),
            reason: reasonSchema,
          })
          .strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await zones.setSurge(actorOf(res), params.id, body)),
    ),
  );

  /* ---------------- settings (API-ADM-130…132) ---------------- */
  const keyParams = z.object({ key: z.string().min(1).max(100) }).strict();
  router.get(
    '/admin/settings',
    ...can('settings:read'),
    handle({}, async ({ res }) => sendOk(res, await config.listSettings())),
  );
  router.patch(
    '/admin/settings/:key',
    ...can('settings:write'),
    handle(
      {
        params: keyParams,
        body: z.object({ value: z.json(), reason: reasonSchema }).strict(),
      },
      async ({ params, body, res }) =>
        sendOk(res, await config.updateSetting(actorOf(res), params.key, body.value, body.reason), {
          message: 'Setting updated',
        }),
    ),
  );
  router.get(
    '/admin/settings/:key/history',
    ...can('settings:read'),
    handle({ params: keyParams, query: pageQuery }, async ({ params, query, res }) => {
      const r = await config.settingHistory(params.key, query);
      sendOk(res, r.items, { meta: r.meta });
    }),
  );

  /* ---------------- pricing (API-ADM-133…140) ---------------- */
  router.get(
    '/admin/fee-schedules',
    ...can('pricing:read'),
    handle({ query: zoneQuery }, async ({ query, res }) =>
      sendOk(res, await config.feeSchedules(query)),
    ),
  );
  router.post(
    '/admin/fee-schedules',
    ...can('pricing:write'),
    handle({ body: feeSchedule }, async ({ body, res }) =>
      sendOk(res, await config.createFeeSchedule(actorOf(res), body), { status: 201 }),
    ),
  );
  router.get(
    '/admin/tax-rules',
    ...can('pricing:read'),
    handle({}, async ({ res }) => sendOk(res, await config.taxRules())),
  );
  router.post(
    '/admin/tax-rules',
    ...can('pricing:write'),
    handle({ body: taxRule }, async ({ body, res }) =>
      sendOk(res, await config.createTaxRule(actorOf(res), body), { status: 201 }),
    ),
  );
  router.get(
    '/admin/commission-plans',
    ...can('commission:read'),
    handle({}, async ({ res }) => sendOk(res, await config.commissionPlans())),
  );
  router.post(
    '/admin/commission-plans',
    ...can('commission:write'),
    handle({ body: commissionPlan }, async ({ body, res }) =>
      sendOk(res, await config.createCommissionPlan(actorOf(res), body), { status: 201 }),
    ),
  );
  router.get(
    '/admin/partner-pay-plans',
    ...can('earnings:read'),
    handle({ query: zoneQuery }, async ({ query, res }) =>
      sendOk(res, await config.payPlans(query)),
    ),
  );
  router.post(
    '/admin/partner-pay-plans',
    ...can('earnings:config'),
    handle({ body: payPlan }, async ({ body, res }) =>
      sendOk(res, await config.createPayPlan(actorOf(res), body), { status: 201 }),
    ),
  );

  /* ---------------- cuisines (API-ADM-196…198) ---------------- */
  router.get(
    '/admin/cuisines',
    ...can('content:read'),
    handle({}, async ({ res }) => sendOk(res, await config.cuisines())),
  );
  router.post(
    '/admin/cuisines',
    ...can('content:write'),
    handle(
      {
        body: z
          .object({
            name: text(60),
            slug: z
              .string()
              .trim()
              .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase words joined by hyphens')
              .max(60)
              .optional(),
          })
          .strict(),
      },
      async ({ body, res }) =>
        sendOk(res, await config.createCuisine(actorOf(res), body), { status: 201 }),
    ),
  );
  router.patch(
    '/admin/cuisines/:id',
    ...can('content:write'),
    handle(
      {
        params: idParams,
        body: z
          .object({ name: text(60).optional(), isActive: z.boolean().optional() })
          .strict()
          .refine((b) => b.name !== undefined || b.isActive !== undefined, {
            message: 'Nothing to change',
          }),
      },
      async ({ params, body, res }) =>
        sendOk(res, await config.updateCuisine(actorOf(res), params.id, body)),
    ),
  );

  return router;
}
