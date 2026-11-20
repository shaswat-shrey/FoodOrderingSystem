import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ClientApp } from '@fos/shared';
import type { Clock } from '../../platform/clock';
import { hmac, sha256 } from '../../platform/crypto';
import { sendOk } from '../../platform/http/envelope';
import { AppError } from '../../platform/http/errors';
import { handle } from '../../platform/http/handler';
import { requireClientApp, requireTrustedOrigin } from '../../platform/http/middleware/client-app';
import { byIp, rateLimit } from '../../platform/http/middleware/rate-limit';
import type { RateLimiter } from '../../platform/rate-limit';
import type { PrismaClient } from '@fos/db';
import { authenticate, type AuthMiddlewareDeps } from './auth.middleware';
import * as schema from './auth.schemas';
import type { AuthService, RequestMeta, SignInResult } from './auth.service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './cookies';
import { AUTH_POLICY } from './policy';
import { TokenError } from './tokens';

export interface AuthRouterDeps extends AuthMiddlewareDeps {
  auth: AuthService;
  limiter: RateLimiter;
  prisma: PrismaClient;
  clock: Clock;
  appOrigins: Record<ClientApp, string>;
  cookieSecure: boolean;
  hmacSecret: string;
}

function meta(req: Request, res: Response): RequestMeta {
  return {
    app: res.locals.clientApp!,
    ip: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: res.locals.requestId,
  };
}

