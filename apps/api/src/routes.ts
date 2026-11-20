import type { Router } from 'express';
import type { Container } from './container';
import { authRouter } from './modules/auth';
import { catalogRouter, geoRouter } from './modules/catalog';
import { cartRouter, checkoutRouter, paymentMethodsRouter } from './modules/checkout';
import { addressesRouter, favoritesRouter } from './modules/customers';
import { discoveryRouter } from './modules/discovery';
import { walletRouter } from './modules/ledger';
import { cartCouponRouter, couponsRouter } from './modules/offers';
import { ordersRouter } from './modules/orders';
import { mountPaymentWebhooks, paymentsRouter } from './modules/payments';
import type { Express } from 'express';
import { searchHistoryRouter, searchRouter } from './modules/search';
import { supportRouter } from './modules/support';
import { notificationsRouter } from './modules/notifications';
import { branchRouter, menuRouter, merchantRouter } from './modules/merchant';
import { fileUploadRouter, filesRouter, localMediaRouter } from './modules/files';
import { usersRouter } from './modules/users';

/**
 * Every /api/v1 router, mounted the same way by the server and the integration tests.
 * Routers mounted without a path prefix (users, payments, catalog) must scope their
 * middleware to their own paths: an unscoped router.use() would run for every request
 * that reaches a later router (the catalog's public pages were once caught by
 * the payments router's authentication this way).
 */
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
  api.use('/me/wallet', walletRouter(container));
  api.use(usersRouter(container));
  api.use('/geo', geoRouter(container));
  api.use('/discovery', discoveryRouter(container));
  api.use('/search', searchRouter(container));
  api.use('/cart/coupon', cartCouponRouter(container));
  api.use('/cart', cartRouter(container));
  api.use('/coupons', couponsRouter(container));
  api.use(ordersRouter(container));
  api.use(supportRouter(container));
  api.use(notificationsRouter(container));
  api.use(filesRouter(container));
  api.use(merchantRouter(container));
  api.use(branchRouter(container));
  api.use(menuRouter(container));
  api.use('/checkout/sessions', checkoutRouter(container));
  api.use('/payments/methods', paymentMethodsRouter(container));
  api.use(paymentsRouter(container));
  api.use(catalogRouter(container));
}

/** Raw-body routes (provider webhooks), mounted before JSON parsing. */
export function mountRawRoutes(app: Express, container: Container): void {
  mountPaymentWebhooks(app, container);
  // Multipart uploads stream through busboy, so they skip the JSON-only guard.
  app.use('/api/v1', fileUploadRouter(container), localMediaRouter(container));
}
