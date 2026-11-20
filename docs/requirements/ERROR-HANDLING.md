# SRS Section 19 — Error Handling

> Part of FOS-SRS-001 v0.2.0 (APPROVED 2026-11-20).

## 19.1 Principles

| ID | Requirement |
|---|---|
| ERR-001 | Every error returned by the API uses the standard error envelope (§14.1) with a stable machine-readable `code`, a human-readable `message` (safe to display), optional `details[]`, `retryable` boolean, and `meta.requestId`. |
| ERR-002 | Domain code throws typed errors (`AppError` subclasses with code, HTTP status, retryable, safe message); a single Express error middleware maps them; unknown errors become `500 INTERNAL_ERROR` with a generic message. |
| ERR-003 | Error codes are part of the public contract: never renamed; new codes may be added; documented in OpenAPI per endpoint. |
| ERR-004 | No stack traces, SQL, provider raw errors, internal IDs of other users, or configuration values in responses. |
| ERR-005 | Every 5xx and every unexpected error is logged at `error` level with requestId, user (pseudonymous), route, error class, stack; 4xx are logged at `info`/`warn` (security-relevant 401/403 at `warn`). |
| ERR-006 | Failures are never silently ignored: catch blocks must rethrow, convert to a typed error, or log + compensate (lint rule + code review checklist). |
| ERR-007 | Frontends map codes to localized user-facing messages via a shared error catalog (`@fos/shared/errors`); unknown codes fall back to the server `message`. |

## 19.2 Error code catalog

