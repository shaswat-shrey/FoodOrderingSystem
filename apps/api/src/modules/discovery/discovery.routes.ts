import type { Response } from 'express';
import { Router } from 'express';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { AppError } from '../../platform/http/errors';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { byIp, rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { optionalAuthenticate, type AuthMiddlewareDeps } from '../auth';
import type { DiscoveryService } from './discovery.service';

export interface DiscoveryRouterDeps extends AuthMiddlewareDeps {
  discovery: DiscoveryService;
  limiter: RateLimiter;
}

/** API-DISC-001…006, 008…011 (mounted at /discovery; public, personalised when signed in). */
export function discoveryRouter(deps: DiscoveryRouterDeps): Router {
  const router = Router();
  const { discovery } = deps;
  router.use(
    requireClientApp(),
    rateLimit(deps.limiter, { name: 'rl:read:ip', limit: 120, windowSeconds: 60, key: byIp }),
    optionalAuthenticate(deps),
  );
  /** Only customer-app sessions personalise discovery. */
  const customerId = (res: Response) =>
    res.locals.auth?.app === 'CUSTOMER' ? res.locals.auth.userId : null;
  const page = (res: Response, data: unknown, nextCursor: string | null) =>
    sendOk(res, data, { meta: { pagination: { nextCursor } } });

  router.get(
    '/restaurants',
    handle({ query: schema.discoveryListQuery }, async ({ query, res }) => {
      const result = await discovery.list(query, customerId(res));
      page(res, result.results, result.nextCursor);
    }),
  );

  router.get(
    '/home',
    handle({ query: schema.discoveryLocationQuery }, async ({ query, res }) => {
      sendOk(res, await discovery.home(query, query.vegOnly ?? false, customerId(res)));
    }),
  );

  router.get(
    '/collections/:slug',
    handle(
      { params: schema.slugParams, query: schema.collectionQuery },
      async ({ params, query, res }) => {
        const c = await discovery.collection(
          params.slug,
          query,
          {
            vegOnly: query.vegOnly ?? false,
            limit: query.limit,
            ...(query.cursor ? { cursor: query.cursor } : {}),
          },
          customerId(res),
        );
        page(res, { slug: c.slug, title: c.title, restaurants: c.results }, c.nextCursor);
      },
    ),
  );

  router.get(
    '/cuisines',
    handle({ query: schema.discoveryLocationQuery }, async ({ query, res }) => {
      sendOk(res, await discovery.cuisines(query, query.vegOnly ?? false));
    }),
  );

  router.get(
    '/cuisines/:slug/restaurants',
    handle(
      { params: schema.slugParams, query: schema.discoveryListQuery },
      async ({ params, query, res }) => {
        if (query.cuisines)
          throw new AppError('VALIDATION_ERROR', { message: 'The cuisine comes from the path.' });
        const result = await discovery.list({ ...query, cuisines: [params.slug] }, customerId(res));
        page(res, result.results, result.nextCursor);
      },
    ),
  );

  router.get(
    '/categories/:slug/items',
    handle(
      { params: schema.slugParams, query: schema.discoveryLocationQuery },
      async ({ params, query, res }) => {
        const words = params.slug.split('-');
        const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));
        sendOk(
          res,
          await discovery.items(
            query,
            (item, category) => matches(item.name) || matches(category),
            query.vegOnly ?? false,
            30,
          ),
        );
      },
    ),
  );

  router.get(
    '/banners',
    handle({ query: schema.latLngQuery }, async ({ query, res }) =>
      sendOk(res, await discovery.banners(query)),
    ),
  );

  router.get(
    '/order-again',
    // Signed-in customers only: decided before the query is validated.
    (_req, res, next) => next(customerId(res) ? undefined : new AppError('AUTH_TOKEN_MISSING')),
    handle({ query: schema.latLngQuery }, async ({ query, res }) => {
      sendOk(res, await discovery.orderAgain(query, customerId(res)!));
    }),
  );

  router.get(
    '/facets',
    handle({ query: schema.latLngQuery }, async ({ query, res }) =>
      sendOk(res, await discovery.facets(query)),
    ),
  );

  router.get(
    '/items/specials',
    handle({ query: schema.discoveryLocationQuery }, async ({ query, res }) => {
      sendOk(
        res,
        await discovery.items(
          query,
          (i) => i.isTodaysSpecial || i.isBestseller,
          query.vegOnly ?? false,
          15,
        ),
      );
    }),
  );

  return router;
}
