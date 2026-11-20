import type { Request, RequestHandler, Response } from 'express';
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
import type { MerchantAccess } from './access';
import { MAX_PRICE, MIN_PRICE, type MenuAdminService } from './menu-admin.service';

export interface MenuRouterDeps extends AuthMiddlewareDeps {
  merchantAccess: MerchantAccess;
  menuAdmin: MenuAdminService;
  limiter: RateLimiter;
}

const MARKER = z.enum(['VEG', 'NON_VEG', 'EGG']);
const TAGS = z.enum([
  'VEGAN',
  'JAIN',
  'GLUTEN_FREE',
  'DAIRY_FREE',
  'SPICY',
  'KETO',
  'HIGH_PROTEIN',
]);
const ALLERGENS = z.enum([
  'GLUTEN',
  'CRUSTACEANS',
  'EGGS',
  'FISH',
  'PEANUTS',
  'SOY',
  'MILK',
  'TREE_NUTS',
  'CELERY',
  'MUSTARD',
  'SESAME',
  'SULPHITES',
  'LUPIN',
  'MOLLUSCS',
]);
const price = z.number().int().min(MIN_PRICE).max(MAX_PRICE);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const id = schema.idSchema;

const itemFields = {
  categoryId: id,
  name: text(2, 120),
  description: z.string().trim().max(1000).nullable().optional(),
  basePriceAmount: price,
  discountedPriceAmount: price.nullable().optional(),
  dietaryMarker: MARKER,
  spiceLevel: z.number().int().min(0).max(3).nullable().optional(),
  servingSize: z.string().trim().max(60).nullable().optional(),
  prepMinutes: z.number().int().min(1).max(120).nullable().optional(),
  calories: z.number().int().min(0).max(10_000).nullable().optional(),
  isBestseller: z.boolean().optional(),
  isRecommended: z.boolean().optional(),
  isTodaysSpecial: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  packagingFeeAmount: z.number().int().min(0).max(100_000).nullable().optional(),
  tags: z.array(TAGS).max(7).optional(),
  allergens: z.array(ALLERGENS).max(14).optional(),
  ingredients: z.array(text(1, 80)).max(30).optional(),
};
const variant = z
  .object({ name: text(1, 60), priceAmount: price, isDefault: z.boolean().optional() })
  .strict();
const option = z
  .object({
    name: text(1, 80),
    priceDeltaAmount: z.number().int().min(0).max(MAX_PRICE),
    dietaryMarker: MARKER,
    isDefault: z.boolean().optional(),
  })
  .strict();
const availability = z
  .object({
    available: z.boolean(),
    // "Until end of day", a time, or open-ended (FR-MENU-008).
    until: z
      .union([z.literal('END_OF_DAY'), z.coerce.date()])
      .nullable()
      .optional(),
  })
  .strict();
const ids = (key: string) => z.object({ [key]: z.array(id).min(1).max(500) }).strict();

/** `If-Match: "3"` (or W/"3", or 3) → 3. */
function ifMatch(req: Request): number | undefined {
  const raw = req.header('if-match');
  if (!raw) return undefined;
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n))
    throw new AppError('VALIDATION_ERROR', { message: 'If-Match must be the item version.' });
  return n;
}

