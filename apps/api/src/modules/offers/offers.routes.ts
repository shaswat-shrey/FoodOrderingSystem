import type { Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { AppError } from '../../platform/http/errors';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { byIp, rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, optionalAuthenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { ServiceabilityService } from '../catalog';
import type { CartService } from '../checkout';
import type { OffersService } from './offers.service';

export interface OffersRouterDeps extends AuthMiddlewareDeps {
  offers: OffersService;
  cart: CartService;
  serviceability: ServiceabilityService;
  limiter: RateLimiter;
}

const codeBody = z.object({ code: z.string().trim().min(2).max(40) }).strict();
const COUPON_CODES = new Set([
  'COUPON_INVALID',
  'COUPON_EXPIRED',
  'COUPON_NOT_APPLICABLE',
  'COUPON_LIMIT_REACHED',
]);
type CouponCode =
  'COUPON_INVALID' | 'COUPON_EXPIRED' | 'COUPON_NOT_APPLICABLE' | 'COUPON_LIMIT_REACHED';

/** Applies a code to the cart and reports the first coupon problem, without keeping it on failure. */
async function tryCoupon(deps: OffersRouterDeps, userId: string, code: string, keep: boolean) {
  const coupon = await deps.offers.couponByCode(code);
  if (
    !coupon ||
    (coupon.visibility !== 'PUBLIC' && !coupon.users.some((u) => u.userId === userId))
  ) {
    throw new AppError('COUPON_INVALID', { message: `${code.toUpperCase()} isn't a valid code.` });
  }
  const before = await deps.cart.evaluate(userId);
  if (!before || before.priced.length === 0)
    throw new AppError('CART_EMPTY', { message: 'Add something to your cart first.' });
  const previous = before.cart.couponId;
  await deps.cart.setCoupon(userId, coupon.id);
  const view = await deps.cart.view(userId);
  const problem = view.blocking.find((i) => COUPON_CODES.has(i.code));
  // Validation only, or a failed apply: put back whatever coupon was there before.
  if (problem || !keep) await deps.cart.setCoupon(userId, previous);
  if (problem) throw new AppError(problem.code as CouponCode, { message: problem.message });
  const discount = view.preview?.discounts.find((d) => d.source === 'COUPON');
  return {
    view,
    coupon: {
      code: coupon.code,
      discountAmount: discount?.amount ?? 0,
      freeDelivery: discount?.freeDelivery ?? false,
    },
  };
}

/** API-CART-009/010 (mounted at /cart/coupon) and API-COUP-001…003 (mounted at /coupons). */
export function cartCouponRouter(deps: OffersRouterDeps): Router {
  const router = Router();
  router.use(requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  router.use(
    rateLimit(deps.limiter, {
      name: 'rl:coupon:user',
      limit: 30,
      windowSeconds: 60,
      key: (_req, res) => res.locals.auth!.userId,
    }),
  );
  router.post(
    '/',
    handle({ body: codeBody }, async ({ body, res }) => {
      const { view, coupon } = await tryCoupon(deps, res.locals.auth!.userId, body.code, true);
      sendOk(res, { cart: view, coupon }, { message: `${coupon.code} applied` });
    }),
  );
  router.delete(
    '/',
    handle({}, async ({ res }) => {
      await deps.cart.setCoupon(res.locals.auth!.userId, null);
      sendOk(res, await deps.cart.view(res.locals.auth!.userId), { message: 'Coupon removed' });
    }),
  );
  return router;
}

export function couponsRouter(deps: OffersRouterDeps): Router {
  const router = Router();
  router.use(
    requireClientApp(),
    optionalAuthenticate(deps),
    rateLimit(deps.limiter, { name: 'rl:read:ip', limit: 120, windowSeconds: 60, key: byIp }),
  );
  const customerId = (res: Response) =>
    res.locals.auth?.app === 'CUSTOMER' ? res.locals.auth.userId : null;

  router.get(
    '/',
    handle({ query: z.object({ branchId: schema.idSchema }).strict() }, async ({ query, res }) => {
      const userId = customerId(res);
      const branch = await deps.serviceability.listedBranch(query.branchId);
      const cart = userId ? await deps.cart.evaluate(userId) : null;
      const subtotal = cart?.branch?.id === branch.id ? (cart.view.preview?.itemsSubtotal ?? 0) : 0;
      sendOk(
        res,
        await deps.offers.list({ userId, branch, itemsSubtotal: subtotal, paymentMethod: null }),
      );
    }),
  );

  router.post(
    '/validate',
    handle({ body: codeBody }, async ({ body, res }) => {
      const userId = customerId(res);
      if (!userId) throw new AppError('AUTH_TOKEN_MISSING');
      try {
        const { coupon } = await tryCoupon(deps, userId, body.code, false);
        sendOk(res, { valid: true, ...coupon, reason: null });
      } catch (error) {
        if (
          error instanceof AppError &&
          (COUPON_CODES.has(error.code) || error.code === 'CART_EMPTY')
        ) {
          sendOk(res, {
            valid: false,
            code: body.code.toUpperCase(),
            discountAmount: 0,
            reasonCode: error.code,
            reason: error.message,
          });
          return;
        }
        throw error;
      }
    }),
  );

  router.get(
    '/:code',
    handle(
      { params: z.object({ code: z.string().trim().min(2).max(40) }).strict() },
      async ({ params, res }) => {
        sendOk(res, await deps.offers.terms(params.code, customerId(res)));
      },
    ),
  );
  return router;
}
