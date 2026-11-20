import type { RequestHandler } from 'express';
import type { ClientApp, PlatformPermission } from '@fos/shared';
import { AppError } from '../../platform/http/errors';
import { appScopeFor, type IamService } from '../iam';
import type { SessionService } from './session.service';
import { TokenError, type TokenService } from './tokens';

export interface AuthenticateOptions {
  /** Allow users whose phone is not verified yet (verification and profile endpoints). */
  allowUnverified?: boolean;
  /** Allow ONBOARDING-scope sessions (restaurant/delivery applicants). */
  allowOnboarding?: boolean;
}

export interface AuthMiddlewareDeps {
  tokens: TokenService;
  sessions: SessionService;
  iam: IamService;
}

/**
 * Authenticates a request (FR-AUTH-021): verifies the bearer token for the
 * calling app, then the live session — so revocation, suspension and
 * logout-all take effect immediately, not when the token expires.
 * Requires requireClientApp() earlier in the chain.
 */
export function authenticate(
  deps: AuthMiddlewareDeps,
  options: AuthenticateOptions = {},
): RequestHandler {
  return async (req, res, next) => {
    const app = res.locals.clientApp;
    const header = req.header('authorization');
    if (!app || !header?.startsWith('Bearer ')) throw new AppError('AUTH_TOKEN_MISSING');

    let claims;
    try {
      claims = await deps.tokens.verify(header.slice('Bearer '.length).trim(), app);
    } catch (error) {
      throw new AppError(
        error instanceof TokenError && error.reason === 'EXPIRED'
          ? 'AUTH_TOKEN_EXPIRED'
          : 'AUTH_TOKEN_INVALID',
      );
    }

    const state = await deps.sessions.state(claims.sessionId);
    if (!state || state.userId !== claims.userId || state.app !== app)
      throw new AppError('AUTH_TOKEN_INVALID');
    if (state.userStatus === 'SUSPENDED') throw new AppError('AUTH_ACCOUNT_SUSPENDED');
    if (
      !state.active ||
      state.tokenVersion !== claims.tokenVersion ||
      !['ACTIVE', 'PENDING_VERIFICATION'].includes(state.userStatus)
    ) {
      throw new AppError('AUTH_SESSION_REVOKED');
    }

    let scope = claims.scope;
    let roles = claims.roles;
    if (state.permissionVersion !== claims.permissionVersion) {
      // Roles changed since the token was issued: decide from the database, not the token.
      const perms = await deps.iam.resolve(claims.userId, state.permissionVersion);
      const fresh = appScopeFor(app, perms);
      if (!fresh) throw new AppError('AUTH_APP_NOT_PERMITTED');
      scope = fresh;
      roles = perms.platformRoles;
      res.setHeader('X-Permissions-Stale', '1');
    }

    if (!options.allowUnverified && !state.phoneVerified)
      throw new AppError('AUTH_VERIFICATION_REQUIRED');
    if (!options.allowOnboarding && scope === 'ONBOARDING') {
      throw new AppError('FORBIDDEN', { message: 'Finish your application to use this feature.' });
    }

    res.locals.auth = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      app,
      roles,
      scope,
      permissionVersion: state.permissionVersion,
    };
    deps.sessions.touch(state).catch(() => undefined);
    next();
  };
}

/** Platform permission check (ADR-002). Use after authenticate(). */
export function authorize(iam: IamService, permission: PlatformPermission): RequestHandler {
  return async (_req, res, next) => {
    const auth = res.locals.auth;
    if (!auth) throw new AppError('AUTH_TOKEN_MISSING');
    const perms = await iam.resolve(auth.userId, auth.permissionVersion);
    if (!perms.platform.includes(permission)) throw new AppError('FORBIDDEN');
    next();
  };
}

/** Restricts a route to one app's users (the "Cust"/"Rest"/… access column in API-*). */
export const requireApp =
  (app: ClientApp): RequestHandler =>
  (_req, res, next) => {
    next(res.locals.auth?.app === app ? undefined : new AppError('FORBIDDEN'));
  };
