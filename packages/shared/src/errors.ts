/**
 * Stable, public error codes (SRS §19.2, ERR-003). Codes are never renamed;
 * new codes may be appended. HTTP status mapping lives with the code so the API
 * and the web apps agree on semantics.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  AUTH_TOKEN_MISSING: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_SESSION_REVOKED: 401,
  AUTH_SESSION_EXPIRED: 401,
  AUTH_REFRESH_INVALID: 401,
  AUTH_REFRESH_REUSED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_REFRESH_RACE: 409,
  AUTH_OTP_INVALID: 422,
  AUTH_OTP_EXPIRED: 422,
  AUTH_OTP_ATTEMPTS_EXCEEDED: 422,
  AUTH_TOKEN_USED: 422,
  AUTH_PASSWORD_WEAK: 422,
  AUTH_PASSWORD_BREACHED: 422,
  AUTH_REGISTRATION_CONFLICT: 422,
  AUTH_TERMS_REQUIRED: 422,
  AUTH_EMAIL_ALREADY_VERIFIED: 422,
  AUTH_MFA_INVALID: 422,
  AUTH_SESSION_NOT_FOUND: 404,
  AUTH_ACCOUNT_SUSPENDED: 403,
  AUTH_APP_NOT_PERMITTED: 403,
  AUTH_VERIFICATION_REQUIRED: 403,
  AUTH_REAUTH_REQUIRED: 403,
  ACCOUNT_PENDING_DELETION: 403,
  ACCOUNT_DELETION_BLOCKED: 422,
  ACCOUNT_NOT_REACTIVATABLE: 422,
  FORBIDDEN: 403,
  CSRF_ORIGIN_MISMATCH: 403,
  NOT_FOUND: 404,
  CONFLICT_STALE_VERSION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_TIMEOUT: 504,
  SERVICE_UNAVAILABLE: 503,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code];
}

/** Safe default messages shown to users when no specific message is supplied. */
export const DEFAULT_ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_ERROR: 'Please correct the highlighted fields.',
  AUTH_TOKEN_INVALID: 'Please sign in again.',
  AUTH_SESSION_REVOKED: "You've been signed out. Please sign in again.",
  AUTH_SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  AUTH_REFRESH_INVALID: 'Please sign in again.',
  AUTH_REFRESH_REUSED: "You've been signed out for your security. Please sign in again.",
  AUTH_INVALID_CREDENTIALS: 'Incorrect email/phone or password.',
  AUTH_OTP_INVALID: "That code isn't right. Check it and try again.",
  AUTH_OTP_EXPIRED: 'That code has expired. Request a new one.',
  AUTH_OTP_ATTEMPTS_EXCEEDED: 'Too many wrong attempts. Request a new code.',
  AUTH_TOKEN_EXPIRED: 'This link has expired. Request a new one.',
  AUTH_TOKEN_USED: 'This link has already been used.',
  AUTH_REGISTRATION_CONFLICT: 'An account with these details may already exist. Try signing in.',
  AUTH_TERMS_REQUIRED: 'Please accept the terms and privacy policy to continue.',
  AUTH_ACCOUNT_SUSPENDED: 'This account is suspended. Contact support for help.',
  AUTH_APP_NOT_PERMITTED: "This account can't be used in this app.",
  AUTH_VERIFICATION_REQUIRED: 'Verify your phone number to continue.',
  AUTH_REAUTH_REQUIRED: 'Please confirm your password to continue.',
  ACCOUNT_PENDING_DELETION: 'This account is scheduled for deletion.',
  ACCOUNT_NOT_REACTIVATABLE: 'This account can no longer be reactivated.',
  CSRF_ORIGIN_MISMATCH: 'This request was not sent from a trusted app.',
  FORBIDDEN: "You don't have access to this.",
  NOT_FOUND: "We couldn't find that.",
  RATE_LIMITED: 'Too many attempts. Please try again shortly.',
  INTERNAL_ERROR: "Something went wrong. We're looking into it.",
  SERVICE_UNAVAILABLE: 'Something went wrong on our side. Please try again.',
};