/** Authentication & session endpoints (SRS §5, API-AUTH-*). Mounted at /api/v1/auth. */
export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const { auth, limiter } = deps;

  const sendSignIn = (res: Response, result: SignInResult, status = 200) => {
    if (result.kind === 'mfa') {
      sendOk(
        res,
        {
          mfaRequired: true,
          mfaToken: result.mfaToken,
          mfaTokenExpiresAt: result.mfaTokenExpiresAt,
        },
        { message: 'Enter the code we emailed you' },
      );
      return;
    }
    setRefreshCookie(
      res,
      res.locals.clientApp!,
      result.refreshToken,
      result.refreshTokenExpiresAt,
      deps.cookieSecure,
      deps.clock.now(),
    );
    sendOk(
      res,
      {
        accessToken: result.accessToken,
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        user: result.user,
        session: { id: result.sessionId },
      },
      { status, message: 'Signed in' },
    );
  };

  const identifierKey = (req: Request) => {
    const identifier =
      typeof req.body?.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : '';
    return identifier
      ? Buffer.from(hmac(deps.hmacSecret, 'rl-identifier', identifier)).toString('hex')
      : null;
  };

  // RL-AUTH (SRS §14.1): 10/min per IP on credential endpoints.
  const authLimit = rateLimit(limiter, {
    name: 'auth:ip',
    limit: 10,
    windowSeconds: 60,
    key: byIp,
  });
  const signedIn = (options: { allowUnverified?: boolean; allowOnboarding?: boolean } = {}) =>
    authenticate(deps, { allowOnboarding: true, ...options });
  const optionalAuth: RequestHandler = (req, res, next) =>
    req.header('authorization') ? signedIn({ allowUnverified: true })(req, res, next) : next();

  router.use(requireClientApp());

  router.post(
    '/register',
    authLimit,
    rateLimit(limiter, {
      name: 'auth:register:ip',
      limit: AUTH_POLICY.registrationsPerIpPerHour,
      windowSeconds: 3600,
      key: byIp,
    }),
    handle({ body: schema.registerBody }, async ({ body, req, res }) => {
      sendSignIn(res, await auth.register(body, meta(req, res)), 201);
    }),
  );

  router.post(
    '/otp/request',
    rateLimit(limiter, {
      name: 'auth:otp:ip',
      limit: AUTH_POLICY.otp.maxPerIpPerHour,
      windowSeconds: 3600,
      key: byIp,
    }),
    optionalAuth,
    handle({ body: schema.otpRequestBody }, async ({ body, req, res }) => {
      await auth.requestOtp(body, meta(req, res), res.locals.auth?.userId);
      sendOk(
        res,
        {
          resendAfterSeconds: AUTH_POLICY.otp.resendCooldownSeconds,
          expiresInSeconds: AUTH_POLICY.otp.ttlSeconds,
        },
        { message: 'If the number can receive codes, we have sent one' },
      );
    }),
  );

  router.post(
    '/otp/login',
    authLimit,
    handle({ body: schema.otpLoginBody }, async ({ body, req, res }) => {
      sendSignIn(res, await auth.loginWithOtp(body, meta(req, res)));
    }),
  );

  router.post(
    '/login',
    authLimit,
    rateLimit(limiter, {
      name: 'auth:login:identifier',
      limit: 5,
      windowSeconds: 60,
      key: identifierKey,
    }),
    handle({ body: schema.loginBody }, async ({ body, req, res }) => {
      sendSignIn(res, await auth.loginWithPassword(body.identifier, body.password, meta(req, res)));
    }),
  );

  router.post(
    '/mfa/challenge',
    authLimit,
    handle({ body: schema.mfaChallengeBody }, async ({ body, req, res }) => {
      sendSignIn(res, await auth.completeMfa(body.mfaToken, body.code, meta(req, res)));
    }),
  );

  // Cookie-authenticated: SameSite=Strict + trusted Origin + X-Client-App (BR-AUTH-019).
  router.post(
    '/refresh',
    requireTrustedOrigin(deps.appOrigins),
    rateLimit(limiter, { name: 'auth:refresh:ip', limit: 60, windowSeconds: 60, key: byIp }),
    handle({}, async ({ req, res }) => {
      const app = res.locals.clientApp!;
      const token = readRefreshCookie(req, app);
      if (!token) throw new AppError('AUTH_REFRESH_INVALID');
      try {
        const result = await auth.refresh(token, meta(req, res));
        setRefreshCookie(
          res,
          app,
          result.refreshToken,
          result.refreshTokenExpiresAt,
          deps.cookieSecure,
          deps.clock.now(),
        );
        sendOk(res, {
          accessToken: result.accessToken,
          accessTokenExpiresAt: result.accessTokenExpiresAt,
          user: result.user,
          session: { id: result.sessionId },
        });
      } catch (error) {
        // A race keeps the cookie (the browser already holds the newer one); every other failure clears it.
        if (!(error instanceof AppError && error.code === 'AUTH_REFRESH_RACE'))
          clearRefreshCookie(res, app, deps.cookieSecure);
        throw error;
      }
    }),
  );

  router.post(
    '/logout',
    requireTrustedOrigin(deps.appOrigins),
    handle({}, async ({ req, res }) => {
      const app = res.locals.clientApp!;
      let sessionId: string | undefined;
      const header = req.header('authorization');
      if (header?.startsWith('Bearer ')) {
        sessionId = await deps.tokens
          .verify(header.slice(7).trim(), app)
          .then((c) => c.sessionId)
          .catch((error: unknown) => {
            if (error instanceof TokenError) return undefined;
            throw error;
          });
      }
      const cookie = readRefreshCookie(req, app);
      if (!sessionId && cookie) {
        const token = await deps.prisma.refreshToken.findUnique({
          where: { tokenHash: sha256(cookie) },
          select: { sessionId: true },
        });
        sessionId = token?.sessionId;
      }
      if (sessionId) await auth.logout(sessionId);
      clearRefreshCookie(res, app, deps.cookieSecure);
      sendOk(res, null, { message: 'Signed out' });
    }),
  );

  router.post(
    '/logout-all',
    signedIn({ allowUnverified: true }),
    handle({ body: schema.logoutAllBody }, async ({ body, req, res }) => {
      const { userId, sessionId } = res.locals.auth!;
      const revoked = await auth.logoutAll(userId, sessionId, body.keepCurrent, meta(req, res));
      if (!body.keepCurrent) clearRefreshCookie(res, res.locals.clientApp!, deps.cookieSecure);
      sendOk(res, { revokedSessions: revoked }, { message: 'Signed out of all devices' });
    }),
  );

  router.get(
    '/sessions',
    signedIn({ allowUnverified: true }),
    handle({}, async ({ res }) => {
      const { userId, sessionId } = res.locals.auth!;
      sendOk(res, await auth.listSessions(userId, sessionId));
    }),
  );

  router.delete(
    '/sessions/:sessionId',
    signedIn({ allowUnverified: true }),
    handle({ params: schema.sessionIdParams }, async ({ params, req, res }) => {
      const { userId, sessionId } = res.locals.auth!;
      await auth.revokeOwnSession(userId, params.sessionId, {
        ...meta(req, res),
        currentSessionId: sessionId,
      });
      sendOk(res, null, { message: 'Device signed out' });
    }),
  );

  router.post(
    '/email/send-verification',
    signedIn({ allowUnverified: true }),
    rateLimit(limiter, {
      name: 'auth:email-verify:user',
      limit: 3,
      windowSeconds: 3600,
      key: (_req, res) => res.locals.auth?.userId ?? null,
    }),
    handle({}, async ({ res }) => {
      await auth.sendEmailVerification(res.locals.auth!.userId, res.locals.clientApp!);
      sendOk(res, null, { message: 'Verification email sent' });
    }),
  );

  router.post(
    '/email/verify',
    authLimit,
    handle({ body: schema.tokenBody }, async ({ body, res }) => {
      await auth.verifyEmail(body.token);
      sendOk(res, null, { message: 'Email verified' });
    }),
  );

  router.post(
    '/phone/verify',
    authLimit,
    signedIn({ allowUnverified: true }),
    handle({ body: schema.phoneVerifyBody }, async ({ body, res }) => {
      await auth.verifyPhone(res.locals.auth!.userId, body.code);
      sendOk(res, null, { message: 'Phone number verified' });
    }),
  );

  router.post(
    '/password/forgot',
    rateLimit(
      limiter,
      { name: 'auth:forgot:ip', limit: 10, windowSeconds: 3600, key: byIp },
      {
        name: 'auth:forgot:identifier',
        limit: AUTH_POLICY.forgotPasswordPerIdentifierPerHour,
        windowSeconds: 3600,
        key: identifierKey,
      },
    ),
    handle({ body: schema.forgotPasswordBody }, async ({ body, res }) => {
      await auth.forgotPassword(body.identifier, res.locals.clientApp!);
      sendOk(res, null, {
        message: 'If an account exists, we have sent instructions to reset the password',
      });
    }),
  );

  router.post(
    '/password/reset',
    authLimit,
    handle({ body: schema.resetPasswordBody }, async ({ body, req, res }) => {
      await auth.resetPassword(body, meta(req, res));
      clearRefreshCookie(res, res.locals.clientApp!, deps.cookieSecure);
      sendOk(res, null, { message: 'Password updated. Please sign in again.' });
    }),
  );

  router.post(
    '/password/change',
    authLimit,
    signedIn({ allowUnverified: true }),
    handle({ body: schema.changePasswordBody }, async ({ body, req, res }) => {
      const { userId, sessionId } = res.locals.auth!;
      const reissued = await auth.changePassword(userId, sessionId, body, meta(req, res));
      setRefreshCookie(
        res,
        res.locals.clientApp!,
        reissued.refreshToken,
        reissued.refreshTokenExpiresAt,
        deps.cookieSecure,
        deps.clock.now(),
      );
      sendOk(res, null, { message: 'Password changed. Other devices were signed out.' });
    }),
  );

  router.post(
    '/reauth',
    authLimit,
    signedIn({ allowUnverified: true }),
    handle({ body: schema.reauthBody }, async ({ body, res }) => {
      const { userId, sessionId } = res.locals.auth!;
      await auth.reauthenticate(userId, sessionId, body);
      sendOk(res, { validForSeconds: AUTH_POLICY.reauthValiditySeconds }, { message: 'Confirmed' });
    }),
  );

  router.post(
    '/account/deletion',
    signedIn({ allowUnverified: true }),
    handle({ body: schema.deletionBody }, async ({ req, res }) => {
      const { userId, sessionId } = res.locals.auth!;
      const result = await auth.requestDeletion(userId, sessionId, meta(req, res));
      clearRefreshCookie(res, res.locals.clientApp!, deps.cookieSecure);
      sendOk(res, result, {
        message: 'Your account will be deleted in 30 days unless you sign in and reactivate it',
      });
    }),
  );

  router.post(
    '/account/reactivate',
    authLimit,
    handle({ body: schema.tokenBody }, async ({ body, req, res }) => {
      sendSignIn(res, await auth.reactivate(body.token, meta(req, res)));
    }),
  );

  return router;
}
