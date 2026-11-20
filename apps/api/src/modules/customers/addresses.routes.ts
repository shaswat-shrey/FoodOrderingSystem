import { Router } from 'express';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { AddressService } from './address.service';

export interface AddressesRouterDeps extends AuthMiddlewareDeps {
  addresses: AddressService;
  limiter: RateLimiter;
}

/** API-ADDR-001…006, mounted at /me/addresses (customers with a verified phone). */
export function addressesRouter(deps: AddressesRouterDeps): Router {
  const router = Router();
  const { addresses } = deps;
  router.use(requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  const writeLimit = rateLimit(deps.limiter, {
    name: 'rl:write:user',
    limit: 60,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth?.userId ?? null,
  });
  const userId = (res: { locals: { auth?: { userId: string } } }) => res.locals.auth!.userId;

  router.get(
    '/',
    handle({ query: schema.listAddressesQuery }, async ({ query, res }) => {
      sendOk(res, await addresses.list(userId(res), query.branchId));
    }),
  );
  router.post(
    '/',
    writeLimit,
    handle({ body: schema.createAddressBody }, async ({ body, res }) => {
      sendOk(res, await addresses.create(userId(res), body), {
        status: 201,
        message: 'Address saved',
      });
    }),
  );
  router.get(
    '/:id',
    handle({ params: schema.addressIdParams }, async ({ params, res }) => {
      sendOk(res, await addresses.get(userId(res), params.id));
    }),
  );
  router.patch(
    '/:id',
    writeLimit,
    handle(
      { params: schema.addressIdParams, body: schema.updateAddressBody },
      async ({ params, body, res }) => {
        sendOk(res, await addresses.update(userId(res), params.id, body), {
          message: 'Address updated',
        });
      },
    ),
  );
  router.delete(
    '/:id',
    writeLimit,
    handle({ params: schema.addressIdParams }, async ({ params, res }) => {
      await addresses.remove(userId(res), params.id);
      sendOk(res, null, { message: 'Address deleted' });
    }),
  );
  router.post(
    '/:id/default',
    writeLimit,
    handle({ params: schema.addressIdParams }, async ({ params, res }) => {
      sendOk(res, await addresses.setDefault(userId(res), params.id), {
        message: 'Default address set',
      });
    }),
  );
  return router;
}
