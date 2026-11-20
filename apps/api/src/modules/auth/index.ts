export {
  authenticate,
  authorize,
  type AuthenticateOptions,
  type AuthMiddlewareDeps,
} from './auth.middleware';
export { authRouter, type AuthRouterDeps } from './auth.routes';
export {
  AuthService,
  maskIp,
  normalizeIdentifier,
  type RequestMeta,
  type SignInResult,
  type UserSummary,
} from './auth.service';
export { refreshCookieName } from './cookies';
export { OtpService } from './otp.service';
export { AUTH_POLICY, SESSION_LIFETIME } from './policy';
export { REALTIME_CONTROL_CHANNEL, SessionService, type SessionState } from './session.service';
export { TokenError, TokenService, type AccessClaims } from './tokens';
export { createSocketAuth } from './socket-auth';
