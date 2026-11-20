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
  FORBIDDEN: "You don't have access to this.",
  NOT_FOUND: "We couldn't find that.",
  RATE_LIMITED: 'Too many attempts. Please try again shortly.',
  INTERNAL_ERROR: "Something went wrong. We're looking into it.",
  SERVICE_UNAVAILABLE: 'Something went wrong on our side. Please try again.',
};
