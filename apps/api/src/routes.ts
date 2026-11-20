import type { Router } from 'express';
import type { Container } from './container';
import { authRouter } from './modules/auth';
import { catalogRouter, geoRouter } from './modules/catalog';
import { cartRouter } from './modules/checkout';
import { addressesRouter, favoritesRouter } from './modules/customers';
import { discoveryRouter } from './modules/discovery';
import { searchHistoryRouter, searchRouter } from './modules/search';
import { usersRouter } from './modules/users';

/** Every /api/v1 router, mounted the same way by the server and the integration tests. */
export function mountRoutes(api: Router, container: Container): void {
  api.use(
    '/auth',
    authRouter({
      ...container,
      cookieSecure: container.env.COOKIE_SECURE,
      hmacSecret: container.env.AUTH_HMAC_SECRET,
    }),
  );
  // Before usersRouter so /me/addresses is not shadowed.
  api.use('/me/addresses', addressesRouter(container));
  api.use('/me/favorites', favoritesRouter(container));
  api.use('/me/search-history', searchHistoryRouter(container));
  api.use(usersRouter(container));
  api.use('/geo', geoRouter(container));
  api.use('/discovery', discoveryRouter(container));
  api.use('/search', searchRouter(container));
  api.use('/cart', cartRouter(container));
  api.use(catalogRouter(container));
}
