# SRS Sections 4–9 — Functional Requirements

> Part of FOS-SRS-001 v0.7.0 (APPROVED 2026-11-20). Master: [SRS-Online-Food-Ordering-and-Delivery-Platform.md](SRS-Online-Food-Ordering-and-Delivery-Platform.md).
> Business rules (`BR-*`) are defined in [BUSINESS-RULES.md](BUSINESS-RULES.md); error codes in [ERROR-HANDLING.md](ERROR-HANDLING.md); APIs in [API-SPECIFICATION.md](API-SPECIFICATION.md).

---

## 4. Functional Requirements — Conventions and Cross-Cutting Requirements

### 4.1 Requirement format

Requirements with non-trivial flow use the **full template**:

```
#### FR-XXX-NNN — Title                                     [Priority · Release]
Actor · Trigger · Preconditions
Behavior: numbered "The system shall …" statements
Postconditions · Business rules · Validation · Errors · Dependencies
```

Requirements for straightforward create/read/update/delete operations use the **compact table form** (ID, title, "shall" statement, actor, rules/validation/errors, priority, release). Compact-form requirements inherit the **default conditions** in §4.2; anything that deviates is stated explicitly in the row.

### 4.2 Default conditions (inherited by every requirement unless overridden)

| ID | Default |
|---|---|
| DC-01 | **Authentication:** the actor holds a valid access token for a non-suspended, non-deleted account and a non-revoked session (except where the actor is *Guest* or *System*). Failure → `401 AUTH_TOKEN_INVALID`/`AUTH_SESSION_REVOKED`. |
| DC-02 | **Authorization:** the actor holds the permission named in the API spec **and** passes the resource-scope check (ownership, restaurant membership & branch scope, delivery assignment). Failure → `403 FORBIDDEN` — or `404 NOT_FOUND` where revealing existence would leak information (e.g., another customer's order). |
| DC-03 | **Validation:** request input is validated against the shared Zod schema before any business logic runs. Failure → `400 VALIDATION_ERROR` with field-level details. Unknown fields are rejected (strict schemas). |
| DC-04 | **Atomicity:** each state-changing request executes within a single database transaction; partial effects are never persisted. Side effects (notifications, socket events, jobs) are written to the outbox in the same transaction and dispatched only after commit. |
| DC-05 | **Audit:** state changes on financial, security, approval, or admin-initiated operations write an audit log entry (actor, action, target, before/after diff, IP, user agent, request ID). |
| DC-06 | **Soft deletion:** "delete" on user-facing business entities (addresses, menu items, categories, coupons, reviews) is a soft delete (`deleted_at`); historical references remain intact. |
| DC-07 | **Timestamps:** every entity records `created_at`/`updated_at` (UTC). |
| DC-08 | **Concurrency:** updates to versioned aggregates (orders, deliveries, carts, menu items, settings) use optimistic concurrency (`version` column) or row locks; a stale update returns `409 CONFLICT_STALE_VERSION`. |
| DC-09 | **Pagination:** list operations are paginated (cursor-based for feeds/history; offset for admin tables) with max page size 100. |
| DC-10 | **Response envelope:** responses follow §14.1 conventions. |

### 4.3 Cross-cutting functional requirements

#### 4.3.1 Notifications (FR-NOTIF)

| ID | Title | Requirement | Actor | Rules / validation / errors | Pri | Rel |
|---|---|---|---|---|---|---|
| FR-NOTIF-001 | Central dispatch | The system shall route every user-facing notification through the notifications module, which selects channels (in-app, socket, email, SMS, push) from the event's template definition and the recipient's preferences. | System | BR-NOTIF-001 (transactional cannot be disabled), BR-NOTIF-002 | P0 | MVP |
| FR-NOTIF-002 | In-app inbox | The system shall persist an in-app notification record for every event whose template has the in-app channel, retrievable by the recipient in reverse-chronological order. | Any user | Paginated; recipient-only access | P0 | MVP |
| FR-NOTIF-003 | Read state | The system shall allow a recipient to mark one, or all, notifications as read and shall return an unread count. | Any user | Idempotent | P1 | MVP |
| FR-NOTIF-004 | Delete | The system shall allow a recipient to delete (hide) a notification from their inbox. | Any user | Soft delete | P2 | CORE |
| FR-NOTIF-005 | Templates | The system shall render notifications from versioned templates per event × channel × locale with typed variables; missing variables shall fail the job (not send blank text). | System, Super admin | Template validation at save time | P0 | MVP |
| FR-NOTIF-006 | Preferences | The system shall allow users to opt in/out of non-transactional categories (promotions, recommendations, review reminders) per channel. | Customer, Partner, Restaurant member | BR-NOTIF-001 | P1 | CORE |
| FR-NOTIF-007 | Delivery attempts | The system shall record each channel delivery attempt (provider, provider message ID, status, error) and retry transient failures with exponential backoff (max 5 attempts). | System | JOB-NOTIF-001 | P0 | MVP |
| FR-NOTIF-008 | Quiet hours | The system shall not send promotional push/SMS between 22:00 and 08:00 recipient local time; such notifications are deferred. | System | BR-NOTIF-002 | P2 | CORE |
| FR-NOTIF-009 | Push subscriptions | The system shall allow a signed-in device to register/unregister a Web Push subscription bound to its session; subscriptions of revoked sessions shall be deleted. | Any user | VAPID; one per session | P1 | CORE |
| FR-NOTIF-010 | Event catalog | The system shall support at minimum the events listed in §16 of the master prompt (registration, OTP, password reset, restaurant approval/rejection, new order, acceptance/rejection, preparing, ready, partner assigned, partner arriving, picked up, delivered, cancelled, payment success/failure, refund, promotion, support response). Full matrix: `docs/architecture/EVENTS-AND-JOBS.md` §3. | System | — | P0 | MVP |

#### 4.3.2 Files & media (FR-FILE)

| ID | Title | Requirement | Actor | Rules / validation / errors | Pri | Rel |
|---|---|---|---|---|---|---|
| FR-FILE-001 | Upload intake | The system shall accept uploads only through purpose-specific endpoints (`purpose` ∈ AVATAR, RESTAURANT_LOGO, RESTAURANT_COVER, FOOD_IMAGE, RESTAURANT_DOCUMENT, PARTNER_DOCUMENT, PARTNER_PHOTO, DELIVERY_PROOF, SUPPORT_ATTACHMENT). | Authenticated users per purpose | Purpose determines allowed MIME types & size (BR-FILE-001) | P0 | MVP |
| FR-FILE-002 | Content validation | The system shall verify file type by magic bytes (not extension or client MIME), reject mismatches, enforce size limits, and strip EXIF metadata (including GPS) from images. | System | `FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE` | P0 | MVP |
| FR-FILE-003 | Image derivatives | The system shall generate resized WebP derivatives (thumbnail 160 px, card 480 px, hero 1200 px) for public images asynchronously and serve the original only to owners. | System | JOB-FILE-001 | P1 | MVP |
| FR-FILE-004 | Private documents | The system shall store verification documents and delivery proofs in a private bucket, accessible only via signed URLs valid ≤ 5 minutes, issued after an authorization check. | Owner, Admin | Access logged | P0 | MVP |
| FR-FILE-005 | Storage abstraction | The system shall access storage only through the `StorageProvider` interface (local, S3-compatible implementations — SeaweedFS in development, S3/R2 in production). | System | — | P0 | MVP |
| FR-FILE-006 | Orphan cleanup | The system shall delete uploaded files not attached to any entity within 24 hours. | System | JOB-FILE-002 | P2 | CORE |
| FR-FILE-007 | Malware scanning | The system should scan document uploads with an antivirus adapter (ClamAV) before marking them available. | System | ADV if infra cost too high in MVP | P2 | CORE |

#### 4.3.3 Audit (FR-AUDIT)

| ID | Title | Requirement | Pri | Rel |
|---|---|---|---|---|
| FR-AUDIT-001 | Audit capture | The system shall write an append-only audit entry for every action listed in BR-ADMIN-002 and DC-05, including actor user ID, actor roles, session ID, action code, target type/ID, before/after JSON diff (with sensitive fields redacted), IP, user agent, request/correlation ID, timestamp. | P0 | MVP |
| FR-AUDIT-002 | Immutability | The system shall prevent update/delete of audit rows by application roles (DB-level `REVOKE UPDATE, DELETE` and trigger guard). | P0 | MVP |
| FR-AUDIT-003 | Audit query | The system shall allow users with `audit:read` to search audit logs by actor, target, action, and date range, and export results (CSV). | P1 | MVP (search) / CORE (export) |

#### 4.3.4 Platform configuration & feature flags (FR-CFG)

| ID | Title | Requirement | Pri | Rel |
|---|---|---|---|---|
| FR-CFG-001 | Typed settings | The system shall store platform settings as typed, schema-validated key/value records (`cfg.*`) with version history; invalid values are rejected. | P0 | MVP |
| FR-CFG-002 | Effective-dated config | Fee, tax and commission configurations shall be effective-dated (`effective_from`) and never edited retroactively; orders reference the config version used. | P0 | MVP |
| FR-CFG-003 | Feature flags | The system shall evaluate feature flags by environment, zone, role, user-ID percentage rollout, and allowlist; flag evaluation shall be cached ≤ 30 s. | P1 | CORE |
| FR-CFG-004 | Config caching | Settings shall be cached in-process and invalidated via Redis pub/sub on change within 5 s. | P1 | MVP |

---

## 5. Authentication and Session Requirements

Architecture: `docs/architecture/SYSTEM-ARCHITECTURE.md` §6 (Authentication & Session Architecture), ADR-003.

#### FR-AUTH-001 — Register with email and password  [P0 · MVP]
- **Actor:** Guest · **Trigger:** submits registration form in customer, restaurant, or delivery app · **Pre:** none.
- **Behavior:**
  1. The system shall accept `fullName`, `email`, `phone` (E.164, India +91 in MVP), `password`, `acceptTerms=true`, and the client app identifier (`X-Client-App` ∈ CUSTOMER, RESTAURANT, DELIVERY).
  2. The system shall normalize email (trim, lowercase) and phone (E.164) and reject if either is already bound to an active account, returning a generic message that does not reveal which identifier exists (`AUTH_REGISTRATION_CONFLICT`, see BR-AUTH-015).
  3. The system shall hash the password with Argon2id (BR-AUTH-001 parameters) and never persist or log the plaintext.
  4. The system shall create the user with status `PENDING_VERIFICATION`, assign the role implied by the client app (CUSTOMER for customer app; restaurant and delivery apps assign roles only after onboarding approval — until then the user may access only onboarding endpoints), record terms/privacy versions accepted with timestamp.
  5. The system shall send a phone OTP (FR-AUTH-010) and an email verification link (FR-AUTH-008) via the notification jobs.
  6. The system shall create a session and issue tokens (FR-AUTH-020) so the user can complete verification without re-login; endpoints other than verification, profile read and onboarding shall return `403 AUTH_VERIFICATION_REQUIRED` until the phone is verified.
- **Post:** user, credential, profile, role assignment, consent record, session exist; OTP and verification jobs enqueued.
- **Rules:** BR-AUTH-001, BR-AUTH-014, BR-AUTH-015, BR-AUTH-020 (consent).
- **Validation:** name 2–80 chars (letters, spaces, `.'-`); email RFC 5322 ≤ 254 chars; password per BR-AUTH-001; phone valid Indian mobile.
- **Errors:** `VALIDATION_ERROR`, `AUTH_REGISTRATION_CONFLICT`, `AUTH_PASSWORD_WEAK`, `AUTH_PASSWORD_BREACHED`, `RATE_LIMITED`.
- **Dependencies:** FR-AUTH-008, FR-AUTH-010, notifications, rate limiter (BR-AUTH-004 registration throttling: 5 per IP per hour).

#### FR-AUTH-002 — Register / sign in with phone and OTP  [P0 · MVP]
- **Actor:** Guest · **Trigger:** enters phone number and requests OTP.
- **Behavior:** 1) The system shall send a 6-digit OTP to the phone (FR-AUTH-010) with purpose `LOGIN`. 2) On correct OTP: if a user exists with this phone, the system shall sign them in (FR-AUTH-020); otherwise it shall create a user with phone verified, status `ACTIVE`, and require `fullName` (and optional email) before first order (`profileComplete=false`). 3) The system shall not disclose whether the phone was already registered in the OTP request response.
- **Post:** verified phone; session issued.
- **Rules:** BR-AUTH-002, BR-AUTH-003, BR-AUTH-010.
- **Errors:** `AUTH_OTP_INVALID`, `AUTH_OTP_EXPIRED`, `AUTH_OTP_ATTEMPTS_EXCEEDED`, `AUTH_TERMS_REQUIRED` (new number without accepted terms), `RATE_LIMITED`, `AUTH_ACCOUNT_SUSPENDED`, `ACCOUNT_PENDING_DELETION`.

