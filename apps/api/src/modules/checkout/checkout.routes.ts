import type { Response } from 'express';
import { Router } from 'express';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { ServiceabilityService } from '../catalog';
import type { CheckoutService } from './checkout.service';

export interface CheckoutRouterDeps extends AuthMiddlewareDeps {
  checkout: CheckoutService;
  serviceability: ServiceabilityService;
  limiter: RateLimiter;
}

/** API-CHK-001…003, mounted at /checkout/sessions. Confirmation (API-CHK-004) arrives with orders. */
export function checkoutRouter(deps: CheckoutRouterDeps): Router {
  const router = Router();
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

  router.post(
    '/',
    handle({ body: schema.createCheckoutBody }, async ({ body, res }) => {
      sendOk(res, await deps.checkout.create(userId(res), body), {
        status: 201,
        message: 'Checkout ready',
      });
    }),
  );
  router.get(
    '/:sessionId',
    handle({ params: schema.checkoutSessionParams }, async ({ params, res }) => {
      sendOk(res, await deps.checkout.get(userId(res), params.sessionId));
    }),
  );
  router.patch(
    '/:sessionId',
    handle(
      { params: schema.checkoutSessionParams, body: schema.updateCheckoutBody },
      async ({ params, body, res }) => {
        sendOk(res, await deps.checkout.update(userId(res), params.sessionId, body));
      },
    ),
  );
  return router;
}

/** API-PAY-001, mounted at /payments/methods. */
export function paymentMethodsRouter(deps: CheckoutRouterDeps): Router {
  const router = Router();
  const userId = (res: Response) => res.locals.auth!.userId;
  router.use(requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  router.get(
    '/',
    handle({ query: schema.paymentMethodsQuery }, async ({ query, res }) => {
      const branch = await deps.serviceability.listedBranch(query.branchId);
      sendOk(res, await deps.checkout.methods(userId(res), branch, query.amount));
    }),
  );
  return router;
}
