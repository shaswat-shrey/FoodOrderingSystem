import type { Response } from 'express';
import { Router } from 'express';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { AddressService } from '../customers';
import type { LatLng } from '../geo';
import type { CartService } from './cart.service';

export interface CartRouterDeps extends AuthMiddlewareDeps {
  cart: CartService;
  addresses: AddressService;
  limiter: RateLimiter;
}

/** API-CART-001…008, 011, 012 (coupon routes live with the offers module). Mounted at /cart. */
export function cartRouter(deps: CartRouterDeps): Router {
  const router = Router();
  const { cart } = deps;
  router.use(requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  router.use(
    rateLimit(deps.limiter, {
      name: 'rl:write:user',
      limit: 60,
      windowSeconds: 60,
      key: (req, res) => (req.method === 'GET' ? null : res.locals.auth!.userId),
    }),
  );
  const userId = (res: Response) => res.locals.auth!.userId;

  /** Delivery location for pricing: a saved address or coordinates (FR-CART-008). */
  async function pointFor(
    res: Response,
    q: { addressId?: string; lat?: number; lng?: number },
  ): Promise<LatLng | null> {
    if (q.addressId) return (await deps.addresses.get(userId(res), q.addressId)).location;
    return q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;
  }
  const latest = async (res: Response, status = 200, message = 'OK') =>
    sendOk(res, await cart.view(userId(res)), { status, message });

  router.get(
    '/',
    handle({ query: schema.cartPreviewQuery }, async ({ query, res }) => {
      sendOk(
        res,
        await cart.view(userId(res), {
          point: await pointFor(res, query),
          tipAmount: query.tip ?? 0,
        }),
      );
    }),
  );
  router.get(
    '/price-preview',
    handle({ query: schema.cartPreviewQuery }, async ({ query, res }) => {
      const v = await cart.view(userId(res), {
        point: await pointFor(res, query),
        tipAmount: query.tip ?? 0,
      });
      sendOk(res, {
        preview: v.preview,
        delivery: v.delivery,
        blocking: v.blocking,
        warnings: v.warnings,
      });
    }),
  );
  router.post(
    '/validate',
    handle({ query: schema.cartPreviewQuery }, async ({ query, res }) => {
      const v = await cart.view(userId(res), {
        point: await pointFor(res, query),
        tipAmount: query.tip ?? 0,
      });
      sendOk(res, { valid: v.blocking.length === 0, blocking: v.blocking, warnings: v.warnings });
    }),
  );
  router.post(
    '/items',
    handle({ body: schema.addCartItemBody }, async ({ body, res }) => {
      await cart.addItem(userId(res), body);
      await latest(res, 201, 'Added to cart');
    }),
  );
  router.patch(
    '/items/:lineId',
    handle(
      { params: schema.cartLineParams, body: schema.updateCartQuantityBody },
      async ({ params, body, res }) => {
        await cart.updateQuantity(userId(res), params.lineId, body.quantity, body.version);
        await latest(res);
      },
    ),
  );
  router.put(
    '/items/:lineId',
    handle(
      { params: schema.cartLineParams, body: schema.replaceCartLineBody },
      async ({ params, body, res }) => {
        await cart.replaceLine(userId(res), params.lineId, body);
        await latest(res);
      },
    ),
  );
  router.delete(
    '/items/:lineId',
    handle({ params: schema.cartLineParams }, async ({ params, res }) => {
      await cart.removeLine(userId(res), params.lineId);
      await latest(res);
    }),
  );
  router.delete(
    '/',
    handle({}, async ({ res }) => {
      await cart.clear(userId(res));
      await latest(res, 200, 'Cart cleared');
    }),
  );
  router.patch(
    '/',
    handle({ body: schema.patchCartBody }, async ({ body, res }) => {
      await cart.patch(userId(res), body);
      await latest(res);
    }),
  );
  router.post(
    '/merge',
    handle({ body: schema.mergeCartBody }, async ({ body, res }) => {
      const { rejected } = await cart.merge(userId(res), body);
      sendOk(res, { cart: await cart.view(userId(res)), rejected });
    }),
  );
  return router;
}
