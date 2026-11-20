import type { ClientApp } from '@fos/shared';

/**
 * Authentication policy values (approved defaults, SRS §18 BR-AUTH-*). These move
 * to editable platform settings (FR-CFG-001) with the admin module in Phase 11.
 */
export const AUTH_POLICY = {
  accessTokenTtlSeconds: 15 * 60, // BR-AUTH-006
  refreshGraceSeconds: 10, // BR-AUTH-007
  maxSessionsPerApp: 10, // BR-AUTH-005
  sessionCacheSeconds: 30, // FR-AUTH-021
  touchIntervalSeconds: 5 * 60, // FR-AUTH-021 write coalescing
  otp: {
    length: 6,
    ttlSeconds: 5 * 60,
    maxAttempts: 5,
    resendCooldownSeconds: 30,
    maxPerDestinationPerHour: 5,
    maxPerIpPerHour: 10,
  }, // BR-AUTH-003
  lockout: { failures: 5, baseMinutes: 15, maxMinutes: 24 * 60 }, // BR-AUTH-004
  ipFailures: { limit: 20, windowSeconds: 15 * 60 }, // BR-AUTH-004
  registrationsPerIpPerHour: 5, // BR-AUTH-004
  emailVerificationTtlSeconds: 24 * 60 * 60, // BR-AUTH-008
  passwordResetTtlSeconds: 30 * 60, // BR-AUTH-008
  forgotPasswordPerIdentifierPerHour: 3, // FR-AUTH-011
  mfaTokenTtlSeconds: 5 * 60, // FR-AUTH-032 (email OTP second factor)
  reauthValiditySeconds: 5 * 60, // BR-AUTH-017
  deletionGraceDays: 30, // BR-AUTH-011
  reactivationTokenTtlSeconds: 15 * 60,
} as const;

/** Session lifetimes per app (BR-AUTH-006). */
export const SESSION_LIFETIME: Record<ClientApp, { absoluteSeconds: number; idleSeconds: number }> =
  {
    CUSTOMER: { absoluteSeconds: 30 * 86_400, idleSeconds: 14 * 86_400 },
    DELIVERY: { absoluteSeconds: 30 * 86_400, idleSeconds: 14 * 86_400 },
    RESTAURANT: { absoluteSeconds: 30 * 86_400, idleSeconds: 7 * 86_400 },
    ADMIN: { absoluteSeconds: 12 * 3_600, idleSeconds: 3_600 },
  };

/** Lock duration after `failures` consecutive failed logins: 15 min, doubling every 5, capped at 24 h. */
export function lockMinutesFor(failures: number): number {
  if (failures < AUTH_POLICY.lockout.failures) return 0;
  const steps = Math.floor(failures / AUTH_POLICY.lockout.failures) - 1;
  return Math.min(AUTH_POLICY.lockout.baseMinutes * 2 ** steps, AUTH_POLICY.lockout.maxMinutes);
}
