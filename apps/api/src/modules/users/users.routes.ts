import { Router } from 'express';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { authenticate, type AuthMiddlewareDeps, type AuthService } from '../auth';

export interface UsersRouterDeps extends AuthMiddlewareDeps {
  auth: AuthService;
}

/** API-USER-001 /me and API-USER-003 /me/permissions. More profile endpoints arrive in Phase 5. */
export function usersRouter(deps: UsersRouterDeps): Router {
  const router = Router();
  router.use(requireClientApp());

  router.get(
    '/me',
    authenticate(deps, { allowUnverified: true, allowOnboarding: true }),
    handle({}, async ({ res }) => {
      sendOk(res, await deps.auth.me(res.locals.auth!.userId, res.locals.clientApp!));
    }),
  );

  // Drives route guards and navigation in the web apps (FR-FE-001). The API still
  // enforces every permission itself.
  router.get(
    '/me/permissions',
    authenticate(deps, { allowOnboarding: true }),
    handle({}, async ({ res }) => {
      const auth = res.locals.auth!;
      const perms = await deps.iam.resolve(auth.userId, auth.permissionVersion);
      sendOk(res, {
        app: auth.app,
        scope: auth.scope,
        platformRoles: perms.platformRoles,
        permissions: perms.platform,
        restaurants: perms.restaurants,
      });
    }),
  );

  return router;
}
