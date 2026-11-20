import { Router } from 'express';
import type { ClientApp } from '@fos/shared';
import * as schema from '@fos/validation';
import { sendOk } from '../../platform/http/envelope';
import { handle } from '../../platform/http/handler';
import { requireClientApp } from '../../platform/http/middleware/client-app';
import { rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import {
  authenticate,
  requestMeta,
  requireApp,
  type AuthMiddlewareDeps,
  type AuthService,
} from '../auth';
import type { ProfileService } from '../customers';

export interface UsersRouterDeps extends AuthMiddlewareDeps {
  auth: AuthService;
  profiles: ProfileService;
  limiter: RateLimiter;
}

/** API-USER-001…003, 006…011, 013, 014 (avatar and data export arrive later; see PROJECT_STATUS). */
export function usersRouter(deps: UsersRouterDeps): Router {
  const router = Router();
  const { auth, profiles } = deps;
  router.use(requireClientApp());
  const anyUser = authenticate(deps, { allowUnverified: true, allowOnboarding: true });
  const writeLimit = rateLimit(deps.limiter, {
    name: 'rl:write:user',
    limit: 60,
    windowSeconds: 60,
    key: (_req, res) => res.locals.auth?.userId ?? null,
  });

  const me = async (userId: string, app: ClientApp) => ({
    ...(await auth.me(userId, app)),
    ...(await profiles.profileExtras(userId)),
  });

  router.get(
    '/me',
    anyUser,
    handle({}, async ({ res }) => {
      sendOk(res, await me(res.locals.auth!.userId, res.locals.clientApp!));
    }),
  );

  router.patch(
    '/me',
    anyUser,
    writeLimit,
    handle({ body: schema.updateProfileBody }, async ({ body, res }) => {
      await profiles.updateProfile(res.locals.auth!.userId, body);
      sendOk(res, await me(res.locals.auth!.userId, res.locals.clientApp!), {
        message: 'Profile updated',
      });
    }),
  );

  // Drives route guards and navigation in the web apps (FR-FE-001). The API still
  // enforces every permission itself.
  router.get(
    '/me/permissions',
    authenticate(deps, { allowOnboarding: true }),
    handle({}, async ({ res }) => {
      const a = res.locals.auth!;
      const perms = await deps.iam.resolve(a.userId, a.permissionVersion);
      sendOk(res, {
        app: a.app,
        scope: a.scope,
        platformRoles: perms.platformRoles,
        permissions: perms.platform,
        restaurants: perms.restaurants,
      });
    }),
  );

  router.get(
    '/me/preferences',
    anyUser,
    requireApp('CUSTOMER'),
    handle({}, async ({ res }) => sendOk(res, await profiles.preferences(res.locals.auth!.userId))),
  );

  router.patch(
    '/me/preferences',
    anyUser,
    requireApp('CUSTOMER'),
    writeLimit,
    handle({ body: schema.updatePreferencesBody }, async ({ body, res }) => {
      sendOk(res, await profiles.updatePreferences(res.locals.auth!.userId, body), {
        message: 'Preferences saved',
      });
    }),
  );

  router.get(
    '/me/account-status',
    anyUser,
    handle({}, async ({ res }) =>
      sendOk(res, await profiles.accountStatus(res.locals.auth!.userId)),
    ),
  );

  router.post(
    '/me/email/change',
    anyUser,
    writeLimit,
    handle({ body: schema.changeEmailBody }, async ({ body, req, res }) => {
      const a = res.locals.auth!;
      await auth.changeEmail(a.userId, a.sessionId, body.email, requestMeta(req, res));
      sendOk(res, null, { message: 'Email updated. Check your inbox to verify it.' });
    }),
  );

  router.post(
    '/me/phone/change',
    anyUser,
    rateLimit(deps.limiter, {
      name: 'auth:phone-change:user',
      limit: 5,
      windowSeconds: 3600,
      key: (_req, res) => res.locals.auth?.userId ?? null,
    }),
    handle({ body: schema.changePhoneBody }, async ({ body, res }) => {
      const a = res.locals.auth!;
      await auth.requestPhoneChange(a.userId, a.sessionId, body.phone);
      sendOk(res, null, { message: 'We sent a code to your new number.' });
    }),
  );

  router.post(
    '/me/phone/change/confirm',
    anyUser,
    writeLimit,
    handle({ body: schema.confirmPhoneChangeBody }, async ({ body, req, res }) => {
      const a = res.locals.auth!;
      await auth.confirmPhoneChange(a.userId, a.sessionId, body, requestMeta(req, res));
      sendOk(res, await me(a.userId, res.locals.clientApp!), {
        message: 'Phone number updated. Other devices were signed out.',
      });
    }),
  );

  router.get(
    '/me/consents',
    anyUser,
    handle({}, async ({ res }) =>
      sendOk(res, await profiles.consents(res.locals.auth!.userId, res.locals.clientApp!)),
    ),
  );

  router.post(
    '/me/consents',
    anyUser,
    writeLimit,
    handle({ body: schema.acceptConsentBody }, async ({ body, req, res }) => {
      const m = requestMeta(req, res);
      sendOk(
        res,
        await profiles.acceptConsent(
          res.locals.auth!.userId,
          res.locals.clientApp!,
          body.legalDocumentId,
          {
            ...(m.ip ? { ip: m.ip } : {}),
            ...(m.userAgent ? { userAgent: m.userAgent } : {}),
          },
        ),
      );
    }),
  );

  return router;
}
