import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Router } from 'express';
import type { PrismaClient } from '@fos/db';
import * as schema from '@fos/validation';
import type { Clock } from '../../platform/clock';
import { sendOk } from '../../platform/http/envelope';
import { AppError } from '../../platform/http/errors';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { byIp, rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { optionalAuthenticate, type AuthMiddlewareDeps } from '../auth';
import { isListed, type BranchRecord, type BranchRepository } from './branch-repository';
import { favoriteRestaurantIds } from './favorites';
import { isVeg, itemDetails, resolveMenu, toCard, type MenuService } from './menu.service';
import type { ServiceabilityService } from './serviceability.service';
import { branchCard, branchPage, deliveryView, hoursView, ratingView } from './views';

export interface CatalogRouterDeps extends AuthMiddlewareDeps {
  prisma: PrismaClient;
  branches: BranchRepository;
  serviceability: ServiceabilityService;
  menus: MenuService;
  limiter: RateLimiter;
  clock: Clock;
}

/**
 * Sends `data` with a strong ETag of its JSON; answers 304 when the client
 * already has it (API-MENU-001). Hashing the final body keeps the tag correct
 * even when time-dependent availability changes without a menu edit.
 */
function sendWithEtag(req: Request, res: Response, data: unknown): void {
  const etag = `"${createHash('sha1').update(JSON.stringify(data)).digest('base64url')}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.header('if-none-match') === etag) {
    res.status(304).end();
    return;
  }
  sendOk(res, data);
}

/** API-REST-001…005, API-MENU-001…007 (public; personalised when signed in). */
export function catalogRouter(deps: CatalogRouterDeps): Router {
  const router = Router();
  const { prisma, branches, serviceability, menus, clock } = deps;
  // Scoped to this router's paths: it is mounted at /api/v1, ahead of other routers.
  router.use(
    ['/restaurants', '/branches'],
    requireClientApp(),
    rateLimit(deps.limiter, { name: 'rl:read:ip', limit: 120, windowSeconds: 60, key: byIp }),
    optionalAuthenticate(deps),
  );

  const userIdOf = (res: Response) => res.locals.auth?.userId ?? null;

  async function listedBranch(branchId: string): Promise<BranchRecord> {
    return serviceability.listedBranch(branchId);
  }

  async function delivery(b: BranchRecord, q: { lat?: number; lng?: number }) {
    if (q.lat === undefined || q.lng === undefined) return null;
    const point = { lat: q.lat, lng: q.lng };
    const [zone, straight] = await Promise.all([
      serviceability.zoneAt(point),
      serviceability.straightLineM(b.id, point),
    ]);
    return serviceability.deliveryInfo(
      b,
      point,
      straight,
      zone?.status === 'ACTIVE' ? zone.id : null,
    );
  }

  async function isFavorite(res: Response, restaurantId: string) {
    const userId = userIdOf(res);
    return userId
      ? (await favoriteRestaurantIds(prisma, userId, [restaurantId])).has(restaurantId)
      : false;
  }

  /** API-REST-001 */
  router.get(
    '/restaurants/:restaurantId',
    handle({ params: schema.restaurantParams }, async ({ params, res }) => {
      const r = await prisma.restaurant.findFirst({
        where: { id: params.restaurantId, onboardingStatus: 'APPROVED', status: 'ACTIVE' },
        include: {
          cuisines: {
            orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
            include: { cuisine: true },
          },
        },
      });
      if (!r) throw new AppError('NOT_FOUND', { message: "We couldn't find that restaurant." });
      sendOk(res, {
        id: r.id,
        name: r.brandName,
        slug: r.slug,
        description: r.description,
        logoUrl: null,
        coverUrl: null,
        pureVeg: r.pureVeg,
        cuisines: r.cuisines.map((c) => ({ slug: c.cuisine.slug, name: c.cuisine.name })),
        rating: ratingView(r.ratingAvgBps, r.ratingCount),
        isFavorite: await isFavorite(res, r.id),
      });
    }),
  );

  /** API-REST-002 / FR-MENUC-010 */
  router.get(
    '/restaurants/:restaurantId/branches',
    handle(
      { params: schema.restaurantParams, query: schema.optionalLocationQuery },
      async ({ params, query, res }) => {
        const ids = await prisma.branch.findMany({
          where: { restaurantId: params.restaurantId, deletedAt: null, status: 'ACTIVE' },
          select: { id: true },
        });
        const loaded = [
          ...(
            await branches.load(
              ids.map((i) => i.id),
              clock.now(),
            )
          ).values(),
        ].filter(isListed);
        const favorite = await isFavorite(res, params.restaurantId);
        const cards = await Promise.all(
          loaded.map(async (b) =>
            branchCard(b, { delivery: await delivery(b, query), isFavorite: favorite }),
          ),
        );
        cards.sort(
          (a, b) =>
            (a.delivery?.distanceKm ?? 0) - (b.delivery?.distanceKm ?? 0) ||
            a.branchName.localeCompare(b.branchName),
        );
        sendOk(res, cards);
      },
    ),
  );

  /** API-REST-003 / FR-MENUC-001 */
  router.get(
    '/branches/:branchId',
    handle(
      { params: schema.branchParams, query: schema.optionalLocationQuery },
      async ({ params, query, res }) => {
        const b = await listedBranch(params.branchId);
        sendOk(
          res,
          branchPage(b, clock.now(), {
            delivery: await delivery(b, query),
            isFavorite: await isFavorite(res, b.restaurantId),
          }),
        );
      },
    ),
  );

  /** API-REST-004 */
  router.get(
    '/branches/:branchId/hours',
    handle({ params: schema.branchParams }, async ({ params, res }) => {
      sendOk(res, hoursView(await listedBranch(params.branchId), clock.now()));
    }),
  );

  /** API-REST-005 / FR-DISC-009 */
  router.get(
    '/branches/:branchId/delivery-info',
    handle(
      { params: schema.branchParams, query: schema.requiredLocationQuery },
      async ({ params, query, res }) => {
        const info = (await delivery(await listedBranch(params.branchId), query))!;
        sendOk(res, { ...deliveryView(info), ...info });
      },
    ),
  );

  async function menuFor(branchId: string) {
    const b = await listedBranch(branchId);
    const raw = await menus.raw(b);
    return {
      b,
      raw,
      state: { acceptingOrders: b.computed.acceptingOrders, opensAt: b.computed.opensAt },
    };
  }

  /** API-MENU-001 (ETag) */
  router.get(
    '/branches/:branchId/menu',
    handle(
      { params: schema.branchParams, query: schema.menuQuery },
      async ({ params, query, req, res }) => {
        const { raw, state } = await menuFor(params.branchId);
        sendWithEtag(
          req,
          res,
          resolveMenu(raw, state, clock.now(), { vegOnly: query.vegOnly ?? false }),
        );
      },
    ),
  );

  /** API-MENU-002 */
  router.get(
    '/branches/:branchId/menu/categories',
    handle({ params: schema.branchParams }, async ({ params, res }) => {
      const { raw } = await menuFor(params.branchId);
      sendOk(
        res,
        raw.categories
          .map((c) => ({ ...c, itemCount: raw.items.filter((i) => i.categoryId === c.id).length }))
          .filter((c) => c.itemCount > 0),
      );
    }),
  );

  /** API-MENU-003 */
  router.get(
    '/branches/:branchId/menu/items',
    handle(
      { params: schema.branchParams, query: schema.menuItemsQuery },
      async ({ params, query, res }) => {
        const { raw, state } = await menuFor(params.branchId);
        const now = clock.now();
        const needle = query.q?.toLowerCase();
        const flag = (f: (typeof schema.MENU_ITEM_FLAGS)[number], i: (typeof raw.items)[number]) =>
          ({
            bestseller: i.isBestseller,
            recommended: i.isRecommended,
            special: i.isTodaysSpecial,
            vegan: i.tags.includes('VEGAN'),
            jain: i.tags.includes('JAIN'),
            'gluten-free': i.tags.includes('GLUTEN_FREE'),
          })[f];
        const cards = raw.items
          .filter((i) => !query.categoryId || i.categoryId === query.categoryId)
          .filter((i) => !query.diet || i.dietaryMarker === query.diet)
          .filter((i) => (query.flags ?? []).every((f) => flag(f, i)))
          .filter(
            (i) => !needle || `${i.name} ${i.description ?? ''}`.toLowerCase().includes(needle),
          )
          .map((i) => toCard(i, state, now))
          .filter((c) => query.available === undefined || c.available === query.available);
        sendOk(res, cards);
      },
    ),
  );

  async function rawItem(branchId: string, itemId: string) {
    const ctx = await menuFor(branchId);
    const item = ctx.raw.items.find((i) => i.id === itemId);
    if (!item) throw new AppError('ITEM_NOT_FOUND');
    return { ...ctx, item };
  }

  async function customerAllergens(res: Response): Promise<string[]> {
    const userId = userIdOf(res);
    if (!userId || res.locals.auth?.app !== 'CUSTOMER') return [];
    return (
      await prisma.customerAllergen.findMany({ where: { userId }, select: { allergen: true } })
    ).map((a) => a.allergen);
  }

  /** API-MENU-004 / FR-MENUC-004, 007 */
  router.get(
    '/branches/:branchId/menu/items/:itemId',
    handle({ params: schema.branchItemParams }, async ({ params, res }) => {
      const { item, state } = await rawItem(params.branchId, params.itemId);
      sendOk(res, itemDetails(item, state, clock.now(), await customerAllergens(res)));
    }),
  );

  /** API-MENU-005 */
  router.get(
    '/branches/:branchId/menu/items/:itemId/customizations',
    handle({ params: schema.branchItemParams }, async ({ params, res }) => {
      const { item, state } = await rawItem(params.branchId, params.itemId);
      const d = itemDetails(item, state, clock.now());
      sendOk(res, {
        itemId: d.id,
        variants: d.variants,
        customizationGroups: d.customizationGroups,
      });
    }),
  );

  /** API-MENU-006 / 007: flag-based until order history exists (Phase 7). */
  for (const [path, pick] of [
    ['popular', (i: { isBestseller: boolean }) => i.isBestseller],
    [
      'specials',
      (i: { isTodaysSpecial: boolean; isRecommended: boolean }) =>
        i.isTodaysSpecial || i.isRecommended,
    ],
  ] as const) {
    router.get(
      `/branches/:branchId/menu/${path}`,
      handle(
        { params: schema.branchParams, query: schema.menuQuery },
        async ({ params, query, res }) => {
          const { raw, state } = await menuFor(params.branchId);
          const now = clock.now();
          sendOk(
            res,
            raw.items
              .filter((i) => pick(i as never) && (!query.vegOnly || isVeg(i)))
              .slice(0, 10)
              .map((i) => toCard(i, state, now)),
          );
        },
      ),
    );
  }

  return router;
}
