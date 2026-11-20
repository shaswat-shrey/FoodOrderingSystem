import type { Response } from 'express';
import { Router } from 'express';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { FavoritesService } from './favorites.service';

export interface FavoritesRouterDeps extends AuthMiddlewareDeps {
  favorites: FavoritesService;
  limiter: RateLimiter;
}

/** API-FAV-001…006, mounted at /me/favorites. */
export function favoritesRouter(deps: FavoritesRouterDeps): Router {
  const router = Router();
  const { favorites } = deps;
  router.use(requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  const writeLimit = rateLimit(deps.limiter, {
    name: 'rl:write:user',
    limit: 60,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth?.userId ?? null,
  });
  const userId = (res: Response) => res.locals.auth!.userId;
  const point = (q: { lat?: number; lng?: number }) =>
    q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;

  router.get(
    '/restaurants',
    handle({ query: schema.optionalLocationQuery }, async ({ query, res }) => {
      sendOk(res, await favorites.listRestaurants(userId(res), point(query)));
    }),
  );
  router.put(
    '/restaurants/:restaurantId',
    writeLimit,
    handle({ params: schema.favoriteRestaurantParams }, async ({ params, res }) => {
      await favorites.addRestaurant(userId(res), params.restaurantId);
      sendOk(res, null, { message: 'Added to favourites' });
    }),
  );
  router.delete(
    '/restaurants/:restaurantId',
    writeLimit,
    handle({ params: schema.favoriteRestaurantParams }, async ({ params, res }) => {
      await favorites.removeRestaurant(userId(res), params.restaurantId);
      sendOk(res, null, { message: 'Removed from favourites' });
    }),
  );
  router.get(
    '/items',
    handle({ query: schema.optionalLocationQuery }, async ({ query, res }) => {
      sendOk(res, await favorites.listItems(userId(res), point(query)));
    }),
  );
  router.put(
    '/items/:itemId',
    writeLimit,
    handle({ params: schema.favoriteItemParams }, async ({ params, res }) => {
      await favorites.addItem(userId(res), params.itemId);
      sendOk(res, null, { message: 'Added to favourites' });
    }),
  );
  router.delete(
    '/items/:itemId',
    writeLimit,
    handle({ params: schema.favoriteItemParams }, async ({ params, res }) => {
      await favorites.removeItem(userId(res), params.itemId);
      sendOk(res, null, { message: 'Removed from favourites' });
    }),
  );
  return router;
}
