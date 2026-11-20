import type { Router } from 'express';
import type { Container } from './container';
import { authRouter } from './modules/auth';
import { geoRouter } from './modules/catalog';
import { addressesRouter } from './modules/customers';
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
  api.use(usersRouter(container));
  api.use('/geo', geoRouter(container));
}