#### FR-AUTH-003 — Login with email/phone and password  [P0 · MVP]
- **Actor:** Guest · **Trigger:** submits identifier + password.
- **Behavior:**
  1. The system shall look up the user by normalized email or phone.
  2. The system shall verify the password in constant time; if the user does not exist it shall still perform a dummy Argon2id verification to equalize timing.
  3. On failure it shall record a `login_attempts` row (identifier hash, IP, outcome) and increment counters per account and per IP (BR-AUTH-004); responses shall be identical for unknown user and wrong password (`AUTH_INVALID_CREDENTIALS`).
  4. If the account is temporarily locked (BR-AUTH-004), the system shall return the same `AUTH_INVALID_CREDENTIALS` response as for a wrong password until the lock expires (no lock-status oracle), and shall notify the account owner by email/SMS that the account was locked.
  5. If the account status is `SUSPENDED` or `DEACTIVATED` (pending deletion), after a correct password it shall return `AUTH_ACCOUNT_SUSPENDED` / offer reactivation (FR-AUTH-042).
  6. It shall verify the user has a role permitted for the requesting app (BR-AUTH-010); otherwise `AUTH_APP_NOT_PERMITTED`.
  7. On success it shall reset the failure counter and create a session (FR-AUTH-020).
- **Errors:** `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_SUSPENDED`, `ACCOUNT_PENDING_DELETION` (offers reactivation, FR-AUTH-042), `AUTH_APP_NOT_PERMITTED`, `AUTH_MFA_REQUIRED` (admin, CORE), `RATE_LIMITED`.

#### FR-AUTH-004 — OAuth sign-in (Google, Apple)  [P2 · CORE]
- **Behavior:** The system shall verify the provider ID token (signature against provider JWKS, `aud`, `iss`, `exp`, nonce), find a user by `(provider, providerUserId)`; if absent and the provider email is verified and matches an existing account, it shall require the user to sign in with the existing method before linking (no silent account takeover); otherwise create a new account (phone still required before ordering). OAuth is available only in the customer app.
- **Errors:** `AUTH_OAUTH_TOKEN_INVALID`, `AUTH_OAUTH_LINK_REQUIRED`.

#### FR-AUTH-005 — Logout (current session)  [P0 · MVP]
The system shall revoke the current session and its refresh-token family, clear the refresh cookie (`Max-Age=0`), delete push subscriptions bound to the session, and disconnect sockets authenticated with the session within 5 seconds. Idempotent: logging out a revoked session returns success.

#### FR-AUTH-006 — Logout from all devices  [P0 · MVP]
The system shall revoke all sessions of the user (optionally excluding the current one when `keepCurrent=true`), increment the user's `tokenVersion` so outstanding access tokens are rejected at next validation, and force-disconnect affected sockets. Audit-logged.

#### FR-AUTH-007 — List and revoke device sessions  [P0 · MVP]
- The system shall list the user's active sessions with: session ID, app, device label (parsed user agent), approximate location (city from IP, if available), IP (masked last octet), created at, last active at, and `current=true` for the caller.
- The system shall allow revoking any one of the user's own sessions by ID (`AUTH_SESSION_NOT_FOUND` if not owned — returns 404).

#### FR-AUTH-008 — Email verification  [P1 · MVP]
- The system shall send a single-use verification link containing a random 256-bit token (stored hashed) valid for 24 h (BR-AUTH-008); verifying sets `emailVerifiedAt`. Requesting a new link invalidates previous ones. Resend limited to 3/hour.
- Errors: `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_USED`, `AUTH_TOKEN_INVALID`.

#### FR-AUTH-009 — Phone verification  [P0 · MVP]
The system shall verify phone ownership via OTP purpose `VERIFY_PHONE`; on success set `phoneVerifiedAt`, transition `PENDING_VERIFICATION → ACTIVE`. Changing phone number (FR-CUST-004) requires OTP verification of the **new** number and re-auth (BR-AUTH-017) and revokes other sessions.

#### FR-AUTH-010 — OTP generation, delivery and verification  [P0 · MVP]
- **Behavior:**
  1. The system shall generate a cryptographically random 6-digit code per `(destination, purpose)` (purposes: LOGIN, VERIFY_PHONE, RESET_PASSWORD, CHANGE_PHONE, DELETE_ACCOUNT, DELIVERY_HANDOVER is separate — see FR-DEL-030).
  2. It shall store only an HMAC-SHA256 of the code (keyed with a server secret) with expiry 5 min and attempt counter.
  3. A new OTP for the same destination+purpose shall invalidate the previous one.
  4. Verification shall compare in constant time, increment attempts, and invalidate the OTP after 5 wrong attempts (`AUTH_OTP_ATTEMPTS_EXCEEDED`) or on success (single use).
  5. Resend cooldown 30 s; max 5 OTPs per destination per hour and 10 per IP per hour (BR-AUTH-003).
  6. OTP values shall never be logged, returned by the API, or included in analytics. In non-production environments with `OTP_DEV_MODE=true`, the code is written to the dev mail/SMS sink, never to the API response.

#### FR-AUTH-011 — Forgot password  [P0 · MVP]
The system shall accept an email or phone, and — **regardless of whether an account exists** — respond with the same generic success message. If the account exists and is not deleted, it shall send a reset link (email; 256-bit token, hashed, 30-min TTL, single use) or a reset OTP (phone). Rate limit: 3 per identifier per hour, 10 per IP per hour.

#### FR-AUTH-012 — Reset password  [P0 · MVP]
On a valid reset token/OTP, the system shall set the new password (BR-AUTH-001, must differ from current), invalidate all reset tokens for the user, **revoke all sessions** (BR-AUTH-016), notify the user by email/SMS, and audit-log the event. It shall not auto-login; the user signs in again.

#### FR-AUTH-013 — Change password  [P0 · MVP]
For an authenticated user, the system shall require the current password, enforce BR-AUTH-001, update the hash, revoke all **other** sessions, rotate the current session's refresh token, and send a security notification.

#### FR-AUTH-014 — Account recovery  [P2 · CORE]
When a user has lost access to both email and phone, the system shall allow creating a support recovery request; recovery is completed only by a support agent with `account:recover` after identity verification per the documented support procedure, and requires the user to set a new password and verify a new phone. Audit-logged.

#### FR-AUTH-020 — Session creation and token issuance  [P0 · MVP]
- **Behavior:**
  1. On successful authentication the system shall create a `user_sessions` row: ID (UUIDv7), user ID, app, device info (UA, parsed platform), IP, created at, last active at, absolute expiry (`now + 30 d` customer/partner, `now + 12 h` admin), idle expiry window (customer/partner 14 d, restaurant 7 d, admin 1 h), status `ACTIVE`.
  2. It shall generate a refresh token (256-bit random, base64url), store `SHA-256(token)` in `refresh_tokens` with session ID (= family), parent token ID, issued at, expires at, status `ACTIVE`.
  3. It shall set the refresh token in a cookie: name `fos_rt_<app>`, `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age` = absolute session remaining time. (`Secure` relaxed only for `http://localhost` in development.)
  4. It shall issue an access token: JWT, alg HS256 with key ID (`kid`) for rotation (EdDSA when services are split — ADR-003), TTL 15 min, claims `sub` (user ID), `sid` (session ID), `app`, `roles`, `pv` (permission version), `tv` (token version), `iat`, `exp`, `jti`, `iss`, `aud` (= app).
  5. It shall return the access token and its expiry in the response body (never the refresh token).
  6. If the user exceeds the max concurrent sessions per app (BR-AUTH-005, default 10), the oldest-by-last-activity session shall be revoked.
- **Post:** session active; client holds access token in memory only.

#### FR-AUTH-021 — Access token validation  [P0 · MVP]
For each authenticated request the system shall: verify signature, `exp`, `iss`, `aud` matches the calling app; then check the session is `ACTIVE` and the user's `tokenVersion` equals `tv` using a Redis-cached session status (TTL ≤ 30 s, invalidated on revocation) — so session revocation takes effect within at most 30 s for REST and immediately for sockets (pub/sub). If Redis is unavailable, the check falls back to the database (NFR-AVAIL-004). It shall update `last_active_at` at most once per 5 minutes per session (write coalescing).

#### FR-AUTH-022 — Refresh token rotation  [P0 · MVP]
- **Actor:** Client (browser) · **Trigger:** access token expired or about to expire; `POST /auth/refresh` with cookie.
- **Behavior:**
  1. The system shall require: refresh cookie present; `Origin` header in the app's allowlist; custom header `X-Client-App` present (CSRF defense, BR-AUTH-019).
  2. It shall look up the token by hash. If not found → `401 AUTH_REFRESH_INVALID` (clear cookie).
  3. If found and `ACTIVE` and not expired and session `ACTIVE` and within idle/absolute expiry: in one transaction with `SELECT … FOR UPDATE` on the token row, mark it `ROTATED` (set `rotated_at`, `replaced_by`), insert a new `ACTIVE` token in the same family, update session `last_active_at`, issue a new access token, set the new cookie.
  4. **Reuse detection:** if the presented token is `ROTATED` and was rotated **more than** the grace window ago (BR-AUTH-007, 10 s), the system shall treat it as theft: revoke the whole family (session → `REVOKED`, reason `REFRESH_REUSE`), revoke all its tokens, disconnect sockets, write a security audit event, notify the user ("Your session on <device> was signed out for your security"), and return `401 AUTH_REFRESH_REUSED`.
  5. **Concurrency grace:** if the presented token was rotated **within** the grace window (e.g., two tabs refreshed simultaneously), the system shall not revoke; it shall return `409 AUTH_REFRESH_RACE` so the client retries once (the browser will by then send the newer cookie).
  6. If `REVOKED`/expired → `401 AUTH_SESSION_REVOKED` / `AUTH_SESSION_EXPIRED`, clear cookie.
- **Post:** exactly one `ACTIVE` refresh token per session at any time.
- **Rules:** BR-AUTH-006, BR-AUTH-007, BR-AUTH-019.
- **Dependencies:** frontend single-flight refresh with cross-tab lock (`navigator.locks`/BroadcastChannel) — FR-FE-003.

#### FR-AUTH-023 — Session expiry  [P0 · MVP]
The system shall reject refresh for sessions past absolute expiry or idle expiry, marking them `EXPIRED`; a scheduled job (JOB-AUTH-001) shall mark expired sessions and purge refresh token rows older than 30 days past expiry.

#### FR-AUTH-024 — Permission version / role change propagation  [P0 · MVP]
When a user's roles, restaurant memberships, or role permissions change, the system shall increment the affected users' `permissionVersion`; requests carrying an older `pv` shall have permissions re-resolved from the database (not trusted from the token), and the client shall be told to refresh (`X-Permissions-Stale: 1`). Role removal that revokes app access shall revoke that app's sessions.

#### FR-AUTH-030 — Brute-force and abuse protection  [P0 · MVP]
The system shall rate-limit authentication endpoints per IP and per identifier (BR-AUTH-004), apply progressive delays, lock accounts temporarily after repeated failures, require a CAPTCHA adapter challenge (hCaptcha/Turnstile — CORE) after 3 failures from an IP, and alert admins on credential-stuffing patterns (> 100 failures/min platform-wide).

#### FR-AUTH-031 — Step-up re-authentication  [P1 · MVP]
Sensitive operations (change email/phone, change bank details, delete account, view full partner/restaurant bank details, admin financial config) shall require the user to have re-entered their password or OTP within the last 5 minutes (`reauthAt` on session); otherwise `403 AUTH_REAUTH_REQUIRED`.

#### FR-AUTH-032 — Admin MFA  [P1 · CORE]
Admin, support and super-admin accounts shall require TOTP (RFC 6238) MFA at login with recovery codes (hashed); MVP fallback: email OTP second factor for admin app logins.

#### FR-AUTH-040 — Account suspension  [P0 · MVP]
An admin with `user:suspend` shall be able to suspend a user with a reason and optional end date. Suspension shall revoke all sessions immediately, prevent login (`AUTH_ACCOUNT_SUSPENDED`), cancel the user's open carts, and — depending on role — trigger side effects: partner forced offline and active offers revoked (active delivery is completed or reassigned by ops); restaurant member loses access (restaurant itself is suspended separately — FR-ADMIN-023). Customer's in-flight orders continue to completion. Audit-logged; user notified.