/** Menu management (API-RMENU-001…026). Paths under /merchant/restaurants/:rid unless branch-scoped. */
export function menuRouter(deps: MenuRouterDeps): Router {
  const router = Router();
  const member: RequestHandler[] = [
    requireClientApp(),
    authenticate(deps),
    requireApp('RESTAURANT'),
  ];
  const writes = rateLimit(deps.limiter, {
    name: 'rl:menu:user',
    limit: 300,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth!.userId,
  });
  const me = (res: Response) => res.locals.auth!.userId;
  const menu = deps.menuAdmin;
  const base = '/merchant/restaurants/:rid';
  const P = <T extends z.ZodRawShape = Record<never, never>>(extra?: T) =>
    z.object({ rid: id, ...(extra ?? ({} as T)) }).strict();
  const canRead = (res: Response, rid: string) =>
    deps.merchantAccess.restaurant(res, rid, 'rest.menu:read');
  const canWrite = (res: Response, rid: string) =>
    deps.merchantAccess.restaurant(res, rid, 'rest.menu:write');

  router.get(
    `${base}/menu`,
    ...member,
    handle(
      { params: P(), query: z.object({ branchId: id.optional() }).strict() },
      async ({ params, query, res }) => {
        await canRead(res, params.rid);
        if (query.branchId) await deps.merchantAccess.branch(res, query.branchId, 'rest.menu:read');
        sendOk(res, await menu.menu(params.rid, query.branchId));
      },
    ),
  );

  /* categories */
  router.post(
    `${base}/categories`,
    ...member,
    writes,
    handle(
      {
        params: P(),
        body: z
          .object({
            name: text(2, 80),
            description: z.string().trim().max(300).nullable().optional(),
            isActive: z.boolean().optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        sendOk(res, await menu.createCategory(me(res), params.rid, body), { status: 201 });
      },
    ),
  );
  router.put(
    `${base}/categories/order`,
    ...member,
    writes,
    handle({ params: P(), body: ids('categoryIds') }, async ({ params, body, res }) => {
      await canWrite(res, params.rid);
      await menu.reorderCategories(me(res), params.rid, body.categoryIds as string[]);
      sendOk(res, null, { message: 'Order saved' });
    }),
  );
  router.patch(
    `${base}/categories/:cid`,
    ...member,
    writes,
    handle(
      {
        params: P({ cid: id }),
        body: z
          .object({
            name: text(2, 80).optional(),
            description: z.string().trim().max(300).nullable().optional(),
            isActive: z.boolean().optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        sendOk(res, await menu.updateCategory(me(res), params.rid, params.cid, body));
      },
    ),
  );
  router.delete(
    `${base}/categories/:cid`,
    ...member,
    writes,
    handle(
      { params: P({ cid: id }), query: z.object({ moveItemsTo: id.optional() }).strict() },
      async ({ params, query, res }) => {
        await canWrite(res, params.rid);
        await menu.deleteCategory(me(res), params.rid, params.cid, query.moveItemsTo);
        sendOk(res, null, { message: 'Category deleted' });
      },
    ),
  );
  router.put(
    `${base}/categories/:cid/items/order`,
    ...member,
    writes,
    handle({ params: P({ cid: id }), body: ids('itemIds') }, async ({ params, body, res }) => {
      await canWrite(res, params.rid);
      await menu.reorderItems(me(res), params.rid, params.cid, body.itemIds as string[]);
      sendOk(res, null, { message: 'Order saved' });
    }),
  );

  /* items */
  router.post(
    `${base}/items`,
    ...member,
    writes,
    handle(
      {
        params: P(),
        body: z.object({ ...itemFields, variants: z.array(variant).max(10).optional() }).strict(),
      },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        const created = await menu.createItem(me(res), params.rid, body);
        res.setHeader('ETag', `"${created.version}"`);
        sendOk(res, created, { status: 201 });
      },
    ),
  );
  router.get(
    `${base}/items/:iid`,
    ...member,
    handle({ params: P({ iid: id }) }, async ({ params, res }) => {
      await canRead(res, params.rid);
      const item = await menu.item(params.rid, params.iid);
      res.setHeader('ETag', `"${item.version}"`);
      sendOk(res, item);
    }),
  );
  router.patch(
    `${base}/items/:iid`,
    ...member,
    writes,
    handle(
      { params: P({ iid: id }), body: z.object(itemFields).partial().strict() },
      async ({ params, body, req, res }) => {
        await canWrite(res, params.rid);
        const item = await menu.updateItem(me(res), params.rid, params.iid, body, ifMatch(req));
        res.setHeader('ETag', `"${item.version}"`);
        sendOk(res, item);
      },
    ),
  );
  router.delete(
    `${base}/items/:iid`,
    ...member,
    writes,
    handle({ params: P({ iid: id }) }, async ({ params, res }) => {
      await canWrite(res, params.rid);
      await menu.deleteItem(me(res), params.rid, params.iid);
      sendOk(res, null, { message: 'Dish deleted' });
    }),
  );
  router.post(
    `${base}/items/:iid/images`,
    ...member,
    writes,
    handle(
      { params: P({ iid: id }), body: z.object({ fileId: id }).strict() },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        sendOk(res, await menu.addImage(me(res), params.rid, params.iid, body.fileId), {
          status: 201,
        });
      },
    ),
  );
  router.put(
    `${base}/items/:iid/images/order`,
    ...member,
    writes,
    handle({ params: P({ iid: id }), body: ids('imageIds') }, async ({ params, body, res }) => {
      await canWrite(res, params.rid);
      sendOk(
        res,
        await menu.reorderImages(me(res), params.rid, params.iid, body.imageIds as string[]),
      );
    }),
  );
  router.delete(
    `${base}/items/:iid/images/:imageId`,
    ...member,
    writes,
    handle({ params: P({ iid: id, imageId: id }) }, async ({ params, res }) => {
      await canWrite(res, params.rid);
      sendOk(res, await menu.removeImage(me(res), params.rid, params.iid, params.imageId));
    }),
  );
  router.post(
    `${base}/items/:iid/variants`,
    ...member,
    writes,
    handle({ params: P({ iid: id }), body: variant }, async ({ params, body, res }) => {
      await canWrite(res, params.rid);
      sendOk(res, await menu.addVariant(me(res), params.rid, params.iid, body), { status: 201 });
    }),
  );
  router.patch(
    `${base}/items/:iid/variants/:vid`,
    ...member,
    writes,
    handle(
      { params: P({ iid: id, vid: id }), body: variant.partial().strict() },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        sendOk(res, await menu.updateVariant(me(res), params.rid, params.iid, params.vid, body));
      },
    ),
  );
  router.delete(
    `${base}/items/:iid/variants/:vid`,
    ...member,
    writes,
    handle({ params: P({ iid: id, vid: id }) }, async ({ params, res }) => {
      await canWrite(res, params.rid);
      sendOk(res, await menu.deleteVariant(me(res), params.rid, params.iid, params.vid));
    }),
  );
  router.put(
    `${base}/items/:iid/customization-groups`,
    ...member,
    writes,
    handle(
      {
        params: P({ iid: id }),
        body: z
          .object({
            groups: z
              .array(z.object({ groupId: id, variantId: id.nullable().optional() }).strict())
              .max(15),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        sendOk(res, await menu.attachGroups(me(res), params.rid, params.iid, body.groups));
      },
    ),
  );

  /* customization groups */
  router.get(
    `${base}/customization-groups`,
    ...member,
    handle({ params: P() }, async ({ params, res }) => {
      await canRead(res, params.rid);
      sendOk(res, await menu.groups(params.rid));
    }),
  );
  router.post(
    `${base}/customization-groups`,
    ...member,
    writes,
    handle(
      {
        params: P(),
        body: z
          .object({
            name: text(2, 80),
            minSelect: z.number().int().min(0).max(30),
            maxSelect: z.number().int().min(1).max(30),
            options: z.array(option).max(30).optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        sendOk(res, await menu.createGroup(me(res), params.rid, body), { status: 201 });
      },
    ),
  );
  router.patch(
    `${base}/customization-groups/:gid`,
    ...member,
    writes,
    handle(
      {
        params: P({ gid: id }),
        body: z
          .object({
            name: text(2, 80).optional(),
            minSelect: z.number().int().min(0).max(30).optional(),
            maxSelect: z.number().int().min(1).max(30).optional(),
          })
          .strict(),
      },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        sendOk(res, await menu.updateGroup(me(res), params.rid, params.gid, body));
      },
    ),
  );
  router.delete(
    `${base}/customization-groups/:gid`,
    ...member,
    writes,
    handle({ params: P({ gid: id }) }, async ({ params, res }) => {
      await canWrite(res, params.rid);
      await menu.deleteGroup(me(res), params.rid, params.gid);
      sendOk(res, null, { message: 'Group deleted' });
    }),
  );
  router.post(
    `${base}/customization-groups/:gid/options`,
    ...member,
    writes,
    handle({ params: P({ gid: id }), body: option }, async ({ params, body, res }) => {
      await canWrite(res, params.rid);
      sendOk(res, await menu.addOption(me(res), params.rid, params.gid, body), { status: 201 });
    }),
  );
  router.patch(
    `${base}/customization-groups/:gid/options/:oid`,
    ...member,
    writes,
    handle(
      { params: P({ gid: id, oid: id }), body: option.partial().strict() },
      async ({ params, body, res }) => {
        await canWrite(res, params.rid);
        sendOk(res, await menu.updateOption(me(res), params.rid, params.gid, params.oid, body));
      },
    ),
  );
  router.delete(
    `${base}/customization-groups/:gid/options/:oid`,
    ...member,
    writes,
    handle({ params: P({ gid: id, oid: id }) }, async ({ params, res }) => {
      await canWrite(res, params.rid);
      sendOk(res, await menu.deleteOption(me(res), params.rid, params.gid, params.oid));
    }),
  );

  /* branch availability (menu:availability, branch-scoped) */
  router.put(
    '/merchant/branches/:bid/items/:iid/availability',
    ...member,
    writes,
    handle(
      { params: z.object({ bid: id, iid: id }).strict(), body: availability },
      async ({ params, body, res }) => {
        const b = await deps.merchantAccess.branch(res, params.bid, 'rest.menu:availability');
        sendOk(
          res,
          await menu.setItemAvailability(me(res), b.restaurantId, b.id, params.iid, body),
        );
      },
    ),
  );
  router.put(
    '/merchant/branches/:bid/options/:oid/availability',
    ...member,
    writes,
    handle(
      { params: z.object({ bid: id, oid: id }).strict(), body: availability },
      async ({ params, body, res }) => {
        const b = await deps.merchantAccess.branch(res, params.bid, 'rest.menu:availability');
        sendOk(
          res,
          await menu.setOptionAvailability(me(res), b.restaurantId, b.id, params.oid, body),
        );
      },
    ),
  );
  return router;
}