| Category | HTTP | Code(s) | User-facing message (example) | Retry? | Recovery |
|---|---|---|---|---|---|
| Validation | 400 | `VALIDATION_ERROR` | "Please correct the highlighted fields." | No | Show field errors |
| Authentication | 401 | `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED` | — (silent refresh) | After refresh | Client refreshes once, then login |
| Authentication | 401 | `AUTH_SESSION_REVOKED`, `AUTH_SESSION_EXPIRED`, `AUTH_REFRESH_INVALID`, `AUTH_REFRESH_REUSED` | "You've been signed out. Please sign in again." | No | Login |
| Authentication | 409 | `AUTH_REFRESH_RACE` | — | Yes, once | Retry refresh |
| Authentication | 401 | `AUTH_INVALID_CREDENTIALS` | "Incorrect email/phone or password." | No | Retry / reset password |
| Authentication | 422 | `AUTH_OTP_INVALID`, `AUTH_OTP_EXPIRED`, `AUTH_OTP_ATTEMPTS_EXCEEDED`, `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_USED`, `AUTH_PASSWORD_WEAK`, `AUTH_PASSWORD_BREACHED`, `AUTH_REGISTRATION_CONFLICT` | e.g., "That code has expired. We've sent a new one." | Varies | Resend / correct |
| Authorization | 403 | `FORBIDDEN`, `AUTH_APP_NOT_PERMITTED`, `AUTH_VERIFICATION_REQUIRED`, `AUTH_REAUTH_REQUIRED`, `AUTH_MFA_REQUIRED`, `AUTH_ACCOUNT_SUSPENDED`, `PROFILE_INCOMPLETE`, `CSRF_ORIGIN_MISMATCH` | "You don't have access to this." / "Verify your phone to continue." | No | Verify / reauth / contact support |
| Not found | 404 | `NOT_FOUND`, `ORDER_NOT_FOUND`, `ITEM_NOT_FOUND`, `OFFER_NOT_FOUND`, … | "We couldn't find that." | No | Navigate back |
| Conflict | 409 | `CONFLICT_STALE_VERSION`, `ORDER_STATE_CONFLICT`, `ORDER_INVALID_TRANSITION`, `DELIVERY_STATE_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `CART_BRANCH_CONFLICT`, `CART_CHANGED`, `CHECKOUT_SESSION_CONSUMED`, `OFFER_EXPIRED`, `OFFER_ALREADY_TAKEN`, `OFFER_WITHDRAWN` | "This order was just updated." | Refetch then act | Refetch & re-render |
| Gone | 410 | `CHECKOUT_SESSION_EXPIRED`, `INVITATION_EXPIRED` | "Your checkout timed out — prices refreshed." | No | Restart step |
| Business rule | 422 | `ITEM_UNAVAILABLE`, `VARIANT_REQUIRED`, `CUSTOMIZATION_INVALID`, `CART_EMPTY`, `CART_INVALID`, `CART_LIMIT_EXCEEDED`, `ADDRESS_NOT_SERVICEABLE`, `LOCATION_NOT_SERVICEABLE`, `BRANCH_NOT_ACCEPTING_ORDERS`, `ORDER_BELOW_MINIMUM`, `ORDER_ABOVE_MAXIMUM`, `PRICE_CHANGED`, `COUPON_INVALID`, `COUPON_EXPIRED`, `COUPON_NOT_APPLICABLE`, `COUPON_LIMIT_REACHED`, `COD_NOT_AVAILABLE`, `INSUFFICIENT_WALLET_BALANCE`, `CANCELLATION_NOT_ALLOWED`, `CANCELLATION_QUOTE_STALE`, `REFUND_EXCEEDS_REFUNDABLE`, `REFUND_LIMIT_EXCEEDED`, `DELIVERY_OTP_INVALID`, `DELIVERY_OTP_LOCKED`, `PHOTO_PROOF_NOT_ALLOWED`, `COD_AMOUNT_MISMATCH`, `PARTNER_CANNOT_GO_ONLINE`, `PARTNER_NOT_ELIGIBLE`, `ONBOARDING_INCOMPLETE`, `ACCOUNT_DELETION_BLOCKED`, `PREP_TIME_OUT_OF_RANGE`, `AGE_REQUIREMENT_NOT_MET` | Specific, actionable messages | No | Per message |
| Payment | 400/409/502 | `PAYMENT_SIGNATURE_INVALID`, `PAYMENT_ORDER_MISMATCH`, `PAYMENT_ATTEMPTS_EXCEEDED`, `PAYMENT_PROVIDER_UNAVAILABLE`, `PAYMENT_DECLINED` | "Payment failed. No money was taken — try again or use another method." | Provider unavailable: yes | Retry / other method / COD |
| Files | 413/415/422 | `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`, `FILE_SCAN_FAILED` | "Please upload a JPG or PNG under 5 MB." | No | Re-upload |
| Rate limit | 429 | `RATE_LIMITED` (+ `Retry-After`) | "Too many attempts. Try again in 2 minutes." | After delay | Wait |
| Database | 503 | `SERVICE_UNAVAILABLE` | "Something went wrong on our side. Please try again." | Yes | Retry with same idempotency key |
| Redis | — | (internal) degraded mode; `SERVICE_DEGRADED` only if operation cannot proceed (e.g., dispatch) | — | — | Fallbacks (NFR-AVAIL-004) |
| Queue | — | (internal) job failures retried; DLQ | — | Yes | Ops retry |
| Third-party | 502/504 | `GEO_PROVIDER_UNAVAILABLE`, `NOTIFICATION_PROVIDER_UNAVAILABLE`, `UPSTREAM_TIMEOUT` | "Address search is unavailable — drop a pin on the map." | Yes | Degraded path |
| Timeout | 504 | `UPSTREAM_TIMEOUT`, `REQUEST_TIMEOUT` | "This is taking longer than usual." | Yes (idempotent) | Retry |
| Internal | 500 | `INTERNAL_ERROR` | "Something went wrong. We're looking into it." | Maybe | Retry; support link with requestId |
| WebSocket | ack/connect_error | `AUTH_TOKEN_INVALID`, `AUTH_SESSION_REVOKED`, `FORBIDDEN`, `VALIDATION_ERROR`, `RATE_LIMITED`, `TOKEN_EXPIRED` | — | Reconnect with fresh token | Client reconnect logic |

## 19.3 Retry behavior

| Layer | Policy |
|---|---|
| Browser API client | Retries automatically only: GET requests on network error/502/503/504 (2 retries, backoff 500 ms → 2 s), and mutations carrying an `Idempotency-Key` (same key reused). Never auto-retries 4xx except `AUTH_REFRESH_RACE` and `401 AUTH_TOKEN_EXPIRED` (after refresh). |
| Delivery app offline queue | Stage actions queued locally with idempotency keys; retried on reconnect in order; UI shows "Pending sync". |
| Server → providers | NFR-REL-003 (timeouts, retries for idempotent calls, circuit breakers). |
| Jobs | NFR-REL-004. |
| DB transactions | Deadlock/serialization failures retried ≤ 3 times server-side. |

## 19.4 Recovery & compensation

| Failure | Compensation |
|---|---|
| Order created, payment initiation failed | Order stays PAYMENT_PENDING; client retries; TTL job cleans up (releases reservations). |
| Refund provider failure after retries | Fallback to wallet credit (configurable) + notification, or ops queue. |
| Notification send failure | Retry → fallback channel → in-app only; never blocks business transaction. |
| Ledger post failure | Business transaction rolls back too (same transaction) — no partial financial state. |
| Socket emit failure | No compensation needed (REST authoritative; push fallback for critical events). |
| Outbox relay down | Events delayed, not lost; alert when oldest unpublished event > 60 s. |

## 19.5 Logging requirements for errors

- Include: requestId, correlationId, error code, HTTP status, route template (not raw URL with IDs where PII may appear), actor pseudonymous ID, module, duration.
- Exclude: request bodies of auth/payment routes, tokens, OTPs, passwords, full phone/email (masked), card-like data.
- Security-relevant errors (signature failures, refresh reuse, forbidden subscriptions, repeated 403s, lockouts) go to a dedicated `security` log stream and are alertable.
