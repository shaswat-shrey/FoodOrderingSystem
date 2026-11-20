import type { Response } from 'express';
import { Router } from 'express';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { byIp, rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, optionalAuthenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { SearchService } from './search.service';

export interface SearchRouterDeps extends AuthMiddlewareDeps {
  search: SearchService;
  limiter: RateLimiter;
}

const customerId = (res: Response) =>
  res.locals.auth?.app === 'CUSTOMER' ? res.locals.auth.userId : null;

/** API-SRCH-001…003, mounted at /search (public; history kept for signed-in customers). */
export function searchRouter(deps: SearchRouterDeps): Router {
  const router = Router();
  const { search } = deps;
  router.use(
    requireClientApp(),
    // RL-SEARCH: 60/min per user, or per IP for guests.
    optionalAuthenticate(deps),
    rateLimit(deps.limiter, {
      name: 'rl:search',
      limit: 60,
      windowSeconds: 60,
      key: (req, res) => res.locals.auth?.userId ?? `ip:${byIp(req)}`,
    }),
  );

  router.get(
    '/',
    handle({ query: schema.searchQuery }, async ({ query, res }) => {
      const result = await search.search(query, customerId(res));
      sendOk(
        res,
        { restaurants: result.restaurants, dishes: result.dishes, cuisines: result.cuisines },
        { meta: { pagination: { nextCursor: result.nextCursor } } },
      );
    }),
  );
  router.get(
    '/suggestions',
    handle({ query: schema.suggestionsQuery }, async ({ query, res }) => {
      sendOk(res, await search.suggestions(query.q, query));
    }),
  );
  router.get(
    '/trending',
    handle({ query: schema.latLngQuery }, async ({ query, res }) =>
      sendOk(res, await search.trending(query)),
    ),
  );
  return router;
}

/** API-SRCH-004…006, mounted at /me/search-history. */
export function searchHistoryRouter(deps: SearchRouterDeps): Router {
  const router = Router();
  router.use(requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  router.get(
    '/',
    handle({}, async ({ res }) => sendOk(res, await deps.search.history(res.locals.auth!.userId))),
  );
  router.delete(
    '/:id',
    handle({ params: schema.historyIdParams }, async ({ params, res }) => {
      await deps.search.forget(res.locals.auth!.userId, params.id);
      sendOk(res, null, { message: 'Removed' });
    }),
  );
  router.delete(
    '/',
    handle({}, async ({ res }) => {
      await deps.search.forget(res.locals.auth!.userId);
      sendOk(res, null, { message: 'Search history cleared' });
    }),
  );
  return router;
}
