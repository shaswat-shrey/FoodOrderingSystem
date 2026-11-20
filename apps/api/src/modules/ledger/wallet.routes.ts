import { Router } from 'express';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { authenticate, requireApp, type AuthMiddlewareDeps } from '../auth';
import type { WalletService } from './wallet.service';

/** API-WAL-001/002, mounted at /me/wallet. */
export function walletRouter(deps: AuthMiddlewareDeps & { wallet: WalletService }): Router {
  const router = Router();
  router.use(requireClientApp(), authenticate(deps), requireApp('CUSTOMER'));
  router.get(
    '/',
    handle({}, async ({ res }) => sendOk(res, await deps.wallet.summary(res.locals.auth!.userId))),
  );
  router.get(
    '/transactions',
    handle({ query: schema.cursorPaginationSchema }, async ({ query, res }) => {
      const page = await deps.wallet.transactions(res.locals.auth!.userId, {
        limit: Math.min(query.limit, 50),
        cursor: query.cursor,
      });
      sendOk(res, page.items, { meta: { pagination: { nextCursor: page.nextCursor } } });
    }),
  );
  return router;
}