#### FR-AUTH-041 — Account deletion  [P0 · MVP]
- **Behavior:** 1) The system shall require step-up re-auth and explicit confirmation. 2) It shall block deletion while the user has non-terminal orders, an active delivery, an unsettled partner/restaurant balance, open disputes, or sole ownership of an active restaurant (`ACCOUNT_DELETION_BLOCKED` with reasons). 3) It shall set status `DEACTIVATED` (pending deletion), revoke all sessions, and schedule anonymization after the grace period (BR-AUTH-011, 30 days). 4) After the grace period JOB-USER-001 shall anonymize PII (name → "Deleted user", email/phone → irreversible tombstone hash, addresses deleted, avatar removed, push subscriptions removed), while retaining orders, payments and ledger entries required for legal/tax retention (§20) linked to the anonymized ID.
- **Post:** user cannot log in; data minimized per §20.

#### FR-AUTH-042 — Account reactivation  [P1 · MVP]
A user in the deletion grace period shall be able to reactivate by signing in successfully and confirming; reactivation cancels the anonymization job. No session is issued before confirmation: sign-in returns `ACCOUNT_PENDING_DELETION` with a one-time reactivation token (15 min), which API-AUTH-023 exchanges for a session. Suspended users cannot self-reactivate; only admins can lift a suspension (`user:unsuspend`). After anonymization, reactivation is impossible.

---

## 6. Customer Functional Requirements

### 6.1 Profile & account (FR-CUST)

| ID | Title | Requirement | Rules / validation / errors | Pri | Rel |
|---|---|---|---|---|---|
| FR-CUST-001 | View profile | The system shall return the customer's profile: name, email (+verified), phone (+verified), avatar URL, dietary preferences, veg-only default, language, created at. | Own data only | P0 | MVP |
| FR-CUST-002 | Update profile | The system shall allow updating name, dietary preferences, veg-only default, language. | Name rules as FR-AUTH-001 | P0 | MVP |
| FR-CUST-003 | Change email | The system shall allow changing email after step-up re-auth; the new email is unverified until verified (FR-AUTH-008); the old email receives a notice. | FR-AUTH-031; `AUTH_REGISTRATION_CONFLICT` | P1 | MVP |
| FR-CUST-004 | Change phone | The system shall allow changing phone after re-auth and OTP verification of the new number; other sessions revoked. | FR-AUTH-009 | P1 | MVP |
| FR-CUST-005 | Avatar | The system shall allow uploading (JPEG/PNG/WebP ≤ 5 MB) and deleting a profile image. | FR-FILE-001..003 | P2 | MVP |
| FR-CUST-006 | Preferences | The system shall store preferences: veg-only default, dietary tags to highlight, allergens to warn about, notification preferences (FR-NOTIF-006). | Allergen enum | P1 | MVP |
| FR-CUST-007 | Account status | The system shall expose account status (ACTIVE, PENDING_VERIFICATION, SUSPENDED, DEACTIVATED) and verification flags. | — | P1 | MVP |
| FR-CUST-008 | Data export | The system shall allow a customer to request an export of their personal data (JSON/CSV) delivered by email link within 72 h. | §20; DPDP rights | P2 | CORE |

### 6.2 Location & addresses (FR-ADDR, FR-LOC)

| ID | Title | Requirement | Rules / validation / errors | Pri | Rel |
|---|---|---|---|---|---|
| FR-LOC-001 | Detect location | The customer app shall request browser geolocation on user action (never on page load without context) and use the coordinates (with accuracy) as the current delivery location. | If denied → manual selection prompt | P0 | MVP |
| FR-LOC-002 | Reverse geocode | The system shall reverse-geocode coordinates to a display address via the geo adapter, caching results by rounded coordinates (~11 m) for 30 days. | Provider down → show coordinates + "Pin location" label (degraded) | P0 | MVP |
| FR-LOC-003 | Address search | The system shall provide address autocomplete (debounced ≥ 300 ms, min 3 chars) via the geo adapter, biased to the current city. | `GEO_PROVIDER_UNAVAILABLE` → allow manual pin | P0 | MVP |
| FR-LOC-004 | Map pin | The customer app shall allow choosing/adjusting a location by dragging a map pin; the final pin coordinates are authoritative over the text address. | — | P0 | MVP |
| FR-LOC-005 | Session location | The system shall allow guests and customers to set a "current location" without saving it as an address; it is stored client-side and sent with discovery requests. | — | P0 | MVP |
| FR-LOC-006 | Serviceability check | The system shall answer whether a location is inside any active delivery zone, and (if a branch is given) whether that branch can deliver there now, with a reason code when not (`OUTSIDE_ZONE`, `OUTSIDE_RADIUS`, `BRANCH_CLOSED`, `BRANCH_PAUSED`, `ZONE_SUSPENDED`). | BR-GEO-001 | P0 | MVP |
| FR-ADDR-001 | Create address | The system shall save an address with: label (HOME, WORK, OTHER + custom name), line1 (house/flat), line2 (building/street), landmark, area, city, state, pincode, coordinates (required), contact name & phone (default: own), delivery instructions. | BR-ADDR-001, BR-ADDR-002; max 20 addresses; one HOME and one WORK label max (others OTHER) | P0 | MVP |
| FR-ADDR-002 | List / get addresses | The system shall list the customer's non-deleted addresses with default flag and, if a branch ID is provided, per-address serviceability for that branch. | — | P0 | MVP |
| FR-ADDR-003 | Update address | The system shall allow editing an address; orders already placed keep their address snapshot. | Coordinates change → re-validate pincode/city | P0 | MVP |
| FR-ADDR-004 | Delete address | The system shall soft-delete an address; if it was default, no default remains until set. | — | P0 | MVP |
| FR-ADDR-005 | Default address | The system shall allow exactly one default address per customer (partial unique index). | — | P1 | MVP |
| FR-ADDR-006 | Address validation | The system shall reject addresses whose coordinates are outside India's bounding box (lat 6.5–37.2, lng 68.0–97.5; delivery zones restrict actual service), or whose pincode is not 6 digits; it shall warn (not block) when the text address geocodes > 500 m from the pin. | `ADDRESS_INVALID` | P1 | MVP |

### 6.3 Discovery & home (FR-DISC)

#### FR-DISC-001 — Serviceable restaurant listing  [P0 · MVP]
- **Actor:** Guest/Customer · **Trigger:** home or listing page load with a location.
- **Behavior:**
  1. The system shall accept `lat`, `lng` (required), filters, sort, cursor.
  2. It shall return only branches that satisfy BR-GEO-001 (within branch delivery radius by straight-line pre-filter using PostGIS `ST_DWithin` on a GiST index, within an active zone, restaurant `APPROVED`, branch `ACTIVE`, not deleted).
  3. Branches that are serviceable by location but **currently closed or paused** shall be returned in a separate trailing group flagged `isOpen=false` with `opensAt` (so customers understand why they can't order), unless the filter `openNow=true` is set.
  4. For each result it shall include: restaurant & branch IDs, names, logo/cover thumbnails, cuisines (max 3), rating avg & count, price-for-two, distance (km, 1 decimal), ETA range (min–max minutes, FR-DISC-010), delivery fee preview for this location, best offer label, veg-only flag, `isOpen`, `isFavorite` (if signed in).
  5. It shall complete within NFR-PERF-003.
- **Rules:** BR-GEO-001..003, BR-REST-001.
- **Errors:** `VALIDATION_ERROR` (missing coordinates), `LOCATION_NOT_SERVICEABLE` (empty, with `reason=OUTSIDE_ZONE` so UI can show "We're not here yet").

| ID | Title | Requirement | Rules / notes | Pri | Rel |
|---|---|---|---|---|---|
| FR-DISC-002 | Filters | The system shall filter the listing by: cuisine(s), min rating (3.5/4.0/4.5), max delivery time, max delivery fee / free delivery, price-for-two range, has offers, pure veg (restaurant-level `pureVeg` flag), has vegan options, open now, max distance. Filters combine with AND; multiple cuisines combine with OR. | Unknown filter values → `VALIDATION_ERROR` | P0 | MVP |
| FR-DISC-003 | Sorting | The system shall sort by: relevance/recommended (default; FR-DISC-011), rating, delivery time, distance, cost low→high, cost high→low, popularity (orders last 30 days). Ties break by restaurant ID for stable pagination. | — | P0 | MVP |
| FR-DISC-004 | Pagination | The system shall paginate discovery with an opaque cursor encoding sort key + ID; page size default 20, max 50. Infinite scroll in UI. | Cursor tampering → `VALIDATION_ERROR` | P0 | MVP |
| FR-DISC-005 | Collections | The system shall return curated sections for the home page: Featured (admin-curated), Popular near you, Top-rated (≥ 4.2, ≥ 50 ratings), Newly added (approved ≤ 30 days), Free delivery, Offers, Today's specials (items flagged `isTodaySpecial`), Best-selling items, Trending dishes (order count growth 7 d vs prior 7 d), Popular cuisines — all restricted to serviceable branches. | Each section max 15 items; cached per geohash-6 cell for 5 min | P1 | MVP |
| FR-DISC-006 | Banners | The system shall return active promotional banners (admin-managed: image, title, deep link target, zone targeting, schedule) for the location. | Banner links only to internal routes | P1 | MVP |
| FR-DISC-007 | Cuisine browse | The system shall list restaurants by cuisine slug with the same serviceability rules. | — | P0 | MVP |
| FR-DISC-008 | Veg-only toggle | The system shall, when `vegOnly=true`, exclude non-veg and egg items from all item results and show only restaurants with ≥ 1 veg item (pure-veg restaurants ranked first). The toggle persists in customer preferences (FR-CUST-006). | — | P0 | MVP |
| FR-DISC-009 | Branch delivery info | The system shall return, for a branch and location: serviceable (bool + reason), distance, ETA range, delivery fee, minimum order, small-order fee threshold, surge active flag. | BR-PRICE-003..007 | P0 | MVP |
| FR-DISC-010 | ETA estimate (listing) | The system shall estimate listing ETA as: branch average prep time (rolling 14-day median or configured prep time) + travel time (distance × zone speed factor) + buffer (5 min) ± range (±5 min), rounded to 5 min. | Heuristic in MVP; ADV ML | P0 | MVP |
| FR-DISC-011 | Recommended ranking | The system shall rank "recommended" by a weighted score: rating (Bayesian average), ETA, popularity, offer presence, customer's past orders/favorites (if signed in); closed branches always after open ones. Weights are configurable (`cfg.discovery.weights`). | — | P1 | MVP |
| FR-DISC-012 | Recommended for you | The system shall show "Order again" (restaurants from the customer's last 5 delivered orders that are serviceable) on the home page. | Signed-in only | P1 | MVP |
| FR-DISC-013 | Restaurants by offer | The system shall list restaurants with a given active promotion/coupon applicable at the location. | — | P2 | CORE |

### 6.4 Search (FR-SRCH)

| ID | Title | Requirement | Rules / notes | Pri | Rel |
|---|---|---|---|---|---|
| FR-SRCH-001 | Unified search | The system shall search restaurants (name, cuisine, tags), dishes (name, description, category), and cuisines for a query + location, returning grouped results restricted to serviceable branches. | Query 2–100 chars | P0 | MVP |
| FR-SRCH-002 | Ranking | The system shall rank results by `ts_rank` (weighted A: name, B: cuisine/category, C: description) combined with trigram similarity, rating, and distance; exact prefix name matches first. | ADR-009 | P0 | MVP |
| FR-SRCH-003 | Typo tolerance | The system shall return trigram-similar matches (similarity ≥ 0.3) when full-text yields fewer than 5 results ("biriyani" → "biryani"). | `pg_trgm` | P1 | CORE |
| FR-SRCH-004 | Autocomplete | The system shall return up to 8 suggestions (restaurants, dishes, cuisines) within NFR-PERF-005 for prefix queries ≥ 2 chars. | Debounce client 250 ms | P1 | CORE |
| FR-SRCH-005 | Search history | The system shall store the signed-in customer's last 20 distinct queries, show them on focus, and allow clearing one or all. | Retention §20 | P2 | CORE |
| FR-SRCH-006 | Trending searches | The system shall show the top 10 queries in the zone in the past 24 h (min 20 distinct users, profanity-filtered). | Aggregated hourly (JOB-SRCH-001) | P2 | CORE |
| FR-SRCH-007 | Dish results | Dish results shall show item, price, dietary marker, restaurant, ETA, and allow add-to-cart directly (with customization sheet if needed). | — | P1 | MVP |
| FR-SRCH-008 | Search filters | The system shall support veg-only, rating, delivery time, and price filters on search results. | — | P1 | MVP |

### 6.5 Restaurant details & menu (FR-MENU-C)

| ID | Title | Requirement | Rules / notes | Pri | Rel |
|---|---|---|---|---|---|
| FR-MENUC-001 | Restaurant page | The system shall return branch details: name, logo, cover, description, address, map location, cuisines, rating avg/count with distribution, price-for-two, today's hours & full week schedule, current status (OPEN, CLOSED, PAUSED, CLOSING_SOON ≤ 30 min), next opening time, ETA, delivery fee, min order amount, max order amount, FSSAI license number (BR-REST-010), active offers. | Non-serviceable location → page viewable, add-to-cart disabled with reason | P0 | MVP |
| FR-MENUC-002 | Menu structure | The system shall return the branch menu grouped by restaurant-defined categories in configured order, preceded by smart sections "Recommended" (`isRecommended`), "Bestsellers" (`isBestseller` or top-10 by 30-day orders), and "Today's Special". | Items appear in their category and may also appear in smart sections | P0 | MVP |
| FR-MENUC-003 | Item card | Each item shall show name, short description, image (if any), price, discounted price (struck original), dietary marker (VEG green square-dot / NON_VEG red triangle / EGG yellow), tags (vegan, jain, gluten-free, spicy level), bestseller badge, `customizable` indicator, availability. | §17.1 marker spec; markers have text alternatives | P0 | MVP |
| FR-MENUC-004 | Item details | The system shall return item details: all images, full description, variants, customization groups with options/prices/rules, ingredients, allergens, dietary tags, serving size, prep time, calorie info (optional), rating (CORE). | — | P0 | MVP |
| FR-MENUC-005 | Unavailable items | Items unavailable at the branch (out of stock, outside schedule, disabled) shall be shown greyed with "Not available now" (or next available time) and cannot be added to cart. Items deleted shall not be shown. | BR-MENU-007 | P0 | MVP |
| FR-MENUC-006 | Menu filters | The customer shall be able to filter the menu by veg-only, non-veg, egg, vegan, bestseller, and search within the menu. | Client-side on loaded menu | P0 | MVP |
| FR-MENUC-007 | Allergen warning | If the customer has allergen preferences, items containing those allergens shall display a warning badge. | Informational only (A-08) | P2 | CORE |
| FR-MENUC-008 | Menu caching | Menu reads shall be served from cache keyed by branch + menu version; any menu or availability change bumps the version and invalidates within 5 s. | NFR-PERF-004 | P1 | MVP |
| FR-MENUC-009 | Restaurant reviews view | The system shall list a restaurant's published reviews with rating filter and sort (recent, highest, lowest), with restaurant responses. | — | P1 | MVP |
| FR-MENUC-010 | Branches of a brand | The system shall list a brand's other branches with serviceability for the current location. | — | P2 | CORE |

### 6.6 Cart (FR-CART)

#### FR-CART-001 — Add item to cart  [P0 · MVP]
- **Actor:** Customer (guests keep a local draft cart which is posted to the server on sign-in — FR-CART-011).
- **Pre:** branch serviceable for the cart's location or no location set yet (checked again at checkout); item available.
- **Behavior:**
  1. The system shall accept `branchId`, `foodItemId`, `variantId?`, `options[]` (option IDs), `quantity` (1–20), `instructions?` (≤ 250 chars).
  2. It shall validate: item belongs to the branch's restaurant and is available at the branch now (BR-MENU-007); the variant belongs to the item (required if the item has variants); every option belongs to a customization group attached to the item/variant; each group's min/max selection constraints are satisfied; required groups are present; option availability; stock if stock-tracked.
  3. If the customer has an active cart for a **different branch**, the system shall reject with `409 CART_BRANCH_CONFLICT` including the existing cart's restaurant name; the client presents "Start new cart?" and on confirmation calls the endpoint with `replaceCart=true`, which clears the old cart atomically before adding (BR-CART-001).
  4. If a line with an identical configuration (item, variant, sorted option IDs, instructions) exists, the system shall increase its quantity (BR-CART-004), respecting max quantity per line (20) — otherwise create a line.
  5. It shall return the full cart with recomputed pricing preview (FR-CART-008).
- **Errors:** `ITEM_UNAVAILABLE`, `ITEM_NOT_IN_BRANCH`, `VARIANT_REQUIRED`, `CUSTOMIZATION_INVALID` (details per group), `CART_BRANCH_CONFLICT`, `CART_LIMIT_EXCEEDED`, `BRANCH_NOT_ACCEPTING_ORDERS` (warn-only on add; hard error at checkout).

| ID | Title | Requirement | Rules / notes | Pri | Rel |
|---|---|---|---|---|---|
| FR-CART-002 | Get cart | The system shall return the active cart with lines, per-line computed price, availability status per line, and a pricing preview; lines that became invalid are flagged (`UNAVAILABLE`, `PRICE_CHANGED`, `OPTION_UNAVAILABLE`) rather than silently removed. | BR-CART-005 | P0 | MVP |
| FR-CART-003 | Update quantity | The system shall set a line's quantity (0 removes the line). | 0–20; optimistic version | P0 | MVP |
| FR-CART-004 | Update customization | The system shall replace a line's variant/options/instructions with full revalidation; if the result equals another line, they are merged. | As FR-CART-001 | P1 | MVP |
| FR-CART-005 | Remove line | The system shall remove a line; removing the last line keeps an empty cart bound to no branch. | — | P0 | MVP |
| FR-CART-006 | Clear cart | The system shall remove all lines and any applied coupon. | — | P0 | MVP |
| FR-CART-007 | Cart instructions | The system shall store cart-level cooking instructions (≤ 250 chars) and "don't send cutlery" preference. | Sanitized text | P1 | MVP |
| FR-CART-008 | Pricing preview | The system shall compute a full price breakdown (FR-PRICE-001) for the cart using the selected address (or current location) and coupon, labelled as a preview (final price fixed at checkout session). | Server-side only | P0 | MVP |
| FR-CART-009 | Apply / remove coupon | The system shall validate and attach one coupon to the cart (FR-COUP-002), returning the discount or a specific ineligibility reason; removing detaches it. | BR-COUPON-001..008 | P0 | MVP |
| FR-CART-010 | Validate cart | The system shall provide an explicit validation endpoint returning all blocking issues (branch closed, items unavailable, min order not met, not serviceable, coupon invalid) and non-blocking warnings (price changed). | — | P0 | MVP |
| FR-CART-011 | Guest cart merge | On sign-in, the client shall submit its local draft; the system shall validate each line and either adopt it (if the user has no server cart or the same branch) or return a conflict for the user to choose. | — | P1 | MVP |
| FR-CART-012 | Persistence & expiry | Carts shall persist server-side across devices; carts inactive for 7 days shall expire (JOB-CART-001), and carts are converted (closed) when an order is created from them. | BR-CART-002 | P1 | MVP |
| FR-CART-013 | Limits | A cart shall hold at most 30 distinct lines and 50 total units; order value ≤ BR-PRICE-011 cap. | `CART_LIMIT_EXCEEDED` | P1 | MVP |

### 6.7 Pricing & coupons (FR-PRICE, FR-COUP)

#### FR-PRICE-001 — Price computation  [P0 · MVP]
- **Behavior:** The pricing module shall compute, as a pure function of (cart snapshot, branch config, menu prices, address/distance, zone surge, active promotions, coupon, tip, fee/tax config version, customer facts such as order count), a breakdown with integer paise amounts:
  1. `itemsSubtotal` = Σ line (unit price incl. variant & option deltas, after item-level discount) × qty.
  2. `promotionDiscount` (automatic promotion, at most one — BR-COUPON-005).
  3. `couponDiscount` (BR-COUPON-001..004), capped and never exceeding the eligible subtotal.
  4. `packagingFee` (BR-PRICE-006), `deliveryFee` (BR-PRICE-003, after free-delivery offers), `surgeFee` (BR-PRICE-007), `smallOrderFee` (BR-PRICE-004), `platformFee` (BR-PRICE-005).
  5. `taxes[]` per tax rule (BR-PRICE-009) with base and rate.
  6. `tip` (BR-PRICE-008).
  7. `walletApplied` (if chosen, ≤ payable).
  8. `total` = sum, `payable` = total − walletApplied.
  9. Discount **funding split** (platform vs restaurant) per discount line, for settlement.
- **Rules:** BR-PRICE-001 (order of operations), BR-PRICE-002 (rounding: each line amount rounded half-up to the paisa once; percentages computed in basis points with integer math; final total rounded to the rupee only for COD collection display — never altering payable).
- **Post:** breakdown + `pricingVersion` + config version IDs (stored on the checkout session and order).
- **Non-functional:** deterministic: identical inputs produce identical outputs (unit-tested with property tests).

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-PRICE-002 | No client prices | The system shall ignore any price, discount, fee, tax or total sent by a client; such fields in requests are rejected by strict schemas. | DC-03 | P0 | MVP |
| FR-PRICE-003 | Minimum order | The system shall block checkout when itemsSubtotal (after item discounts, before coupon) is below the branch minimum order amount. | `ORDER_BELOW_MINIMUM` | P0 | MVP |
| FR-PRICE-004 | Maximum order | The system shall block checkout above the branch maximum or platform cap (BR-PRICE-011). | `ORDER_ABOVE_MAXIMUM` | P1 | MVP |
| FR-PRICE-005 | Price change notice | If the checkout quote differs from the last preview the customer saw (`expectedTotal` sent by client is used only for comparison), the system shall return `PRICE_CHANGED` with old/new breakdown and require re-confirmation. | Never charge a different amount than confirmed | P0 | MVP |
| FR-COUP-001 | List coupons | The system shall list coupons applicable to the customer for a given branch/cart, showing eligible ones first and ineligible ones with the reason (e.g., "Add ₹80 more"). | Only `visibility=PUBLIC` or user-targeted | P1 | MVP |
| FR-COUP-002 | Validate coupon | The system shall validate a coupon against: active window, zone, branch/restaurant scope, min subtotal, payment-method restriction, user segment (new user, specific users), global and per-user usage limits (counting reserved + redeemed), stacking rules. | BR-COUPON-001..008; `COUPON_*` errors | P0 | MVP |
| FR-COUP-003 | Coupon details | The system shall return coupon terms: description, discount type (FLAT, PERCENT, FREE_DELIVERY), value, cap, min order, validity, usage limits remaining for the user, applicable restaurants. | — | P1 | MVP |
| FR-COUP-004 | Reservation | On order creation the system shall reserve one redemption (status RESERVED) in the same transaction, enforcing limits with a row lock on the coupon counter; RESERVED becomes REDEEMED on payment success/COD placement and RELEASED on payment failure/expiry/cancellation-before-acceptance. | BR-COUPON-006 | P0 | MVP |
| FR-COUP-005 | Expiry during checkout | A coupon valid at session creation but expired at order confirmation shall cause `COUPON_EXPIRED` and a re-quote. | BR-COUPON-008 | P0 | MVP |

### 6.8 Checkout (FR-CHK)

#### FR-CHK-001 — Create checkout session  [P0 · MVP]
- **Actor:** Customer · **Trigger:** taps "Proceed to checkout" / changes address, tip, coupon or payment method on checkout page.
- **Pre:** non-empty valid cart; phone verified (BR-AUTH-002); profile complete.
- **Behavior:**
  1. The system shall accept `cartId`, `addressId`, `paymentMethod` (ONLINE, COD, WALLET, WALLET_PLUS_ONLINE), `tipAmount`, `useWallet`, `deliveryInstructions`, `contactless`.
  2. It shall revalidate the cart (FR-CART-010), check address serviceability for the branch (BR-GEO-001), check the branch is accepting orders now and will be open for at least the estimated prep time (BR-REST-004), check COD eligibility (BR-PAY-002) if chosen.
  3. It shall compute the quote (FR-PRICE-001), compute delivery ETA (FR-CHK-004), and persist a checkout session (status `OPEN`, expires in 10 min — BR-ORDER-001) containing the cart snapshot hash, quote, address snapshot, config versions.
  4. Subsequent changes on the checkout page update the same session (re-quote) while `OPEN`.
- **Post:** session with quote; no inventory or coupon reserved yet.
- **Errors:** `CART_EMPTY`, `CART_INVALID` (details), `ADDRESS_NOT_SERVICEABLE`, `BRANCH_NOT_ACCEPTING_ORDERS`, `ORDER_BELOW_MINIMUM`, `COD_NOT_AVAILABLE`, `COUPON_*`, `AUTH_VERIFICATION_REQUIRED`.

#### FR-CHK-002 — Confirm checkout and create order  [P0 · MVP]
- **Actor:** Customer · **Trigger:** "Place order"/"Pay ₹X".
- **Pre:** session `OPEN` and unexpired; request carries `Idempotency-Key` (UUID) and `expectedPayable`.
- **Behavior:**
  1. The system shall enforce idempotency (FR-ORDER-002): a repeated key with the same body returns the original result; same key with a different body → `409 IDEMPOTENCY_KEY_REUSED`.
  2. Within one transaction it shall: lock the session row; verify cart snapshot hash still matches the cart (else `CART_CHANGED`); re-run all validations and recompute the quote; if `payable` ≠ `expectedPayable` → `PRICE_CHANGED` (no order created).
  3. It shall create the order (FR-ORDER-001) with item/price/address snapshots, reserve coupon redemption (FR-COUP-004), decrement tracked stock (BR-MENU-006), debit wallet amount into a hold (wallet ledger HOLD) if used, mark session `CONFIRMED`, mark cart `CONVERTED`.
  4. For COD or fully-wallet-paid orders: order status → `PLACED`, restaurant is notified (EVT-REST-001).
  5. For ONLINE (or wallet+online) orders: order status → `PAYMENT_PENDING`, create a payment and provider order (FR-PAY-002) **after** commit (outbox), and return provider checkout parameters. If provider order creation fails, the order stays `PAYMENT_PENDING` and the client may retry payment initiation (FR-PAY-005); the payment-pending TTL job still applies.
- **Post:** exactly one order per idempotency key and per checkout session (unique constraint `orders.checkout_session_id`).
- **Errors:** `CHECKOUT_SESSION_EXPIRED`, `CHECKOUT_SESSION_CONSUMED` (returns existing order ID), `CART_CHANGED`, `PRICE_CHANGED`, `ITEM_UNAVAILABLE`, `BRANCH_NOT_ACCEPTING_ORDERS`, `COUPON_EXPIRED`, `COUPON_LIMIT_REACHED`, `INSUFFICIENT_WALLET_BALANCE`, `IDEMPOTENCY_KEY_REUSED`.

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-CHK-003 | Tip | The system shall allow a tip from presets (₹10, ₹20, ₹30) or custom (₹0–₹500 in whole rupees), changeable until order confirmation; post-delivery tip is CORE. | BR-PRICE-008 | P1 | MVP |
| FR-CHK-004 | Delivery ETA quote | The system shall show an ETA range at checkout computed as FR-DISC-010 with the actual address distance and current dispatch load factor. | — | P0 | MVP |
| FR-CHK-005 | Contact details | The system shall default the order contact to the address contact (or profile), allowing override of name/phone for this order (e.g., ordering for someone else). | Phone E.164 | P1 | MVP |
| FR-CHK-006 | Delivery instructions | The system shall accept delivery instructions (≤ 200 chars) and flags: contactless (leave at door; prepaid only), avoid calling, don't ring bell. | Contactless requires prepaid (BR-DEL-009) | P1 | MVP |
| FR-CHK-007 | Payment method selection | The system shall present only payment methods enabled for the zone, order value, and customer (COD rules). | BR-PAY-001/002 | P0 | MVP |
| FR-CHK-008 | Order confirmation screen | After placement (or payment success), the customer shall see the order number, ETA, summary, and a link to live tracking. | — | P0 | MVP |

### 6.9 Payments (customer-facing) — see Section 11 for full payment requirements.

| ID | Title | Requirement | Pri | Rel |
|---|---|---|---|---|
| FR-CPAY-001 | Pay online | The customer shall complete online payment via the provider's hosted checkout/SDK (UPI intent/collect, cards, netbanking); the client never sends card details to the API. | P0 | MVP |
| FR-CPAY-002 | Payment pending UX | While the payment is being confirmed, the app shall show "Confirming payment" and poll the order status (every 3 s, max 2 min) in addition to listening for socket events. | P0 | MVP |
| FR-CPAY-003 | Retry payment | If payment fails while the order is `PAYMENT_PENDING` and unexpired, the customer shall be able to retry with the same or another online method. | P0 | MVP |
| FR-CPAY-004 | Payment history | The customer shall view their payments and refunds with status, method (masked), amount, date, and order link. | P1 | MVP |
| FR-CPAY-005 | Wallet | The customer shall view wallet balance, credit history (source, expiry), and apply wallet credits at checkout. | P1 | MVP |

### 6.10 Orders, tracking, post-order (FR-CORD)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-CORD-001 | Active orders | The system shall return the customer's non-terminal orders with status, ETA, and restaurant, for a persistent "Track order" banner. | — | P0 | MVP |
| FR-CORD-002 | Order history | The system shall return the customer's orders (cursor-paginated, newest first) with filters (status group, date range). | — | P0 | MVP |
| FR-CORD-003 | Order details | The system shall return order snapshot: items with customizations and prices as charged, price breakdown, address snapshot, payment summary, refund summary, status timeline with timestamps, partner first name & photo & vehicle (while active), review state. | Own orders only (404 otherwise) | P0 | MVP |
| FR-CORD-004 | Live tracking | The system shall provide real-time order status, partner location (from assignment until delivery), and ETA updates via socket room `order:{id}` (EVT-ORD-*, EVT-TRK-*), and a REST snapshot endpoint for initial load/reconnect. | §13; BR-DEL-012 privacy | P0 | MVP |
| FR-CORD-005 | Tracking map | The tracking page shall display a map with restaurant, destination, and partner markers, the partner's last location age ("updated 12 s ago"), and route polyline where available. | Leaflet/OSM | P1 | MVP |
| FR-CORD-006 | Delivery OTP display | For orders requiring OTP handover, the tracking page shall show the 4-digit delivery code once a partner is assigned. | BR-DEL-009 | P0 | MVP |
| FR-CORD-007 | Cancel order | The customer shall be able to cancel an order when permitted by BR-ORDER-010..013; the UI shall show the applicable fee/refund before confirmation. | FR-ORDER-020 | P0 | MVP |
| FR-CORD-008 | Reorder | The system shall create a new cart from a past order's lines, re-validating availability and using **current** prices; unavailable lines are reported and skipped. | BR-ORDER-018; cart conflict rules apply | P1 | MVP |
| FR-CORD-009 | Invoice | The system shall generate a tax invoice (PDF) for delivered orders containing restaurant legal name, GSTIN, FSSAI, platform details (as e-commerce operator), itemized amounts, taxes, invoice number (sequential per financial year). | BR-ORDER-019; legal review | P1 | MVP |
| FR-CORD-010 | Report issue | Within 48 h after delivery (or for any active order), the customer shall be able to report an issue (missing item, wrong item, quality, spillage, late, not delivered, payment issue, other) selecting affected items and attaching up to 3 photos; this creates a support ticket linked to the order. | BR-SUP-002 | P0 | MVP |
| FR-CORD-011 | Refund request | Issue reports for missing/wrong/damaged items shall allow requesting a refund for selected items; the system may auto-approve per BR-REFUND-006 (low-value, good-standing customers) or route to support. | BR-REFUND-* | P1 | MVP |
| FR-CORD-012 | Delivery confirmation | When the partner marks delivered, the customer shall receive confirmation; the customer may report "not delivered" within 1 h, which opens a priority ticket. | — | P1 | MVP |

### 6.11 Reviews & ratings (FR-REV)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-REV-001 | Rate restaurant | After DELIVERED, the customer shall rate the restaurant 1–5 with optional text (≤ 1000 chars) and up to 3 photos, and tags (taste, portion, packaging, value). | BR-REVIEW-001..003 | P0 | MVP |
| FR-REV-002 | Rate delivery | The customer shall rate the delivery partner 1–5 with tags (polite, on time, followed instructions, rude, late); partner sees only aggregate and anonymized feedback. | BR-REVIEW-006 | P0 | MVP |
| FR-REV-003 | Rate items | The customer shall rate individual items (thumbs up/down). | — | P2 | CORE |
| FR-REV-004 | Edit / delete review | The customer shall edit a review within 48 h and delete own review at any time (soft delete). | BR-REVIEW-003 | P1 | MVP |
| FR-REV-005 | Report review | Any signed-in user and restaurants shall be able to report a review (spam, abusive, irrelevant, fake) for moderation. | Duplicate reports collapse | P2 | CORE |
| FR-REV-006 | Rating aggregation | The system shall maintain restaurant/branch rating average and count (published reviews only), updated asynchronously within 1 minute (JOB-REV-001), and display a Bayesian-smoothed rating with "New" when count < 10. | — | P0 | MVP |
| FR-REV-007 | Review prompt | The system shall prompt for a review 30 min after delivery (in-app + push if enabled), once per order. | — | P2 | CORE |

### 6.12 Favorites (FR-FAV)

| ID | Title | Requirement | Pri | Rel |
|---|---|---|---|---|
| FR-FAV-001 | Favorite restaurant | The customer shall add/remove a restaurant (brand) as favorite (idempotent). | P1 | MVP |
| FR-FAV-002 | Favorite food | The customer shall add/remove a food item as favorite (idempotent). | P2 | CORE |
| FR-FAV-003 | List favorites | The system shall list favorites with current serviceability/availability for the customer's location. | P1 | MVP |

### 6.13 Support & complaints (customer) (FR-CSUP)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-CSUP-001 | Help center | The customer app shall show FAQ topics and order-specific help entry points. FAQ content managed by admins. | — | P1 | MVP |
| FR-CSUP-002 | Create ticket | The customer shall create a support ticket (category, description, optional order, attachments). | Rate limit 5/day | P0 | MVP |
| FR-CSUP-003 | Ticket conversation | The customer shall view ticket status and exchange messages with support; new messages notify both sides. | — | P0 | MVP |
| FR-CSUP-004 | Close / reopen | The customer shall close a ticket or reopen it within 7 days of resolution. | BR-SUP-003 | P2 | CORE |
| FR-CSUP-005 | CSAT | On resolution, the customer shall be able to rate the support experience (1–5). | — | P3 | CORE |
| FR-CSUP-006 | Grievance officer | The app shall display the grievance officer's name and contact as required by applicable e-commerce rules. | Legal review (OD-15) | P0 | MVP |

---

## 7. Restaurant Functional Requirements

Restaurant member roles and their default permissions are defined in `docs/architecture/SYSTEM-ARCHITECTURE.md` §7.3 (permission matrix). "Owner/Manager" below means a member whose role grants the stated permission for the branch in scope.

### 7.1 Onboarding & verification (FR-REST-ONB)

#### FR-REST-001 — Restaurant registration  [P0 · MVP]
- **Actor:** Guest → user registered via restaurant app (FR-AUTH-001).
- **Behavior:**
  1. The system shall let a verified user start a restaurant application (status `DRAFT`) capturing: brand name, legal entity name, entity type (proprietorship, partnership, LLP, private limited, other), business PAN, GSTIN (optional if exempt with declaration — BR-REST-005), FSSAI license number & expiry, contact person, email, phone, cuisines, description.
  2. It shall capture the first branch: address, map pin (coordinates), delivery radius (≤ BR-GEO-002 max), operating hours, average prep time, price-for-two, pure-veg flag.
  3. It shall capture bank account details (account holder, account number — stored encrypted, IFSC) — displayed masked thereafter.
  4. It shall require document uploads: FSSAI certificate, PAN card, GST certificate (if GSTIN), cancelled cheque/bank proof, menu (optional photo/PDF), logo.
  5. The user may save progress at any step; on **submit**, the system shall validate completeness and formats (GSTIN checksum, PAN pattern, IFSC pattern, FSSAI 14 digits), set status `SUBMITTED`, create the OWNER membership, and notify admins (EVT-ADM-002).
- **Errors:** `VALIDATION_ERROR`, `ONBOARDING_INCOMPLETE` (list of missing items), `DUPLICATE_FSSAI` / `DUPLICATE_GSTIN` (flag for review rather than block if same legal entity adding a brand — admin decides).

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-REST-002 | Verification status | The owner shall see application status (DRAFT, SUBMITTED, UNDER_REVIEW, CHANGES_REQUESTED, APPROVED, REJECTED) with admin comments per field/document. | State machine `restaurant_onboarding` | P0 | MVP |
| FR-REST-003 | Resubmission | On CHANGES_REQUESTED, the owner shall edit requested fields/documents and resubmit; history of submissions retained. | BR-REST-008 | P0 | MVP |
| FR-REST-004 | Approval effect | On approval the system shall activate the restaurant & first branch (branch status `ACTIVE`, but `isAcceptingOrders=false` until the owner opens it and the go-live checklist passes — BR-REST-006), grant the RESTAURANT_OWNER platform role, and notify the owner. | — | P0 | MVP |
| FR-REST-005 | Rejection | On rejection the owner shall see the reason; may re-apply after 30 days or as admin permits. | BR-REST-007 | P0 | MVP |
| FR-REST-006 | Document expiry | The system shall track document expiry (FSSAI) and notify the owner 30/7/1 days before expiry; on expiry the restaurant is auto-paused until renewed document is verified. | JOB-REST-003, BR-REST-011 | P1 | CORE |

### 7.2 Restaurant & branch management (FR-REST)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-REST-010 | Update profile | Owner shall update description, cuisines, logo, cover image, contact; legal/tax/bank changes require re-verification by admin (field-level change request) and step-up auth. | BR-REST-012 | P0 | MVP |
| FR-REST-011 | Branches | Owner shall create, update, deactivate branches (address, pin, radius, hours, prep time, min/max order, packaging fee config within caps); new branches require admin approval before accepting orders. | BR-REST-013 | P1 | CORE |
| FR-REST-012 | Operating hours | Owner/Manager shall define weekly hours per branch: up to 3 slots per weekday, slots may cross midnight, timezone Asia/Kolkata. | BR-REST-003 | P0 | MVP |
| FR-REST-013 | Holidays | Owner/Manager shall add holiday closures (date or date-time range, reason); closures override hours. | — | P1 | MVP |
| FR-REST-014 | Open / close now | Owner/Manager/Order manager shall toggle the branch "online/offline" for today (manual close persists until manual open or next day's first slot — configurable). | Audit | P0 | MVP |
| FR-REST-015 | Pause orders | Manager/Order manager shall pause new orders for 15/30/45/60 min or until resumed, with reason (busy kitchen, out of ingredients, staff shortage); auto-resume at expiry (JOB-REST-001). In-flight orders unaffected. | BR-REST-002 | P0 | MVP |
| FR-REST-016 | Prep time | Manager shall set the default prep time (5–90 min) and a temporary rush adder (+10/+20/+30 min for up to 2 h). | Affects ETA | P1 | MVP |
| FR-REST-017 | Delivery settings | Owner shall set delivery radius (≤ max), min order amount, max order amount (≤ platform cap). | BR-GEO-002, BR-PRICE-010/011 | P0 | MVP |
| FR-REST-018 | Status visibility | The restaurant dashboard shall show the current effective status and why (e.g., "Closed — outside hours", "Paused until 19:30", "Suspended by admin"). | — | P0 | MVP |
| FR-REST-019 | Auto-pause on missed orders | The system shall auto-pause a branch for 30 min after 3 consecutive acceptance timeouts and notify the owner/manager by SMS. | BR-REST-009 | P0 | MVP |
| FR-REST-020 | Closing soon | The system shall stop accepting new orders at `closingTime − branch prep time` (last order cutoff) | BR-REST-004 | P0 | MVP |

### 7.3 Menu management (FR-MENU)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-MENU-001 | Categories CRUD | Owner/Manager shall create, rename, describe, enable/disable, and delete categories; delete requires the category to be empty or a target category for its items. | BR-MENU-008 | P0 | MVP |
| FR-MENU-002 | Reorder categories | Owner/Manager shall reorder categories and items within a category (drag-and-drop; persisted as integer positions). | Atomic reorder | P1 | MVP |
| FR-MENU-003 | Create item | Owner/Manager shall create an item: name, description, category, base price, optional discounted price, dietary marker (required), tags, allergens, ingredients, serving size, prep time, images (≤ 5), flags (bestseller, recommended, today's special, featured), packaging fee override. | BR-MENU-001, 002, 005 | P0 | MVP |
| FR-MENU-004 | Edit item | Owner/Manager shall edit any item field; price changes apply to new carts/quotes immediately but never to placed orders (snapshots). Changes bump menu version. | — | P0 | MVP |
| FR-MENU-005 | Delete item | Owner/Manager shall soft-delete an item; it disappears from menus and cannot be added; carts containing it flag the line unavailable. | — | P0 | MVP |
| FR-MENU-006 | Variants | Owner/Manager shall define variants (e.g., Half/Full, Regular/Medium/Large) each with its own price; one default variant. | BR-MENU-004 | P0 | MVP |
| FR-MENU-007 | Customization groups | Owner/Manager shall create reusable customization groups (name, min, max, required, display order) with options (name, price delta ≥ 0, dietary marker, default selected, availability) and attach groups to items (optionally per variant). Examples: spice level, add-ons, crust, extra cheese. | BR-MENU-003 | P0 | MVP |
| FR-MENU-008 | Availability toggle | Owner/Manager/Order manager shall mark an item or option in/out of stock per branch, optionally "until end of day" or "until time". | BR-MENU-007; auto-restore JOB-MENU-001 | P0 | MVP |
| FR-MENU-009 | Stock counts | Manager shall optionally set a stock count per item per branch; stock decrements on order creation, restores on cancellation before preparation; reaching 0 marks out of stock. | BR-MENU-006 | P2 | CORE |
| FR-MENU-010 | Scheduled availability | Owner/Manager shall set item/category availability schedules (e.g., breakfast 07:00–11:00, weekdays only). | BR-MENU-007 | P2 | CORE |
| FR-MENU-011 | Combos | Owner/Manager shall create combo items composed of other items (fixed quantities, optional choice groups) with a combo price. | BR-MENU-009 | P2 | CORE |
| FR-MENU-012 | Item discounts | Owner/Manager shall set an item discounted price or percentage with optional schedule. | BR-MENU-005 | P1 | MVP |
| FR-MENU-013 | Bulk operations | Owner/Manager shall bulk toggle availability and bulk update prices (by %) for selected items; changes previewed before apply. | Audit | P2 | CORE |
| FR-MENU-014 | Menu import | Owner shall import a menu from a CSV template with row-level validation report; nothing is applied if any row fails (all-or-nothing). | — | P3 | ADV |
| FR-MENU-015 | Menu moderation | Admins shall be able to hide an item that violates policy (e.g., prohibited items) with reason; the restaurant is notified. | Audit | P2 | CORE |

### 7.4 Promotions (restaurant-funded) (FR-RPROMO)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-RPROMO-001 | Create promotion | Owner shall create an automatic promotion: percentage or flat off on subtotal ≥ threshold, with cap, schedule, branch scope, new-customer-only option; requires admin approval if discount > 50 %. | BR-COUPON-005, BR-PROMO-001 | P1 | CORE |
| FR-RPROMO-002 | Item offers | Owner shall create "Buy X get Y" or item-level offers. | — | P3 | ADV |
| FR-RPROMO-003 | Promotion performance | Owner shall see redemptions, discount cost, and incremental orders per promotion. | — | P2 | CORE |

### 7.5 Order handling (FR-RORD)

#### FR-RORD-001 — Receive new order  [P0 · MVP]
- **Actor:** System → restaurant members with `order:read` for the branch.
- **Behavior:** When an order enters `PLACED`, the system shall (1) emit `EVT-REST-001 order.new` to room `branch:{id}:orders`; (2) play a repeating audible alert in the restaurant app until the order is acknowledged/accepted (browser autoplay requires prior user interaction — app requires one click "Start receiving orders" per session); (3) send a push notification and, if not accepted within 2 min, an SMS/IVR reminder (BR-ORDER-004) to the branch's on-duty contact; (4) start the acceptance timeout job (JOB-ORD-002).
- **Post:** order visible in "New" queue with countdown.

#### FR-RORD-002 — Accept order  [P0 · MVP]
- **Behavior:** The system shall allow a member with `order:accept` to accept a `PLACED` order, optionally adjusting prep time within ±50 % of default (5–90 min). It shall transition `PLACED → ACCEPTED` with a row lock and version check (concurrent accept by two staff → exactly one succeeds; the other receives `409 ORDER_STATE_CONFLICT` with current state), cancel the timeout job, compute `readyBy`, trigger dispatch scheduling (FR-DISP-001), and notify the customer (EVT-ORD-002).
- **Errors:** `ORDER_STATE_CONFLICT`, `ORDER_NOT_FOUND`, `FORBIDDEN`.

#### FR-RORD-003 — Reject order  [P0 · MVP]
- **Behavior:** The system shall allow rejecting a `PLACED` order with a mandatory reason (ITEM_UNAVAILABLE with item IDs, KITCHEN_BUSY, CLOSING, ADDRESS_ISSUE, OTHER + text). It shall transition to `REJECTED`, trigger full refund (BR-REFUND-001), release coupon & stock, notify the customer, and — for ITEM_UNAVAILABLE — mark the named items out of stock for the branch (with confirmation). Rejection counts toward the restaurant's rejection rate (analytics, BR-REST-014).

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-RORD-004 | Start preparing | Member with `order:prepare` shall move `ACCEPTED → PREPARING` (auto after 1 min if not done — configurable `cfg.order.autoPreparingAfter`). | Transition table §10 | P0 | MVP |
| FR-RORD-005 | Update prep time | Member shall extend the prep time once by up to +20 min with reason; customer ETA updates and customer is notified if delta ≥ 10 min. | BR-ORDER-005 | P1 | MVP |
| FR-RORD-006 | Mark ready | Member with `order:prepare` shall mark `PREPARING → READY_FOR_PICKUP`; partner and customer are notified. | — | P0 | MVP |
| FR-RORD-007 | Handover | When the assigned partner confirms pickup (FR-DEL-025), the restaurant view shall show "Handed over" with the partner's name; restaurant staff can also confirm handover by entering the partner's pickup code (4 chars shown on partner app) — required when `cfg.pickup.verifyCode=true`. | BR-DEL-008 | P1 | MVP |
| FR-RORD-008 | Order queue views | Restaurant app shall show tabs: New, Preparing (incl. Accepted), Ready, Picked up (today), Completed (today), Cancelled/Rejected (today), with counts, live updates, and sound alerts. | — | P0 | MVP |
| FR-RORD-009 | Order details (restaurant) | Shall show order number, placed time, items with variants/customizations & quantities, cooking instructions, cutlery preference, order value (restaurant share), payment status (PAID/COD), delivery partner status & ETA to restaurant, timeline. Customer last name initial only; full address hidden (area only), phone hidden (support relay). | Data minimization §20 | P0 | MVP |
| FR-RORD-010 | Kitchen Display | A full-screen KDS view for KITCHEN role shall show tickets (no prices/customer data) in columns by status, elapsed-time coloring (green < 50 % of prep time, amber < 100 %, red > 100 %), large touch targets to bump status, auto-reconnect, and continues showing last state with an "Offline" banner during disconnects. | NFR-UX-006 | P1 | MVP |
| FR-RORD-011 | Print KOT | Restaurant app shall print a kitchen order ticket via browser print (80 mm thermal layout). | — | P2 | CORE |
| FR-RORD-012 | Restaurant cancels after accept | Owner/Manager shall cancel an accepted/preparing order only with a reason; full refund to customer; restaurant penalty per BR-REST-015; requires confirmation dialog. | BR-ORDER-015 | P1 | MVP |
| FR-RORD-013 | Partner delay visibility | If the assigned partner's ETA to restaurant exceeds ready time by > 10 min, the restaurant view shall show the delay; if no partner assigned 10 min after ready, ops alert fires (EVT-ADM-005). | — | P1 | MVP |
| FR-RORD-014 | Order history & search | Members shall search past orders by order number/date/status for their branches (90 days in app; older via reports). | — | P1 | MVP |
| FR-RORD-015 | Item issue report response | Restaurants shall view complaints about their orders and respond with a statement within 48 h (CORE). | — | P2 | CORE |

### 7.6 Staff management (FR-RSTAFF)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-RSTAFF-001 | Invite member | Owner (and Manager for roles below Manager) shall invite by phone/email with role (MANAGER, ORDER_MANAGER, KITCHEN, STAFF) and branch scope; invitation token valid 7 days; accepting requires sign-in/registration. | Cannot grant role ≥ own | P1 | MVP |
| FR-RSTAFF-002 | Manage members | Owner shall change roles/branch scope, suspend, and remove members; removal revokes the member's restaurant-app sessions' access within 30 s (permission version bump). | FR-AUTH-024; audit | P1 | MVP |
| FR-RSTAFF-003 | Custom permissions | Owner shall grant/revoke individual restaurant permissions on top of role defaults. | — | P3 | ADV |
| FR-RSTAFF-004 | Activity log | Owner/Manager shall view member activity (accept/reject/ready, menu changes, status toggles) for their branches. | Audit-derived | P2 | CORE |
| FR-RSTAFF-005 | Ownership transfer | Owner shall transfer ownership to another member; requires step-up auth and admin approval. | — | P3 | CORE |
| FR-RSTAFF-006 | Kitchen device login | Owner/Manager shall create a KDS device session (QR pairing) bound to a branch and KITCHEN role without personal accounts. | Device session rules ADR-003 | P2 | CORE |

### 7.7 Analytics, finance, reviews (FR-RANL, FR-RFIN, FR-RREV)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-RANL-001 | Dashboard | The restaurant dashboard shall show for selected branch(es) and today: orders by status, revenue (gross food value and net payable), AOV, acceptance rate, avg acceptance time, avg prep time, rating, current status — live-updating. | Values from real data only; empty states if none | P0 | MVP |
| FR-RANL-002 | Periodic metrics | Shall show daily/weekly/monthly revenue, order count, cancellation & rejection rate, AOV, new vs repeat customers, with period comparison. | Pre-aggregated hourly (JOB-ANL-001) | P1 | MVP |
| FR-RANL-003 | Top items & categories | Shall show top items by quantity and revenue, sales by category. | — | P1 | MVP |
| FR-RANL-004 | Peak hours | Shall show orders by hour-of-day × weekday heatmap. | — | P2 | CORE |
| FR-RANL-005 | Branch comparison | Owner shall compare branches on the above metrics. | — | P2 | CORE |
| FR-RANL-006 | Reports export | Owner shall export order and settlement reports (CSV) for a date range ≤ 1 year (async job, emailed link). | JOB-RPT-001 | P2 | CORE |
| FR-RFIN-001 | Settlement statements | Owner shall view settlement periods: gross order value, restaurant-funded discounts, commission, taxes (TCS/TDS lines as legally required — legal review), adjustments (refund recoveries, penalties), net payout, payout status & UTR. | BR-COMM-001..003 | P0 | MVP |
| FR-RFIN-002 | Order-level earnings | Owner shall drill down from a settlement to per-order earnings breakdown. | — | P1 | MVP |
| FR-RFIN-003 | Bank details | Owner shall view masked bank details and request change (re-verification, payouts held until verified). | Step-up auth | P1 | MVP |
| FR-RFIN-004 | Invoices from platform | Owner shall download monthly commission invoices issued by the platform. | Legal review | P2 | CORE |
| FR-RREV-001 | View reviews | Members with `review:read` shall view reviews for their branches with filters. | — | P1 | MVP |
| FR-RREV-002 | Respond | Owner/Manager shall post one public response per review (editable within 24 h). | BR-REVIEW-005 | P2 | MVP |
| FR-RREV-003 | Report review | Owner/Manager shall report a review for moderation. | FR-REV-005 | P2 | CORE |
| FR-RNOT-001 | Restaurant notifications | Restaurant members shall receive notifications for new orders, cancellations, partner arrival, low rating (≤ 2), approval outcomes, document expiry, settlement paid. | FR-NOTIF-* | P0 | MVP |

---

## 8. Delivery Partner Functional Requirements

### 8.1 Onboarding (FR-DP-ONB)

#### FR-DP-001 — Partner registration & application  [P0 · MVP]
- **Behavior:** 1) A user registered via the delivery app (phone OTP mandatory) shall complete an application: full legal name, date of birth (≥ 18 — BR-DEL-016), profile photo (live capture preferred), address, preferred zone, vehicle type (BICYCLE, E_BIKE, MOTORCYCLE, SCOOTER), vehicle registration number (motorized), driving license number & expiry (motorized), PAN, Aadhaar **last 4 digits only** + document image with masking guidance (full Aadhaar number never stored — §20), bank account (holder, number encrypted, IFSC), emergency contact (name, relation, phone). 2) Documents: DL (front/back) for motorized, RC, vehicle insurance (motorized), PAN, ID proof, bank proof. 3) On submit → `SUBMITTED`; admins notified.
- **Errors:** `VALIDATION_ERROR`, `ONBOARDING_INCOMPLETE`, `AGE_REQUIREMENT_NOT_MET`.

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-DP-002 | Verification status | Partner shall see status (DRAFT, SUBMITTED, UNDER_REVIEW, CHANGES_REQUESTED, APPROVED, REJECTED, SUSPENDED) with per-document feedback. | — | P0 | MVP |
| FR-DP-003 | Approval effect | On approval the system shall grant DELIVERY_PARTNER role, create earnings & cash ledgers, assign the home zone, and allow going online. | — | P0 | MVP |
| FR-DP-004 | Profile | Partner shall view/update profile photo (re-verification), phone (OTP), emergency contact, preferred zone; legal fields locked after approval (change via support). | — | P1 | MVP |
| FR-DP-005 | Vehicles | Partner shall manage vehicles (one active); changing the active vehicle to a motorized type requires verified DL/RC. | BR-DEL-017 | P1 | MVP |
| FR-DP-006 | Document expiry | The system shall notify partners before DL/insurance expiry and block going online after expiry until re-verified. | JOB-DP-002 | P1 | CORE |
| FR-DP-007 | Training acknowledgment | Partner shall acknowledge safety & conduct guidelines (versioned) before first going online. | — | P2 | MVP |

### 8.2 Availability (FR-DP-AV)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-DP-010 | Go online | Partner shall go online only if: approved, not suspended, documents valid, location permission granted and a fresh fix (≤ 60 s, accuracy ≤ 100 m) sent, inside an active zone, cash-in-hand below cap (BR-DEL-010). Otherwise a specific reason is returned. | `PARTNER_CANNOT_GO_ONLINE` + reason | P0 | MVP |
| FR-DP-011 | Go offline | Partner shall go offline any time **without** an active delivery; with an active delivery, the request is queued as "offline after current delivery". Pending offers are withdrawn. | BR-DEL-006 | P0 | MVP |
| FR-DP-012 | Pause | Partner shall pause (break) for 15/30 min — no new offers, stays logged in; auto-resume. | — | P2 | CORE |
| FR-DP-013 | Availability tracking | The system shall maintain availability state (OFFLINE, ONLINE_IDLE, OFFERED, ON_DELIVERY, PAUSED) in Redis (authoritative copy in DB on transitions) and record online sessions (start/end) for incentives and analytics. | — | P0 | MVP |
| FR-DP-014 | Auto-offline | The system shall set a partner offline when: no location update for 5 min while ONLINE_IDLE (heartbeat lost), 3 consecutive offers expire unanswered, or the partner leaves all active zones for > 10 min. Partner is notified. | BR-DEL-006 | P0 | MVP |
| FR-DP-015 | Session time | Partner dashboard shall show today's online time, deliveries, earnings. | — | P1 | MVP |

### 8.3 Assignments & delivery workflow (FR-DEL)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-DEL-001 | Receive offer | When dispatched (§12), the partner shall receive an offer via socket (EVT-DP-001) and push (if app backgrounded), with a full-screen card showing: restaurant name & area, pickup distance from partner, drop distance (restaurant→customer area only, not exact address), estimated earnings, payment type (COD amount if COD), countdown (30 s), Accept/Reject. Audible alert. | BR-DEL-002 | P0 | MVP |
| FR-DEL-002 | Accept offer | Partner shall accept within the countdown; acceptance succeeds only if the offer is still OFFERED and the delivery has no accepted partner (FR-DISP-006 locking); on success partner state → ON_DELIVERY and full pickup details are revealed. | `OFFER_EXPIRED`, `OFFER_ALREADY_TAKEN` | P0 | MVP |
| FR-DEL-003 | Reject offer | Partner shall reject with optional reason (too far, vehicle issue, other); counts toward acceptance rate; dispatch moves to next candidate. | BR-DEL-004/005 | P0 | MVP |
| FR-DEL-004 | Offer timeout | If not answered in time the offer becomes EXPIRED (server-authoritative timer), counted as missed. | — | P0 | MVP |
| FR-DEL-005 | Offer withdrawn | If an order is cancelled or reassigned while offered, the partner's offer card shall close with message (EVT-DP-003). | — | P0 | MVP |
| FR-DEL-010 | Active delivery screen | Shall show stage-based UI: (1) To restaurant: restaurant name, address, map, navigate button (deep link to Google Maps/Apple Maps), order number, items count, pickup code; (2) At restaurant: "Arrived" then "Picked up" with item checklist; (3) To customer: customer first name, full address & instructions, call customer (MVP: direct number, ADV masked), navigate; (4) At customer: OTP entry / COD collection / proof photo. | Data visible only while assigned | P0 | MVP |
| FR-DEL-020 | Arrived at restaurant | Partner shall mark arrival; the system validates distance to branch ≤ 200 m (geofence; outside → warning requiring confirmation, flagged for review). Restaurant is notified. | BR-DEL-008 | P0 | MVP |
| FR-DEL-025 | Pickup confirmation | Partner shall confirm pickup when order is READY_FOR_PICKUP (or restaurant confirms handover); system transitions order → PICKED_UP, delivery → EN_ROUTE_TO_CUSTOMER, notifies customer with ETA. If the order is not ready, partner waits; wait time ≥ 10 min accrues wait pay (BR-EARN-001). | BR-DEL-008 | P0 | MVP |
| FR-DEL-026 | Arrived at customer | Partner shall mark arrival (geofence ≤ 150 m from drop pin; outside → confirmation + flag). Customer notified "Your order has arrived". | — | P0 | MVP |
| FR-DEL-030 | Delivery OTP verification | For orders with OTP handover, partner shall enter the 4-digit code; max 5 attempts, then fallback to support override. The code is generated at order placement, stored hashed, shown only to the customer. | BR-DEL-009 | P0 | MVP |
| FR-DEL-031 | Contactless proof | For contactless prepaid orders, partner shall upload a photo of the package at the door (camera capture only, no gallery) instead of OTP. | OD-16, BR-DEL-009 | P1 | MVP |
| FR-DEL-032 | COD collection | For COD orders, partner shall confirm cash collected (exact amount shown); system records cash-in-hand increase (ledger), and the order is complete. Partial or refused payment → partner selects "Customer refused" → support flow. | BR-DEL-010, BR-PAY-002 | P0 | MVP |
| FR-DEL-033 | Mark delivered | On successful verification the system shall transition order → DELIVERED and delivery → DELIVERED, compute partner earnings, release partner to ONLINE_IDLE (or OFFLINE if queued), notify customer & restaurant. | — | P0 | MVP |
| FR-DEL-034 | Customer unreachable | Partner shall report customer unreachable after arriving; system starts a 10-min wait timer with call attempts logged; support may extend/resolve; at expiry, support marks delivery FAILED (order → FAILED with reason CUSTOMER_UNREACHABLE; no refund for prepaid per BR-REFUND-001; COD not collected, customer COD-blocked flag increment). | BR-ORDER-020 | P1 | MVP |
| FR-DEL-035 | Partner cancels after accept | Partner shall be able to request unassignment with reason (accident, vehicle breakdown, emergency) before pickup; system unassigns, re-dispatches with priority, records against partner metrics (BR-DEL-013). After pickup, only support can reassign (with handover coordination). | — | P0 | MVP |
| FR-DEL-036 | SOS | Partner shall trigger SOS that alerts the ops team with current location and offers emergency number dialing. | — | P1 | CORE |
| FR-DEL-037 | Delivery history | Partner shall view past deliveries with date, restaurant, distance, earnings, rating received, status. | — | P1 | MVP |

### 8.4 Location tracking (FR-TRK)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-TRK-001 | Location updates | While ONLINE (any state), the delivery app shall send location updates via socket (`partner:location`): ON_DELIVERY every 5 s when moved > 10 m (else every 15 s heartbeat); ONLINE_IDLE every 30 s. Payload: lat, lng, accuracy, heading, speed, timestamp (device), battery level (optional). | BR-DEL-011 | P0 | MVP |
| FR-TRK-002 | No tracking offline | The app shall stop the geolocation watch when OFFLINE, and the server shall drop updates from offline partners. | Privacy | P0 | MVP |
| FR-TRK-003 | Validation | The server shall reject updates with accuracy > 100 m (stored as "low accuracy" heartbeat only), timestamps > 60 s in the past or in the future (> 10 s skew), or implied speed > 150 km/h from last point (flag spoofing). | BR-DEL-012 | P0 | MVP |
| FR-TRK-004 | Last-known location | The server shall store the latest valid location per partner in Redis GEO + hash (TTL 10 min) and persist sampled points (every 30 s, and all stage events) for active deliveries to `delivery_locations`. | Retention §20 | P0 | MVP |
| FR-TRK-005 | Stale detection | If no valid update for 60 s during an active delivery, the customer view shall show "Location updating…" with last-seen age; at 5 min, ops alert (EVT-ADM-006). | — | P0 | MVP |
| FR-TRK-006 | Customer fan-out | The server shall forward location to the order room at most every 3 s per order (throttled), only between partner assignment and delivery completion. | BR-DEL-012 | P0 | MVP |
| FR-TRK-007 | ETA updates | The server shall recompute customer ETA on each stage change and at most every 60 s during transit using the routing adapter (fallback heuristic), and emit EVT-TRK-002 when it changes by ≥ 2 min. | — | P1 | MVP |
| FR-TRK-008 | Offline buffering | When connectivity drops, the app shall buffer up to 5 min of points and send them on reconnect (marked `buffered=true`); only the newest is fanned out to customers. | — | P2 | CORE |

### 8.5 Earnings, wallet, payouts (FR-EARN)

| ID | Title | Requirement | Rules | Pri | Rel |
|---|---|---|---|---|---|
| FR-EARN-001 | Per-delivery earnings | On delivery completion the system shall compute earnings: base pay + distance pay + wait pay + surge/rain bonus + tip, recorded as ledger entries with a breakdown visible to the partner. | BR-EARN-001, 002 | P0 | MVP |
| FR-EARN-002 | Earnings views | Partner shall view earnings by day/week/month with breakdown (deliveries, distance, tips, incentives, adjustments). | — | P0 | MVP |
| FR-EARN-003 | Incentives | The system shall support incentive programs (e.g., "Complete 15 deliveries between 12–15h on weekdays → ₹200") with progress display and automatic crediting at period end. | BR-EARN-003, JOB-EARN-002 | P2 | CORE |
| FR-EARN-004 | Adjustments | Admins shall apply credit/debit adjustments with reason (e.g., penalty reversal); visible to partner. | Audit; maker-checker > ₹1000 | P1 | MVP |
| FR-EARN-005 | Cash-in-hand | Partner shall see COD cash-in-hand balance; deposits/remittances (bank deposit, UPI to platform, deduction from payout) recorded; when cap is reached partner cannot receive COD offers (then any offers). | BR-DEL-010, BR-EARN-006 | P0 | MVP |
| FR-EARN-006 | Payouts | Partner shall see payout history (period, amount, deductions, status, UTR) and next payout estimate. | BR-EARN-004, 005 | P0 | MVP |
| FR-EARN-007 | Ratings & performance | Partner shall see rating average, acceptance rate, completion rate, on-time rate (last 30 days). | — | P1 | MVP |
| FR-EARN-008 | Partner support | Partner shall create support tickets (payout issue, order issue, account issue) and chat with support. | FR-CSUP-002 analog | P1 | MVP |

---

## 9. Administrative Functional Requirements

Privilege levels: **[A]** Admin-level permission, **[S]** Super-admin only, **[SA]** Support agent permitted. **Audit:** all admin mutations are audit-logged (DC-05, BR-ADMIN-002); items marked **★** additionally require a mandatory reason and are flagged in the high-sensitivity audit stream; **⧉** marks maker-checker (two-person approval) in CORE.

| ID | Title | Requirement | Priv | Pri | Rel |
|---|---|---|---|---|---|
| FR-ADMIN-001 | Admin login | Admins authenticate only through the admin app with admin-app sessions (12 h absolute, 1 h idle), MFA per FR-AUTH-032, optional IP allowlist (`cfg.admin.ipAllowlist`). | — | P0 | MVP |
| FR-ADMIN-002 | Dashboard | Shall show live and today metrics: users (total, new), customers, restaurants (total, active now, pending approvals), partners (total, online now, on delivery), orders (active by state, completed, cancelled, rejected), GMV, platform revenue (fees + commission), refunds, pending payouts, and operational alerts (unassigned orders, stale partners, restaurants missing orders, payment reconciliation mismatches). | [A][SA] | P0 | MVP |
| FR-ADMIN-003 | Live operations map | Shall show online partners, active orders, and alert markers on a zone map, updating in real time. | [A] | P2 | CORE |
| FR-ADMIN-010 | Customer management | Search/view customers (profile, orders, payments, tickets, wallet, flags), suspend/unsuspend ★, force logout ★, adjust wallet credit ★⧉ (> ₹500), mark COD-blocked ★. PII fields masked by default; unmasking requires `pii:reveal` and is audit-logged. | [A][SA read] | P0 | MVP |
| FR-ADMIN-020 | Restaurant applications | View queue of submitted applications with SLA timers; review documents (signed URLs); approve, reject ★, or request changes with field-level comments. | [A] | P0 | MVP |
| FR-ADMIN-021 | Restaurant management | Search/view restaurants & branches, members, menu, performance, settlements, complaints; edit non-financial fields on owner's behalf (audit), set commission rate ★⧉, enable/disable COD per restaurant. | [A] | P0 | MVP |
| FR-ADMIN-022 | Restaurant verification of changes | Approve/reject owner change requests for legal/tax/bank details ★. | [A] | P0 | MVP |
| FR-ADMIN-023 | Restaurant suspension | Suspend/unsuspend a restaurant or branch ★ with reason and end date; suspension stops new orders immediately; in-flight orders continue unless "suspend and cancel active orders" ★ is chosen (refunds per BR-REFUND-001). | [A] | P0 | MVP |
| FR-ADMIN-030 | Partner applications | Review partner applications and documents; approve, reject ★, request changes. | [A] | P0 | MVP |
| FR-ADMIN-031 | Partner management | Search/view partners (status, location if online, active delivery, earnings, ratings, cash-in-hand, documents); suspend/unsuspend ★; force offline ★; record cash deposits ★; adjust earnings ★⧉. | [A][SA read] | P0 | MVP |
| FR-ADMIN-040 | Order management | Search orders by number, customer phone, restaurant, partner, status, date, zone; view full details incl. timeline, payment attempts, webhook events, delivery stages, location trail, assignment history, notifications sent, audit trail. | [A][SA] | P0 | MVP |
| FR-ADMIN-041 | Order interventions | Permitted operational actions (each a defined transition, never arbitrary status set): cancel order ★ (with fault attribution: CUSTOMER, RESTAURANT, PARTNER, PLATFORM — drives refund & penalties), force-reassign partner ★, manually assign partner ★, mark delivered on partner's behalf ★ (requires evidence note), mark delivery failed ★, extend acceptance timeout, re-trigger dispatch, resend notifications. | [A]; [SA] limited | P0 | MVP |
| FR-ADMIN-042 | Disputes | Handle order disputes: view both parties' statements, evidence, decide outcome (refund amount, who bears cost) ★; outcomes post ledger entries. | [A][SA] | P1 | CORE |
| FR-ADMIN-050 | Payments | View payments with provider IDs, attempts, status, webhook log; manually trigger verification against provider ★; view reconciliation reports and mismatches. | [A] | P0 | MVP |
| FR-ADMIN-051 | Refunds | Initiate full/partial refunds ★ (support agents up to `cfg.support.refundLimit` per order, default ₹500; above → admin ⧉), choose destination (source/wallet), view refund status and retry failed refunds. | [A][SA] | P0 | MVP |
| FR-ADMIN-052 | Reconciliation | View daily reconciliation: provider settlements vs payments vs ledger; resolve mismatches with notes ★. | [A] | P1 | CORE |
| FR-ADMIN-060 | Coupons | Create/edit/deactivate coupons: code (unique, case-insensitive), description, type, value, cap, min order, validity, usage limits (global, per user), targeting (all, new users, specific users/segments), scope (zones, restaurants), payment method restriction, funding (platform/restaurant/shared) ★, stackability. Coupons with redemptions cannot change discount terms (create new version). | [A] | P0 | MVP |
| FR-ADMIN-061 | Promotions & banners | Manage platform promotions, collections (featured restaurant lists), and home banners with schedule and zone targeting; approve restaurant promotions requiring approval. | [A] | P1 | MVP |
| FR-ADMIN-070 | Zones | Create/edit delivery zones by drawing polygons on a map; set zone status (ACTIVE, SUSPENDED — e.g., heavy rain), surge settings, base delivery fee overrides, max delivery radius. Overlapping zones are rejected. | [A] ★ | P0 | MVP |
| FR-ADMIN-071 | Fees & taxes | Configure effective-dated fee schedules (platform fee, delivery fee slabs, small order fee, packaging caps, surge caps) ★⧉ and tax rules ★⧉ (by component, rate, effective date). | [S] | P0 | MVP |
| FR-ADMIN-072 | Commission | Configure default commission and per-restaurant overrides (effective-dated) ★⧉. | [S] | P0 | MVP |
| FR-ADMIN-073 | Partner pay config | Configure partner pay formula parameters and incentive programs ★⧉. | [S] | P1 | MVP |
| FR-ADMIN-080 | Support desk | Ticket queues by category/priority/SLA; assign, reply (templates/macros), internal notes, change status, escalate, link tickets to orders; view customer/restaurant/partner context side panel. | [SA][A] | P0 | MVP |
| FR-ADMIN-081 | Complaints | Track complaints (against restaurant, partner, customer) with categories, severity, investigation notes, resolution and penalties ★. | [SA][A] | P1 | CORE |
| FR-ADMIN-082 | Review moderation | Queue of reported/auto-flagged reviews; hide/unhide ★ with reason; restore. | [A][SA] | P2 | CORE |
| FR-ADMIN-090 | Analytics | Platform analytics: GMV, orders, AOV, conversion funnel (sessions → cart → checkout → order), cancellations by cause, dispatch metrics (time to assign, acceptance rate), delivery times vs ETA, top restaurants/cuisines, zone performance, cohort retention. | [A] | P1 | CORE (basic in MVP) |
| FR-ADMIN-091 | Reports | Generate & export reports (orders, payments, refunds, settlements, payouts, tax summaries) asynchronously as CSV; downloads via signed URL valid 1 h; exports containing PII require `pii:export` ★. | [A] | P1 | CORE |
| FR-ADMIN-100 | Platform settings | View/edit `cfg.*` settings (timeouts, limits, feature toggles) with validation and history ★; critical keys [S]. | [S]/[A] | P0 | MVP |
| FR-ADMIN-101 | Feature flags | Manage feature flags (create, target, roll out %, kill switch) ★. | [S] | P1 | CORE |
| FR-ADMIN-110 | Roles & permissions | View roles and their permissions; create custom admin roles; assign/remove platform roles to users ★ (cannot elevate to SUPER_ADMIN unless SUPER_ADMIN; cannot modify own roles). | [S] | P0 | MVP (assign) / CORE (custom roles) |
| FR-ADMIN-111 | Admin accounts | Super admins create/deactivate admin & support accounts (invite flow with forced MFA enrolment) ★. | [S] | P0 | MVP |
| FR-ADMIN-120 | Audit logs | Search and view audit logs (FR-AUDIT-003). | [S], [A] own-scope | P0 | MVP |
| FR-ADMIN-121 | Payouts | Generate payout batches for restaurants and partners per schedule, review, approve ⧉, export bank file / call payout provider, record UTRs, mark failed and retry ★. | [A][S] | P0 | MVP |
| FR-ADMIN-122 | Content management | Manage FAQs, terms, privacy policy versions (publishing a new version requires re-acceptance on next login if marked material), cuisines list, dietary tag list. | [A] | P1 | MVP |
| FR-ADMIN-123 | Broadcast notifications | Send promotional notifications to targeted segments (zone, last-order recency) with scheduling, respecting preferences and quiet hours ★. | [A] | P2 | CORE |

---

## Appendix 4-A — Frontend-specific functional requirements (FR-FE)

| ID | Title | Requirement | Pri | Rel |
|---|---|---|---|---|
| FR-FE-001 | Route protection | Each app shall guard routes by authentication and by permissions resolved from the server (`GET /me/permissions`); UI hiding is a convenience only — the API enforces authorization. | P0 | MVP |
| FR-FE-002 | Token handling | Access tokens shall be kept in memory (Zustand store, not persisted); on page load the app calls `/auth/refresh` to obtain one. | P0 | MVP |
| FR-FE-003 | Single-flight refresh | The API client shall perform at most one refresh at a time per browser (cross-tab lock), queue requests during refresh, retry once on `AUTH_REFRESH_RACE`, and redirect to login on refresh failure. | P0 | MVP |
| FR-FE-004 | Role-based navigation | Navigation shall show only items the user's permissions allow. | P0 | MVP |
| FR-FE-005 | State feedback | Every data view shall implement loading (skeleton), empty, and error (with retry) states; every mutation shows pending state and success/failure toast. | P0 | MVP |
| FR-FE-006 | Forms | All forms shall use React Hook Form + shared Zod schemas, showing field-level errors from both client validation and server `VALIDATION_ERROR` details. | P0 | MVP |
| FR-FE-007 | Socket lifecycle | Apps shall connect sockets after authentication, re-authenticate on token refresh, rejoin rooms on reconnect, and re-fetch authoritative state (TanStack Query invalidation) after reconnect. | P0 | MVP |
| FR-FE-008 | Offline awareness | Apps shall show a connectivity banner when offline and disable actions that require the server. | P1 | MVP |
| FR-FE-009 | PWA (delivery app) | The delivery app shall be installable (manifest + service worker), cache the app shell, and keep the screen awake during active delivery (Wake Lock API where supported). | P1 | MVP |
| FR-FE-010 | Deep links | Notification links shall deep-link to the relevant page (order tracking, ticket, offer). | P1 | MVP |
