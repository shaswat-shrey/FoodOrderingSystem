# SRS Section 14 — API Requirements (API Inventory & Specification)

> Part of FOS-SRS-001 v0.5.0 (APPROVED 2026-11-20). This is the API inventory. Implemented so far: API-SYS-001/002; API-AUTH-001…016, 021…023; API-USER-001…003, 006…011, 013, 014; API-GEO-001…005; API-ADDR-001…006; API-REST-001…005; API-MENU-001…007; API-DISC-001…006, 008…011; API-SRCH-001…006; API-FAV-001…006 (see Traceability Matrix §22.1a–d); everything else is planned. The OpenAPI document will be **generated from the shared Zod schemas** used by the route validators (`zod-to-openapi`), so documentation cannot drift from implementation (NFR-MAINT-006).

---

## 14.1 API conventions (apply to every endpoint)

### Base & versioning
- Base path `/api/v1`. Breaking changes → `/api/v2` with ≥ 6 months parallel support (C-15).
- JSON (`application/json; charset=utf-8`), camelCase fields, ISO-8601 UTC timestamps, IDs are UUIDv7 strings, money as integer minor units with currency: `{ "amount": 24900, "currency": "INR" }`.

### Standard request headers

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer <accessToken>` | Authenticated endpoints | Access token (FR-AUTH-020). |
| `X-Client-App` | All browser requests | `CUSTOMER` / `RESTAURANT` / `DELIVERY` / `ADMIN`; must match token `aud` and the request `Origin` allowlist. |
| `Idempotency-Key` | Endpoints marked **Idem** | UUID; stored 24 h with request fingerprint (method + path + user + body hash). |
| `X-Request-Id` | Optional | Client-generated correlation ID; server generates one if absent and echoes it. |
| `If-Match` | Optional on versioned resources | Optimistic concurrency (`ETag` = aggregate version). |
| `Accept-Language` | Optional | Locale for messages (en-IN default). |

### Response envelope

Success:
```json
{ "success": true, "message": "Order placed", "data": { }, "meta": { "requestId": "…", "pagination": { "nextCursor": "…", "hasMore": true } } }
```
Error:
```json
{ "success": false, "message": "Some items are no longer available", "error": { "code": "ITEM_UNAVAILABLE", "details": [ { "path": "lines[2]", "code": "ITEM_UNAVAILABLE", "message": "Paneer Tikka is out of stock" } ], "retryable": false }, "meta": { "requestId": "…" } }
```
**Exceptions to the envelope** (deliberate): payment webhooks (provider-defined response, `200` plain), file downloads/invoices (binary with `Content-Disposition`), health checks (`{status}`), `/metrics` (Prometheus text), OpenAPI JSON.

### Status codes

| Code | Use |
|---|---|
| 200 | Successful read/update; idempotent replay (with `Idempotent-Replayed: true`) |
| 201 | Resource created (`Location` header) |
| 202 | Accepted for async processing (exports, data export) |
| 204 | Success, no body (rare; logout returns 200 envelope for consistency) |
| 400 | `VALIDATION_ERROR` |
| 401 | Authentication failure (token missing/invalid/expired, session revoked) |
| 403 | Authenticated but not permitted; verification/reauth required |
| 404 | Not found **or** not visible to caller |
| 409 | State conflict, version conflict, idempotency key reuse, cart branch conflict |
| 410 | Expired resource (checkout session, invitation) |
| 413 | Payload too large (uploads) |
| 415 | Unsupported media type |
| 422 | Business rule violation with valid syntax (e.g., `ORDER_BELOW_MINIMUM`, `COUPON_NOT_APPLICABLE`) |
| 429 | Rate limited (`Retry-After` header) |
| 500 | Unexpected error (no internals leaked) |
| 502/503/504 | Upstream provider failure / service degraded / timeout (`retryable: true`) |

### Pagination, filtering, sorting, search
- Cursor pagination for feeds/history: `?cursor=<opaque>&limit=20` (max 100) → `meta.pagination.nextCursor`.
- Offset pagination for admin tables: `?page=1&pageSize=25` → `meta.pagination.{page,pageSize,total}`.
- Filtering: explicit typed query params (`status=PLACED,ACCEPTED`, `from=…&to=…`); no generic query language.
- Sorting: `sort=rating:desc` against an allowlist per endpoint.
- Search: `q` (2–100 chars) where supported.

### Rate-limit tiers (Redis sliding window; in-memory fallback)

| Tier | Limit (proposed) | Key |
|---|---|---|
| RL-AUTH | 10 req/min/IP and 5 req/min/identifier | Login, register, refresh (refresh: 30/min/session) |
| RL-OTP | 1 per 30 s, 5/h per destination; 10/h per IP | OTP send |
| RL-READ | 300 req/min/user (120/min/IP for guests) | GET endpoints |
| RL-WRITE | 60 req/min/user | Mutations |
| RL-SEARCH | 60 req/min/user or IP | Search/autocomplete |
| RL-ADMIN | 600 req/min/admin | Admin endpoints |
| RL-UPLOAD | 20 uploads/h/user | Files |
| RL-WEBHOOK | none (signature-verified; 1 MB body cap) | Webhooks |

### Authentication / permission notation used in tables
`Public` = no auth · `Guest|Cust` = optional auth (personalized if signed in) · `Cust` = CUSTOMER · `RM[perm]` = restaurant member with restaurant permission, scope-checked to restaurant/branch · `DP` = approved DELIVERY_PARTNER (some onboarding endpoints: `DP-applicant`) · `ADM[perm]` = admin-app user with platform permission · `SYS` = provider/system (signature-authenticated). **Idem** = `Idempotency-Key` required.

### Endpoint consolidation decisions
Some operations listed in the master prompt are intentionally **one endpoint** to avoid meaningless APIs:
- "Calculate delivery fee / taxes / platform fee / discounts / total / apply tip" → computed together in the checkout session quote (`API-CHK-001/003`) and cart price preview (`API-CART-011`). A fee in isolation is not meaningful because fees depend on each other (small-order fee depends on discounts).
- "Featured / recommended / trending / top-rated / new restaurants" → `GET /discovery/collections/{slug}` with documented slugs.
- "Create cart" → implicit on first add-item (a cart without items has no business meaning).
- "Create payment / initiate payment / retry payment" → `POST /orders/{id}/payments` (each call = new attempt).
- "Verify OTP" is purpose-specific (login, phone verification, reset, change phone) to prevent cross-purpose OTP reuse.

---

## 14.2 API inventory

Counts: 494 planned endpoints across 30 modules (about 165 of them admin). Each row has a business purpose traced to an FR.

### Authentication — `API-AUTH` (module `auth`)

| ID | Method & path | Purpose | Auth | Idem / RL | Request (key fields) | Key errors | FR |
|---|---|---|---|---|---|---|---|
| API-AUTH-001 | POST `/auth/register` | Register with email+password | Public | RL-AUTH | fullName, email, phone, password, acceptTerms | VALIDATION_ERROR, AUTH_REGISTRATION_CONFLICT, AUTH_PASSWORD_WEAK/BREACHED | FR-AUTH-001 |
| API-AUTH-002 | POST `/auth/otp/request` | Send OTP for LOGIN / VERIFY_PHONE / RESET_PASSWORD / CHANGE_PHONE / DELETE_ACCOUNT | Public (LOGIN, RESET) or authed | RL-OTP | phone, purpose | RATE_LIMITED | FR-AUTH-010 |
| API-AUTH-003 | POST `/auth/otp/login` | Verify login OTP → session (creates account if new) | Public | RL-AUTH | phone, code, fullName?, acceptTerms? | AUTH_OTP_INVALID/EXPIRED/ATTEMPTS_EXCEEDED, AUTH_TERMS_REQUIRED (new number without consent; the code is consumed), AUTH_ACCOUNT_SUSPENDED, ACCOUNT_PENDING_DELETION | FR-AUTH-002 |
| API-AUTH-004 | POST `/auth/login` | Password login → session | Public | RL-AUTH | identifier, password | AUTH_INVALID_CREDENTIALS, AUTH_ACCOUNT_SUSPENDED, ACCOUNT_PENDING_DELETION, AUTH_APP_NOT_PERMITTED, AUTH_MFA_REQUIRED | FR-AUTH-003 |
| API-AUTH-005 | POST `/auth/refresh` | Rotate refresh token, new access token | Cookie + Origin + X-Client-App | RL-AUTH | (cookie) | AUTH_REFRESH_INVALID, AUTH_REFRESH_REUSED, AUTH_REFRESH_RACE, AUTH_SESSION_EXPIRED/REVOKED | FR-AUTH-022 |
| API-AUTH-006 | POST `/auth/logout` | Revoke current session | Any authed (or cookie) | — | — | — | FR-AUTH-005 |
| API-AUTH-007 | POST `/auth/logout-all` | Revoke all sessions | Any authed | — | keepCurrent | — | FR-AUTH-006 |
| API-AUTH-008 | GET `/auth/sessions` | List active sessions | Any authed | RL-READ | — | — | FR-AUTH-007 |
| API-AUTH-009 | DELETE `/auth/sessions/{sessionId}` | Revoke one own session | Any authed | — | — | AUTH_SESSION_NOT_FOUND (404) | FR-AUTH-007 |
| API-AUTH-010 | POST `/auth/email/send-verification` | Send email verification link | Any authed | 3/h | — | AUTH_EMAIL_ALREADY_VERIFIED | FR-AUTH-008 |
| API-AUTH-011 | POST `/auth/email/verify` | Verify email token | Public | RL-AUTH | token | AUTH_TOKEN_INVALID/EXPIRED/USED | FR-AUTH-008 |
| API-AUTH-012 | POST `/auth/phone/verify` | Verify phone with OTP | Authed (pending verification allowed) | RL-AUTH | code | AUTH_OTP_* | FR-AUTH-009 |
| API-AUTH-013 | POST `/auth/password/forgot` | Start password reset (generic response) | Public | 3/h/identifier | identifier | — | FR-AUTH-011 |
| API-AUTH-014 | POST `/auth/password/reset` | Reset with token or OTP | Public | RL-AUTH | token \| (phone, code), newPassword | AUTH_TOKEN_*, AUTH_OTP_*, AUTH_PASSWORD_WEAK | FR-AUTH-012 |
| API-AUTH-015 | POST `/auth/password/change` | Change password | Any authed | RL-AUTH | currentPassword, newPassword | AUTH_INVALID_CREDENTIALS, AUTH_PASSWORD_WEAK | FR-AUTH-013 |
| API-AUTH-016 | POST `/auth/reauth` | Step-up re-authentication | Any authed | RL-AUTH | password \| otp | AUTH_INVALID_CREDENTIALS | FR-AUTH-031 |
| API-AUTH-017 | POST `/auth/oauth/google` | Google sign-in | Public (customer app) | RL-AUTH | idToken, nonce | AUTH_OAUTH_TOKEN_INVALID, AUTH_OAUTH_LINK_REQUIRED | FR-AUTH-004 |
| API-AUTH-018 | POST `/auth/oauth/apple` | Apple sign-in | Public (customer app) | RL-AUTH | idToken, nonce, name? | as above | FR-AUTH-004 |
| API-AUTH-019 | POST `/auth/mfa/totp/setup` | Begin TOTP enrolment (returns otpauth URI) | ADM | — | — | — | FR-AUTH-032 |
| API-AUTH-020 | POST `/auth/mfa/totp/confirm` | Confirm enrolment, return recovery codes | ADM | — | code | AUTH_OTP_INVALID | FR-AUTH-032 |
| API-AUTH-021 | POST `/auth/mfa/challenge` | Complete MFA login step | Pending-MFA token | RL-AUTH | mfaToken, code \| recoveryCode | AUTH_MFA_INVALID | FR-AUTH-032 |
| API-AUTH-022 | POST `/auth/account/deletion` | Request account deletion | Any authed + reauth | Idem | confirm=true | ACCOUNT_DELETION_BLOCKED, AUTH_REAUTH_REQUIRED | FR-AUTH-041 |
| API-AUTH-023 | POST `/auth/account/reactivate` | Cancel pending deletion and sign in | One-time reactivation token (15 min) from the `ACCOUNT_PENDING_DELETION` sign-in response; no session is issued before reactivation | RL-AUTH | token | AUTH_TOKEN_INVALID/EXPIRED/USED, ACCOUNT_NOT_REACTIVATABLE | FR-AUTH-042 |
| API-AUTH-024 | POST `/auth/recovery-requests` | Lost-access recovery request | Public | 3/day/IP | contact info, details | — | FR-AUTH-014 |

### Users / profile — `API-USER` (module `users`, `customers`)

| ID | Method & path | Purpose | Auth | Notes | FR |
|---|---|---|---|---|---|
| API-USER-001 | GET `/me` | Profile + roles + verification flags | Any authed | — | FR-CUST-001 |
| API-USER-002 | PATCH `/me` | Update name, language | Any authed | — | FR-CUST-002 |
| API-USER-003 | GET `/me/permissions` | Effective permissions & scopes for this app | Any authed | Drives FR-FE-001 | FR-AUTH-024 |
| API-USER-004 | PUT `/me/avatar` | Set avatar (fileId from API-FILE-001) | Any authed | — | FR-CUST-005 |
| API-USER-005 | DELETE `/me/avatar` | Remove avatar | Any authed | — | FR-CUST-005 |
| API-USER-006 | GET `/me/preferences` | Dietary, veg-only, allergens | Cust | — | FR-CUST-006 |
| API-USER-007 | PATCH `/me/preferences` | Update preferences | Cust | — | FR-CUST-006 |
| API-USER-008 | GET `/me/account-status` | Status & verification | Any authed | — | FR-CUST-007 |
| API-USER-009 | POST `/me/email/change` | Change email (reauth) | Any authed | Idem | FR-CUST-003 |
| API-USER-010 | POST `/me/phone/change` | Request phone change (sends OTP to new phone) | Any authed (reauth) | RL-OTP | FR-CUST-004 |
| API-USER-011 | POST `/me/phone/change/confirm` | Confirm with OTP | Any authed | — | FR-CUST-004 |
| API-USER-012 | POST `/me/data-export` | Request personal data export | Any authed | 202; 1/day | FR-CUST-008 |
| API-USER-013 | GET `/me/consents` | Accepted legal document versions & pending | Any authed | — | BR-AUTH-020 |
| API-USER-014 | POST `/me/consents` | Accept a new legal document version | Any authed | — | BR-AUTH-020 |

### Addresses & geo — `API-ADDR`, `API-GEO`

| ID | Method & path | Purpose | Auth | Notes | FR |
|---|---|---|---|---|---|
| API-ADDR-001 | POST `/me/addresses` | Create address | Cust | max 20 | FR-ADDR-001 |
| API-ADDR-002 | GET `/me/addresses?branchId=` | List (+serviceability for branch) | Cust | — | FR-ADDR-002 |
| API-ADDR-003 | GET `/me/addresses/{id}` | Get one | Cust (owner) | 404 if not owner | FR-ADDR-002 |
| API-ADDR-004 | PATCH `/me/addresses/{id}` | Update | Cust (owner) | — | FR-ADDR-003 |
| API-ADDR-005 | DELETE `/me/addresses/{id}` | Soft delete | Cust (owner) | — | FR-ADDR-004 |
| API-ADDR-006 | POST `/me/addresses/{id}/default` | Set default | Cust (owner) | — | FR-ADDR-005 |
| API-GEO-001 | GET `/geo/autocomplete?q&lat&lng&sessionToken` | Address suggestions | Guest\|Cust | RL-SEARCH | FR-LOC-003 |
| API-GEO-002 | GET `/geo/places/{placeId}` | Resolve suggestion → coordinates & components | Guest\|Cust | — | FR-LOC-003 |
| API-GEO-003 | GET `/geo/reverse?lat&lng` | Reverse geocode | Guest\|Cust | cached | FR-LOC-002 |
| API-GEO-004 | GET `/geo/serviceability?lat&lng&branchId?` | Zone / branch serviceability + reason | Public | — | FR-LOC-006 |
| API-GEO-005 | POST `/geo/geocode` | Forward geocode a typed address (validation) | Cust | RL-SEARCH | FR-ADDR-006 |

### Discovery — `API-DISC`

| ID | Method & path | Purpose | Auth | Notes | FR |
|---|---|---|---|---|---|
| API-DISC-001 | GET `/discovery/restaurants?lat&lng&cuisines&minRating&maxEta&maxDeliveryFee&priceMin&priceMax&offers&pureVeg&vegan&openNow&maxDistance&sort&cursor&limit` | Serviceable listing with filters/sort | Guest\|Cust | RL-READ; p95 ≤ 500 ms | FR-DISC-001..004 |
| API-DISC-002 | GET `/discovery/home?lat&lng` | Home sections (banners, collections, cuisines, order again) | Guest\|Cust | cached per geohash | FR-DISC-005, 006, 012 |
| API-DISC-003 | GET `/discovery/collections/{slug}?lat&lng&cursor` | Collection listing: `featured`, `recommended`, `popular`, `trending`, `top-rated`, `new`, `free-delivery`, `offers`, admin-defined slugs | Guest\|Cust | — | FR-DISC-005 |
| API-DISC-004 | GET `/discovery/cuisines?lat&lng` | Popular cuisines available here | Guest\|Cust | — | FR-DISC-007 |
| API-DISC-005 | GET `/discovery/cuisines/{slug}/restaurants?lat&lng&…` | Restaurants by cuisine | Guest\|Cust | — | FR-DISC-007 |
| API-DISC-006 | GET `/discovery/categories/{slug}/items?lat&lng` | Dishes by food category (e.g., "biryani", "desserts") | Guest\|Cust | — | FR-DISC-005 |
| API-DISC-007 | GET `/discovery/offers/{offerId}/restaurants?lat&lng` | Restaurants with an offer | Guest\|Cust | — | FR-DISC-013 |
| API-DISC-008 | GET `/discovery/banners?lat&lng` | Active banners | Public | — | FR-DISC-006 |
| API-DISC-009 | GET `/discovery/order-again?lat&lng` | Re-order suggestions | Cust | — | FR-DISC-012 |
| API-DISC-010 | GET `/discovery/facets?lat&lng` | Available filter values (cuisines, price bands) at location | Guest\|Cust | — | FR-DISC-002 |
| API-DISC-011 | GET `/discovery/items/specials?lat&lng` | Today's specials & best-sellers nearby | Guest\|Cust | — | FR-DISC-005 |

### Search — `API-SRCH`

| ID | Method & path | Purpose | Auth | Notes | FR |
|---|---|---|---|---|---|
| API-SRCH-001 | GET `/search?q&lat&lng&type=all\|restaurant\|dish&vegOnly&minRating&cursor` | Unified search | Guest\|Cust | RL-SEARCH; records history if signed in | FR-SRCH-001, 002, 007, 008 |
| API-SRCH-002 | GET `/search/suggestions?q&lat&lng` | Autocomplete | Guest\|Cust | p95 ≤ 200 ms | FR-SRCH-004 |
| API-SRCH-003 | GET `/search/trending?lat&lng` | Trending queries in zone | Public | — | FR-SRCH-006 |
| API-SRCH-004 | GET `/me/search-history` | Recent queries | Cust | — | FR-SRCH-005 |
| API-SRCH-005 | DELETE `/me/search-history/{id}` | Remove one | Cust | — | FR-SRCH-005 |
| API-SRCH-006 | DELETE `/me/search-history` | Clear all | Cust | — | FR-SRCH-005 |

### Restaurants & menu (public) — `API-REST`, `API-MENU`

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-REST-001 | GET `/restaurants/{restaurantId}` | Brand info | Public | FR-MENUC-001 |
| API-REST-002 | GET `/restaurants/{restaurantId}/branches?lat&lng` | Brand branches with serviceability | Public | FR-MENUC-010 |
| API-REST-003 | GET `/branches/{branchId}?lat&lng` | Branch page header (status, hours today, ETA, fees, offers, FSSAI) | Guest\|Cust | FR-MENUC-001 |
| API-REST-004 | GET `/branches/{branchId}/hours` | Weekly hours + upcoming holidays | Public | FR-MENUC-001 |
| API-REST-005 | GET `/branches/{branchId}/delivery-info?lat&lng` | Serviceability, distance, ETA, fees, minimum order | Public | FR-DISC-009 |
| API-REST-006 | GET `/branches/{branchId}/offers` | Active promotions & coupons for branch | Guest\|Cust | FR-MENUC-001 |
| API-REST-007 | GET `/branches/{branchId}/reviews?rating&sort&cursor` | Published reviews | Public | FR-MENUC-009 |
| API-REST-008 | GET `/branches/{branchId}/rating-summary` | Avg, count, distribution, tag stats | Public | FR-MENUC-009 |
| API-MENU-001 | GET `/branches/{branchId}/menu?vegOnly` | Full menu (categories, smart sections, items, availability) — ETag | Public | FR-MENUC-002, 003, 005, 008 |
| API-MENU-002 | GET `/branches/{branchId}/menu/categories` | Category list with counts | Public | FR-MENUC-002 |
| API-MENU-003 | GET `/branches/{branchId}/menu/items?categoryId&diet&flags&q&available` | Filtered items | Public | FR-MENUC-006 |
| API-MENU-004 | GET `/branches/{branchId}/menu/items/{itemId}` | Item details incl. variants, customizations, allergens | Public | FR-MENUC-004 |
| API-MENU-005 | GET `/branches/{branchId}/menu/items/{itemId}/customizations` | Customization groups & options (availability-aware) | Public | FR-MENUC-004 |
| API-MENU-006 | GET `/branches/{branchId}/menu/popular` | Bestsellers / popular items | Public | FR-MENUC-002 |
| API-MENU-007 | GET `/branches/{branchId}/menu/specials` | Today's specials & recommended | Public | FR-MENUC-002 |
| API-MENU-008 | GET `/menu/items/{itemId}/reviews` | Item ratings (CORE) | Public | FR-REV-003 |

### Favorites — `API-FAV`

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-FAV-001 | GET `/me/favorites/restaurants?lat&lng` | List | Cust | FR-FAV-003 |
| API-FAV-002 | PUT `/me/favorites/restaurants/{restaurantId}` | Add (idempotent) | Cust | FR-FAV-001 |
| API-FAV-003 | DELETE `/me/favorites/restaurants/{restaurantId}` | Remove | Cust | FR-FAV-001 |
| API-FAV-004 | GET `/me/favorites/items?lat&lng` | List | Cust | FR-FAV-003 |
| API-FAV-005 | PUT `/me/favorites/items/{itemId}` | Add | Cust | FR-FAV-002 |
| API-FAV-006 | DELETE `/me/favorites/items/{itemId}` | Remove | Cust | FR-FAV-002 |

### Cart — `API-CART`

| ID | Method & path | Purpose | Auth | Notes | FR |
|---|---|---|---|---|---|
| API-CART-001 | GET `/cart` | Active cart with validation flags & preview | Cust | — | FR-CART-002 |
| API-CART-002 | POST `/cart/items` | Add item (creates cart; `replaceCart` to switch branch) | Cust | RL-WRITE | FR-CART-001 |
| API-CART-003 | PATCH `/cart/items/{lineId}` | Update quantity | Cust | If-Match | FR-CART-003 |
| API-CART-004 | PUT `/cart/items/{lineId}` | Replace variant/options/instructions | Cust | — | FR-CART-004 |
| API-CART-005 | DELETE `/cart/items/{lineId}` | Remove line | Cust | — | FR-CART-005 |
| API-CART-006 | DELETE `/cart` | Clear cart | Cust | — | FR-CART-006 |
| API-CART-007 | PATCH `/cart` | Cart instructions, cutlery, preview address | Cust | — | FR-CART-007 |
| API-CART-008 | POST `/cart/validate` | Blocking issues & warnings | Cust | — | FR-CART-010 |
| API-CART-009 | POST `/cart/coupon` | Apply coupon | Cust | — | FR-CART-009 |
| API-CART-010 | DELETE `/cart/coupon` | Remove coupon | Cust | — | FR-CART-009 |
| API-CART-011 | GET `/cart/price-preview?addressId\|lat,lng&tip` | Full pricing preview | Cust | — | FR-CART-008 |
| API-CART-012 | POST `/cart/merge` | Merge guest draft lines | Cust | — | FR-CART-011 |

### Coupons — `API-COUP`

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-COUP-001 | GET `/coupons?branchId&cartId` | Coupons with eligibility & reasons | Guest\|Cust | FR-COUP-001 |
| API-COUP-002 | GET `/coupons/{code}` | Coupon terms | Guest\|Cust | FR-COUP-003 |
| API-COUP-003 | POST `/coupons/validate` | Validate code against cart without applying | Cust | FR-COUP-002 |

### Checkout — `API-CHK`

| ID | Method & path | Purpose | Auth | Idem | FR |
|---|---|---|---|---|---|
| API-CHK-001 | POST `/checkout/sessions` | Create session with quote (validates cart, address, fees, taxes, discounts, tip, ETA) | Cust | — | FR-CHK-001 |
| API-CHK-002 | GET `/checkout/sessions/{id}` | Get session & quote | Cust (owner) | — | FR-CHK-001 |
| API-CHK-003 | PATCH `/checkout/sessions/{id}` | Change address / tip / payment method / wallet / instructions → re-quote | Cust | — | FR-CHK-001, 003, 005, 006, 007 |
| API-CHK-004 | POST `/checkout/sessions/{id}/confirm` | Create order (and payment intent if online) | Cust | **Idem** | FR-CHK-002, FR-ORDER-001/002 |

### Payments, refunds, wallet — `API-PAY`, `API-REF`, `API-WAL`

| ID | Method & path | Purpose | Auth | Idem | FR |
|---|---|---|---|---|---|
| API-PAY-001 | GET `/payments/methods?branchId&amount` | Available methods (COD eligibility) | Cust | — | FR-CHK-007 |
| API-PAY-002 | POST `/orders/{orderId}/payments` | Initiate / retry online payment attempt | Cust (owner) | **Idem** | FR-PAY-002, FR-PAY-005 |
| API-PAY-003 | GET `/payments/{paymentId}` | Payment details & status | Cust (owner) | — | FR-PAY-015 |
| API-PAY-004 | POST `/payments/{paymentId}/verify` | Verify client callback (signature + provider fetch) | Cust (owner) | **Idem** | FR-PAY-003 |
| API-PAY-005 | POST `/payments/{paymentId}/cancel` | Abandon payment (order → T05) | Cust (owner) | **Idem** | FR-PAY-016 |
| API-PAY-006 | GET `/me/payments?cursor` | Payment history | Cust | — | FR-CPAY-004 |
| API-PAY-007 | POST `/payments/webhooks/{provider}` | Provider webhook | SYS (signature) | dedupe by event ID | FR-PAY-004 |
| API-REF-001 | GET `/me/refunds?cursor` | Refund history | Cust | — | FR-CPAY-004 |
| API-REF-002 | GET `/refunds/{refundId}` | Refund details | Cust (owner) | — | FR-REFUND-001 |
| API-WAL-001 | GET `/me/wallet` | Balance (available, held), expiring credits | Cust | — | FR-CPAY-005 |
| API-WAL-002 | GET `/me/wallet/transactions?cursor` | Wallet ledger lines | Cust | — | FR-CPAY-005 |

### Orders & tracking (customer) — `API-ORD`, `API-TRK`

| ID | Method & path | Purpose | Auth | Idem | FR |
|---|---|---|---|---|---|
| API-ORD-001 | GET `/me/orders?status&from&to&cursor` | Order history | Cust | — | FR-CORD-002 |
| API-ORD-002 | GET `/me/orders/active` | Non-terminal orders | Cust | — | FR-CORD-001 |
| API-ORD-003 | GET `/orders/{orderId}` | Order details (snapshot) | Cust (owner) | — | FR-CORD-003 |
| API-ORD-004 | GET `/orders/{orderId}/status` | Lightweight status (polling fallback) | Cust (owner) | — | FR-CPAY-002 |
| API-ORD-005 | GET `/orders/{orderId}/timeline` | Status history & delivery stages | Cust (owner) | — | FR-CORD-003 |
| API-ORD-006 | GET `/orders/{orderId}/cancellation-preview` | Eligibility, fee, refund, quoteId | Cust (owner) | — | FR-ORDER-020 |
| API-ORD-007 | POST `/orders/{orderId}/cancel` | Cancel (with quoteId, reason) | Cust (owner) | **Idem** | FR-CORD-007 |
| API-ORD-008 | POST `/orders/{orderId}/reorder` | Build cart from order | Cust (owner) | — | FR-CORD-008 |
| API-ORD-009 | GET `/orders/{orderId}/invoice` | Tax invoice PDF | Cust (owner) | — | FR-CORD-009 |
| API-ORD-010 | PATCH `/orders/{orderId}/delivery-details` | Update instructions / contact phone (until pickup) | Cust (owner) | — | FR-ORDER-031 |
| API-ORD-011 | POST `/orders/{orderId}/issues` | Report issue / request item refund | Cust (owner) | **Idem** | FR-CORD-010, 011 |
| API-ORD-012 | GET `/orders/{orderId}/issues` | Issue status | Cust (owner) | — | FR-CORD-010 |
| API-ORD-013 | POST `/orders/{orderId}/not-delivered` | Report not received (≤ 1 h) | Cust (owner) | **Idem** | FR-CORD-012 |
| API-TRK-001 | GET `/orders/{orderId}/tracking` | Snapshot: status, delivery stage, partner card, last location, ETA, route polyline, delivery code | Cust (owner) | — | FR-CORD-004, 005, 006 |
| API-TRK-002 | GET `/orders/{orderId}/tracking/location` | Latest partner location only (poll fallback ≤ 1/5 s) | Cust (owner) | — | FR-CORD-004 |

### Reviews — `API-REV`

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-REV-001 | POST `/orders/{orderId}/reviews` | Submit restaurant, partner (and item) ratings | Cust (owner, delivered) | FR-REV-001..003 |
| API-REV-002 | PATCH `/reviews/{reviewId}` | Edit (≤ 48 h) | Cust (author) | FR-REV-004 |
| API-REV-003 | DELETE `/reviews/{reviewId}` | Delete own | Cust (author) | FR-REV-004 |
| API-REV-004 | GET `/me/reviews` | My reviews | Cust | FR-REV-004 |
| API-REV-005 | POST `/reviews/{reviewId}/reports` | Report review | Any authed | FR-REV-005 |

### Notifications — `API-NTF`

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-NTF-001 | GET `/me/notifications?cursor&unread` | Inbox | Any authed | FR-NOTIF-002 |
| API-NTF-002 | GET `/me/notifications/unread-count` | Badge count | Any authed | FR-NOTIF-003 |
| API-NTF-003 | GET `/me/notifications/{id}` | Detail | Any authed (recipient) | FR-NOTIF-002 |
| API-NTF-004 | POST `/me/notifications/{id}/read` | Mark read | recipient | FR-NOTIF-003 |
| API-NTF-005 | POST `/me/notifications/read-all` | Mark all read | Any authed | FR-NOTIF-003 |
| API-NTF-006 | DELETE `/me/notifications/{id}` | Hide | recipient | FR-NOTIF-004 |
| API-NTF-007 | GET `/me/notification-preferences` | Preferences | Any authed | FR-NOTIF-006 |
| API-NTF-008 | PUT `/me/notification-preferences` | Update | Any authed | FR-NOTIF-006 |
| API-NTF-009 | POST `/me/push-subscriptions` | Register Web Push subscription | Any authed | FR-NOTIF-009 |
| API-NTF-010 | DELETE `/me/push-subscriptions/{id}` | Unregister | owner | FR-NOTIF-009 |

### Support & content — `API-SUP`

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-SUP-001 | GET `/help/faqs?app&topic` | FAQ content | Public | FR-CSUP-001 |
| API-SUP-002 | POST `/support/tickets` | Create ticket | Any authed | FR-CSUP-002, FR-EARN-008 |
| API-SUP-003 | GET `/support/tickets?status&cursor` | My tickets | Any authed | FR-CSUP-003 |
| API-SUP-004 | GET `/support/tickets/{id}` | Ticket + messages | requester | FR-CSUP-003 |
| API-SUP-005 | POST `/support/tickets/{id}/messages` | Reply (text + attachments) | requester | FR-CSUP-003 |
| API-SUP-006 | POST `/support/tickets/{id}/close` | Close | requester | FR-CSUP-004 |
| API-SUP-007 | POST `/support/tickets/{id}/reopen` | Reopen (≤ 7 d) | requester | FR-CSUP-004 |
| API-SUP-008 | POST `/support/tickets/{id}/csat` | Rate support | requester | FR-CSUP-005 |
| API-SUP-009 | GET `/legal/{documentType}` | Terms, privacy, grievance officer, refund policy (current version) | Public | FR-CSUP-006 |

### Files — `API-FILE`

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-FILE-001 | POST `/files` (multipart: file, purpose) | Upload, validate, return fileId | Any authed per purpose | FR-FILE-001, 002 |
| API-FILE-002 | GET `/files/{fileId}/url` | Signed URL (private files) | Owner / authorized | FR-FILE-004 |
| API-FILE-003 | DELETE `/files/{fileId}` | Delete unattached upload | Owner | FR-FILE-006 |

### Restaurant (merchant) portal — `API-MER` (onboarding, profile, branches)

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-MER-001 | POST `/merchant/applications` | Start application | Authed (restaurant app, verified) | FR-REST-001 |
| API-MER-002 | GET `/merchant/applications/{id}` | Application + review comments | Applicant | FR-REST-002 |
| API-MER-003 | PATCH `/merchant/applications/{id}` | Save progress (DRAFT/CHANGES_REQUESTED) | Applicant | FR-REST-001, 003 |
| API-MER-004 | POST `/merchant/applications/{id}/documents` | Attach document (fileId, type) | Applicant | FR-REST-001 |
| API-MER-005 | DELETE `/merchant/applications/{id}/documents/{docId}` | Remove document | Applicant | FR-REST-001 |
| API-MER-006 | POST `/merchant/applications/{id}/submit` | Submit for review | Applicant | FR-REST-001 |
| API-MER-007 | GET `/merchant/me` | Memberships: restaurants, branches, roles, permissions | Authed | FR-FE-001 |
| API-MER-008 | GET `/merchant/restaurants/{rid}` | Restaurant profile (manage view) | RM[restaurant:read] | FR-REST-010 |
| API-MER-009 | PATCH `/merchant/restaurants/{rid}` | Update non-legal fields | RM[restaurant:update] | FR-REST-010 |
| API-MER-010 | POST `/merchant/restaurants/{rid}/change-requests` | Request legal/tax/bank change (reauth) | RM[restaurant:legal] (OWNER) | FR-REST-010, FR-RFIN-003 |
| API-MER-011 | GET `/merchant/restaurants/{rid}/change-requests` | List change requests | RM[restaurant:read] | FR-REST-010 |
| API-MER-012 | PUT `/merchant/restaurants/{rid}/logo` | Set logo | RM[restaurant:update] | FR-REST-010 |
| API-MER-013 | PUT `/merchant/restaurants/{rid}/cover` | Set cover image | RM[restaurant:update] | FR-REST-010 |
| API-MER-014 | GET `/merchant/restaurants/{rid}/branches` | Branches in scope | RM[branch:read] | FR-REST-011 |
| API-MER-015 | POST `/merchant/restaurants/{rid}/branches` | Create branch (pending approval) | RM[branch:create] (OWNER) | FR-REST-011 |
| API-MER-016 | GET `/merchant/branches/{bid}` | Branch settings | RM[branch:read] | FR-REST-011 |
| API-MER-017 | PATCH `/merchant/branches/{bid}` | Update branch settings (radius, min/max order, packaging) | RM[branch:update] | FR-REST-011, 017 |
| API-MER-018 | PUT `/merchant/branches/{bid}/hours` | Replace weekly hours | RM[branch:hours] | FR-REST-012 |
| API-MER-019 | GET `/merchant/branches/{bid}/holidays` | List closures | RM[branch:read] | FR-REST-013 |
| API-MER-020 | POST `/merchant/branches/{bid}/holidays` | Add closure | RM[branch:hours] | FR-REST-013 |
| API-MER-021 | DELETE `/merchant/branches/{bid}/holidays/{hid}` | Remove closure | RM[branch:hours] | FR-REST-013 |
| API-MER-022 | POST `/merchant/branches/{bid}/open` | Go online | RM[branch:status] | FR-REST-014 |
| API-MER-023 | POST `/merchant/branches/{bid}/close` | Go offline (today) | RM[branch:status] | FR-REST-014 |
| API-MER-024 | POST `/merchant/branches/{bid}/pause` | Pause orders (duration, reason) | RM[branch:status] | FR-REST-015 |
| API-MER-025 | POST `/merchant/branches/{bid}/resume` | Resume orders | RM[branch:status] | FR-REST-015 |
| API-MER-026 | PATCH `/merchant/branches/{bid}/prep-time` | Default prep time & rush adder | RM[branch:update] | FR-REST-016 |
| API-MER-027 | GET `/merchant/branches/{bid}/status` | Effective status & reason | RM[branch:read] | FR-REST-018 |

### Restaurant menu management — `API-RMENU`

All paths prefixed `/merchant/restaurants/{rid}` unless they start with `/merchant/branches`. Permission `menu:write` unless noted.

| ID | Method & path | Purpose | FR |
|---|---|---|---|
| API-RMENU-001 | GET `/menu` | Full management menu (incl. hidden/disabled) — RM[menu:read] | FR-MENU-001..008 |
| API-RMENU-002 | POST `/categories` | Create category | FR-MENU-001 |
| API-RMENU-003 | PATCH `/categories/{cid}` | Update category | FR-MENU-001 |
| API-RMENU-004 | DELETE `/categories/{cid}?moveItemsTo=` | Delete category | FR-MENU-001 |
| API-RMENU-005 | PUT `/categories/order` | Reorder categories | FR-MENU-002 |
| API-RMENU-006 | PUT `/categories/{cid}/items/order` | Reorder items in category | FR-MENU-002 |
| API-RMENU-007 | POST `/items` | Create item | FR-MENU-003 |
| API-RMENU-008 | GET `/items/{iid}` | Item (manage view) — RM[menu:read] | FR-MENU-004 |
| API-RMENU-009 | PATCH `/items/{iid}` | Update item (price, flags, diet, discount…) — If-Match | FR-MENU-004, 012 |
| API-RMENU-010 | DELETE `/items/{iid}` | Soft-delete item | FR-MENU-005 |
| API-RMENU-011 | POST `/items/{iid}/images` | Add image (fileId) | FR-MENU-003 |
| API-RMENU-012 | DELETE `/items/{iid}/images/{imageId}` | Remove image | FR-MENU-003 |
| API-RMENU-013 | PUT `/items/{iid}/images/order` | Reorder images | FR-MENU-003 |
| API-RMENU-014 | POST `/items/{iid}/variants` | Add variant | FR-MENU-006 |
| API-RMENU-015 | PATCH `/items/{iid}/variants/{vid}` | Update variant | FR-MENU-006 |
| API-RMENU-016 | DELETE `/items/{iid}/variants/{vid}` | Remove variant | FR-MENU-006 |
| API-RMENU-017 | GET `/customization-groups` | List reusable groups — RM[menu:read] | FR-MENU-007 |
| API-RMENU-018 | POST `/customization-groups` | Create group | FR-MENU-007 |
| API-RMENU-019 | PATCH `/customization-groups/{gid}` | Update group rules | FR-MENU-007 |
| API-RMENU-020 | DELETE `/customization-groups/{gid}` | Delete (if detached) | FR-MENU-007 |
| API-RMENU-021 | POST `/customization-groups/{gid}/options` | Add option | FR-MENU-007 |
| API-RMENU-022 | PATCH `/customization-groups/{gid}/options/{oid}` | Update option | FR-MENU-007 |
| API-RMENU-023 | DELETE `/customization-groups/{gid}/options/{oid}` | Remove option | FR-MENU-007 |
| API-RMENU-024 | PUT `/items/{iid}/customization-groups` | Attach/order groups (optionally per variant) | FR-MENU-007 |
| API-RMENU-025 | PUT `/merchant/branches/{bid}/items/{iid}/availability` | In/out of stock (until) — RM[menu:availability] | FR-MENU-008 |
| API-RMENU-026 | PUT `/merchant/branches/{bid}/options/{oid}/availability` | Option availability — RM[menu:availability] | FR-MENU-008 |
| API-RMENU-027 | PUT `/merchant/branches/{bid}/items/{iid}/stock` | Stock count (CORE) — RM[menu:availability] | FR-MENU-009 |
| API-RMENU-028 | POST `/merchant/branches/{bid}/availability/bulk` | Bulk availability (CORE) | FR-MENU-013 |
| API-RMENU-029 | PUT `/items/{iid}/schedule` | Availability schedule (CORE) | FR-MENU-010 |
| API-RMENU-030 | PUT `/categories/{cid}/schedule` | Category schedule (CORE) | FR-MENU-010 |
| API-RMENU-031 | POST `/combos` | Create combo (CORE) | FR-MENU-011 |
| API-RMENU-032 | PATCH `/combos/{id}` | Update combo (CORE) | FR-MENU-011 |
| API-RMENU-033 | POST `/items/bulk-price/preview` | Preview bulk price change (CORE) | FR-MENU-013 |
| API-RMENU-034 | POST `/items/bulk-price/apply` | Apply bulk price change (CORE) — Idem | FR-MENU-013 |
| API-RMENU-035 | POST `/menu/import` | CSV import (ADV) — 202 | FR-MENU-014 |

### Restaurant order handling — `API-RORD`

| ID | Method & path | Purpose | Auth | Idem | FR |
|---|---|---|---|---|---|
| API-RORD-001 | GET `/merchant/branches/{bid}/orders?status&date&cursor` | Order queue / history | RM[order:read] | — | FR-RORD-008, 014 |
| API-RORD-002 | GET `/merchant/branches/{bid}/orders/counts` | Counts per tab | RM[order:read] | — | FR-RORD-008 |
| API-RORD-003 | GET `/merchant/orders/{orderId}` | Order (restaurant projection) | RM[order:read] (branch) | — | FR-RORD-009 |
| API-RORD-004 | POST `/merchant/orders/{orderId}/accept` | T06 (prepTime?) | RM[order:accept] | **Idem** | FR-RORD-002 |
| API-RORD-005 | POST `/merchant/orders/{orderId}/reject` | T07 (reason, itemIds?) | RM[order:accept] | **Idem** | FR-RORD-003 |
| API-RORD-006 | POST `/merchant/orders/{orderId}/preparing` | T09 | RM[order:prepare] | **Idem** | FR-RORD-004 |
| API-RORD-007 | POST `/merchant/orders/{orderId}/ready` | T11 (or T09+T11) | RM[order:prepare] | **Idem** | FR-RORD-006 |
| API-RORD-008 | POST `/merchant/orders/{orderId}/prep-time` | Extend prep time once | RM[order:prepare] | **Idem** | FR-RORD-005 |
| API-RORD-009 | POST `/merchant/orders/{orderId}/handover` | Confirm handover with partner pickup code (T13/T13c) | RM[order:handover] | **Idem** | FR-RORD-007 |
| API-RORD-010 | POST `/merchant/orders/{orderId}/cancel` | Restaurant cancel after accept (T10b/T12b) | RM[order:cancel] | **Idem** | FR-RORD-012 |
| API-RORD-011 | GET `/merchant/branches/{bid}/kds` | KDS tickets (no prices) | RM[kds:view] | — | FR-RORD-010 |
| API-RORD-012 | GET `/merchant/orders/{orderId}/kot` | Printable KOT | RM[order:read] | — | FR-RORD-011 |
| API-RORD-013 | GET `/merchant/branches/{bid}/complaints` | Complaints on branch orders (CORE) | RM[order:read] | — | FR-RORD-015 |
| API-RORD-014 | POST `/merchant/complaints/{id}/response` | Restaurant statement (CORE) | RM[order:respond] | — | FR-RORD-015 |

### Restaurant staff, promotions, analytics, finance, reviews — `API-RSTAFF`, `API-RPROMO`, `API-RANL`, `API-RFIN`, `API-RREV`

| ID | Method & path | Purpose | Auth | FR |
|---|---|---|---|---|
| API-RSTAFF-001 | GET `/merchant/restaurants/{rid}/members` | List members | RM[staff:read] | FR-RSTAFF-002 |
| API-RSTAFF-002 | POST `/merchant/restaurants/{rid}/invitations` | Invite member | RM[staff:manage] | FR-RSTAFF-001 |
| API-RSTAFF-003 | GET `/merchant/restaurants/{rid}/invitations` | Pending invitations | RM[staff:read] | FR-RSTAFF-001 |
| API-RSTAFF-004 | DELETE `/merchant/restaurants/{rid}/invitations/{id}` | Revoke invitation | RM[staff:manage] | FR-RSTAFF-001 |
| API-RSTAFF-005 | GET `/merchant/invitations/{token}` | View invitation (public preview) | Public | FR-RSTAFF-001 |
| API-RSTAFF-006 | POST `/merchant/invitations/{token}/accept` | Accept invitation | Authed | FR-RSTAFF-001 |
| API-RSTAFF-007 | PATCH `/merchant/restaurants/{rid}/members/{mid}` | Change role / branch scope / suspend | RM[staff:manage] | FR-RSTAFF-002 |
| API-RSTAFF-008 | DELETE `/merchant/restaurants/{rid}/members/{mid}` | Remove member | RM[staff:manage] | FR-RSTAFF-002 |
| API-RSTAFF-009 | GET `/merchant/restaurants/{rid}/activity?memberId&from&to` | Activity log (CORE) | RM[staff:read] | FR-RSTAFF-004 |
| API-RSTAFF-010 | POST `/merchant/branches/{bid}/kds-devices/pairing` | KDS device pairing code (CORE) | RM[staff:manage] | FR-RSTAFF-006 |
| API-RSTAFF-011 | POST `/merchant/restaurants/{rid}/ownership-transfer` | Request ownership transfer (CORE) | RM OWNER + reauth | FR-RSTAFF-005 |
| API-RPROMO-001 | GET `/merchant/restaurants/{rid}/promotions` | List | RM[promo:read] | FR-RPROMO-001 |
| API-RPROMO-002 | POST `/merchant/restaurants/{rid}/promotions` | Create (CORE) | RM[promo:write] | FR-RPROMO-001 |
| API-RPROMO-003 | PATCH `/merchant/restaurants/{rid}/promotions/{pid}` | Update (if no redemptions) | RM[promo:write] | FR-RPROMO-001 |
| API-RPROMO-004 | POST `/merchant/restaurants/{rid}/promotions/{pid}/deactivate` | Stop | RM[promo:write] | FR-RPROMO-001 |
| API-RPROMO-005 | GET `/merchant/restaurants/{rid}/promotions/{pid}/performance` | Results | RM[promo:read] | FR-RPROMO-003 |
| API-RANL-001 | GET `/merchant/restaurants/{rid}/dashboard?branchIds` | Today dashboard | RM[analytics:read] | FR-RANL-001 |
| API-RANL-002 | GET `/merchant/restaurants/{rid}/analytics/sales?from&to&granularity&branchIds` | Revenue/orders/AOV series | RM[analytics:read] | FR-RANL-002 |
| API-RANL-003 | GET `/merchant/restaurants/{rid}/analytics/items?from&to` | Top items | RM[analytics:read] | FR-RANL-003 |
| API-RANL-004 | GET `/merchant/restaurants/{rid}/analytics/categories?from&to` | Sales by category | RM[analytics:read] | FR-RANL-003 |
| API-RANL-005 | GET `/merchant/restaurants/{rid}/analytics/peak-hours?from&to` | Heatmap (CORE) | RM[analytics:read] | FR-RANL-004 |
| API-RANL-006 | GET `/merchant/restaurants/{rid}/analytics/branches?from&to` | Branch comparison (CORE) | RM[analytics:read] OWNER | FR-RANL-005 |
| API-RANL-007 | GET `/merchant/restaurants/{rid}/analytics/operations?from&to` | Acceptance/prep/cancellation metrics | RM[analytics:read] | FR-RANL-002 |
| API-RANL-008 | POST `/merchant/restaurants/{rid}/reports` | Request export (202) (CORE) | RM[reports:export] | FR-RANL-006 |
| API-RANL-009 | GET `/merchant/restaurants/{rid}/reports/{reportId}` | Export status + signed URL | RM[reports:export] | FR-RANL-006 |
| API-RFIN-001 | GET `/merchant/restaurants/{rid}/settlements?cursor` | Settlement periods | RM[finance:read] | FR-RFIN-001 |
| API-RFIN-002 | GET `/merchant/restaurants/{rid}/settlements/{sid}` | Statement | RM[finance:read] | FR-RFIN-001 |
| API-RFIN-003 | GET `/merchant/restaurants/{rid}/settlements/{sid}/orders?cursor` | Per-order earnings | RM[finance:read] | FR-RFIN-002 |
| API-RFIN-004 | GET `/merchant/restaurants/{rid}/bank-account` | Masked bank details & verification state | RM[finance:read] | FR-RFIN-003 |
| API-RFIN-005 | GET `/merchant/restaurants/{rid}/invoices` | Platform commission invoices (CORE) | RM[finance:read] | FR-RFIN-004 |
| API-RREV-001 | GET `/merchant/branches/{bid}/reviews?rating&responded&cursor` | Reviews | RM[review:read] | FR-RREV-001 |
| API-RREV-002 | POST `/merchant/reviews/{reviewId}/response` | Respond | RM[review:respond] | FR-RREV-002 |
| API-RREV-003 | PATCH `/merchant/reviews/{reviewId}/response` | Edit response (≤ 24 h) | RM[review:respond] | FR-RREV-002 |
| API-RREV-004 | POST `/merchant/reviews/{reviewId}/reports` | Report review | RM[review:respond] | FR-RREV-003 |

### Delivery partner — `API-DP`, `API-DPDEL`, `API-EARN`

| ID | Method & path | Purpose | Auth | Idem | FR |
|---|---|---|---|---|---|
| API-DP-001 | POST `/partner/applications` | Start application | DP-applicant | — | FR-DP-001 |
| API-DP-002 | GET `/partner/applications/me` | Application & feedback | DP-applicant | — | FR-DP-002 |
| API-DP-003 | PATCH `/partner/applications/me` | Save progress | DP-applicant | — | FR-DP-001 |
| API-DP-004 | POST `/partner/applications/me/documents` | Attach document | DP-applicant | — | FR-DP-001 |
| API-DP-005 | DELETE `/partner/applications/me/documents/{docId}` | Remove document | DP-applicant | — | FR-DP-001 |
| API-DP-006 | POST `/partner/applications/me/submit` | Submit | DP-applicant | — | FR-DP-001 |
| API-DP-007 | GET `/partner/me` | Partner profile | DP | — | FR-DP-004 |
| API-DP-008 | PATCH `/partner/me` | Update editable profile fields | DP | — | FR-DP-004 |
| API-DP-009 | GET `/partner/me/vehicles` | Vehicles | DP | — | FR-DP-005 |
| API-DP-010 | POST `/partner/me/vehicles` | Add vehicle (pending verification) | DP | — | FR-DP-005 |
| API-DP-011 | PATCH `/partner/me/vehicles/{id}` | Update vehicle | DP | — | FR-DP-005 |
| API-DP-012 | POST `/partner/me/vehicles/{id}/activate` | Set active vehicle | DP | — | FR-DP-005 |
| API-DP-013 | POST `/partner/me/guidelines/ack` | Acknowledge guidelines version | DP | — | FR-DP-007 |
| API-DP-014 | GET `/partner/me/availability` | Current state & blockers | DP | — | FR-DP-013 |
| API-DP-015 | POST `/partner/me/online` | Go online (lat, lng, accuracy) | DP | **Idem** | FR-DP-010 |
| API-DP-016 | POST `/partner/me/offline` | Go offline / offline after current | DP | **Idem** | FR-DP-011 |
| API-DP-017 | POST `/partner/me/pause` | Break 15/30 min (CORE) | DP | — | FR-DP-012 |
| API-DP-018 | POST `/partner/me/resume` | End break (CORE) | DP | — | FR-DP-012 |
| API-DP-019 | GET `/partner/me/dashboard` | Today: online time, deliveries, earnings, active delivery | DP | — | FR-DP-015 |
| API-DP-020 | POST `/partner/me/locations` | Batch location upload (REST fallback, ≤ 60 points) | DP | — | FR-TRK-001, 008 |
| API-DP-021 | POST `/partner/sos` | SOS alert (CORE) | DP | **Idem** | FR-DEL-036 |
| API-DPDEL-001 | GET `/partner/offers/current` | Current open offer (recovery after reconnect) | DP | — | FR-DEL-001 |
| API-DPDEL-002 | POST `/partner/offers/{offerId}/accept` | Accept offer | DP (offer owner) | **Idem** | FR-DEL-002, FR-DISP-006 |
| API-DPDEL-003 | POST `/partner/offers/{offerId}/reject` | Reject offer (reason) | DP (offer owner) | **Idem** | FR-DEL-003 |
| API-DPDEL-004 | GET `/partner/deliveries/active` | Active delivery (full details) | DP | — | FR-DEL-010 |
| API-DPDEL-005 | GET `/partner/deliveries/{deliveryId}` | Delivery details (own, active or history projection) | DP (assigned) | — | FR-DEL-010, 037 |
| API-DPDEL-006 | POST `/partner/deliveries/{deliveryId}/arrived-at-restaurant` | D04 | DP (assigned) | **Idem** | FR-DEL-020 |
| API-DPDEL-007 | POST `/partner/deliveries/{deliveryId}/picked-up` | T13 / D05 | DP (assigned) | **Idem** | FR-DEL-025 |
| API-DPDEL-008 | POST `/partner/deliveries/{deliveryId}/arrived-at-customer` | D06 | DP (assigned) | **Idem** | FR-DEL-026 |
| API-DPDEL-009 | POST `/partner/deliveries/{deliveryId}/complete` | T15/D07: method OTP \| PHOTO, otp?, photoFileId?, cashCollected? | DP (assigned) | **Idem** | FR-DEL-030..033 |
| API-DPDEL-010 | POST `/partner/deliveries/{deliveryId}/customer-unreachable` | Start unreachable flow | DP (assigned) | **Idem** | FR-DEL-034 |
| API-DPDEL-011 | POST `/partner/deliveries/{deliveryId}/unassign` | Request unassignment (reason) | DP (assigned) | **Idem** | FR-DEL-035 |
| API-DPDEL-012 | POST `/partner/deliveries/{deliveryId}/acknowledge` | Acknowledge manual assignment | DP (assigned) | **Idem** | FR-DISP-011 |
| API-DPDEL-013 | GET `/partner/deliveries?from&to&cursor` | Delivery history | DP | — | FR-DEL-037 |
| API-EARN-001 | GET `/partner/me/earnings/summary?period=day\|week\|month&date` | Totals & breakdown | DP | — | FR-EARN-002 |
| API-EARN-002 | GET `/partner/me/earnings?from&to&cursor` | Earnings entries | DP | — | FR-EARN-002 |
| API-EARN-003 | GET `/partner/me/earnings/deliveries/{deliveryId}` | Per-delivery breakdown | DP | — | FR-EARN-001 |
| API-EARN-004 | GET `/partner/me/incentives` | Active programs & progress (CORE) | DP | — | FR-EARN-003 |
| API-EARN-005 | GET `/partner/me/cash` | Cash-in-hand balance & cap | DP | — | FR-EARN-005 |
| API-EARN-006 | GET `/partner/me/cash/transactions?cursor` | Collections & deposits | DP | — | FR-EARN-005 |
| API-EARN-007 | GET `/partner/me/payouts?cursor` | Payout history | DP | — | FR-EARN-006 |
| API-EARN-008 | GET `/partner/me/payouts/{payoutId}` | Payout details | DP | — | FR-EARN-006 |
| API-EARN-009 | GET `/partner/me/performance` | Acceptance, completion, on-time rates | DP | — | FR-EARN-007 |
| API-EARN-010 | GET `/partner/me/ratings` | Rating summary & anonymized feedback | DP | — | FR-EARN-007 |
| API-EARN-011 | GET `/partner/me/bank-account` | Masked bank details | DP | — | FR-EARN-006 |
| API-EARN-012 | POST `/partner/me/bank-account/change-requests` | Change bank details (reauth; payouts held) | DP | **Idem** | FR-EARN-006 |

### Administration — `API-ADM`

All paths prefixed `/admin`. Permissions in brackets. ★ = reason required & high-sensitivity audit; ⧉ = maker-checker (CORE).

| ID | Method & path | Purpose | Permission | FR |
|---|---|---|---|---|
| API-ADM-001 | GET `/dashboard` | Platform KPIs & alerts summary | dashboard:read | FR-ADMIN-002 |
| API-ADM-002 | GET `/alerts?status&type` | Operational alerts | ops:monitor | FR-ADMIN-002 |
| API-ADM-003 | POST `/alerts/{id}/acknowledge` | Acknowledge / resolve alert | ops:monitor | FR-ADMIN-002 |
| API-ADM-004 | GET `/ops/map?zoneId` | Live map snapshot (CORE) | ops:monitor | FR-ADMIN-003 |
| API-ADM-010 | GET `/users?role&status&q&page` | Search users | user:read | FR-ADMIN-010 |
| API-ADM-011 | GET `/users/{id}` | User 360 (masked PII) | user:read | FR-ADMIN-010 |
| API-ADM-012 | POST `/users/{id}/suspend` ★ | Suspend | user:suspend | FR-AUTH-040 |
| API-ADM-013 | POST `/users/{id}/unsuspend` ★ | Lift suspension | user:suspend | FR-AUTH-042 |
| API-ADM-014 | POST `/users/{id}/logout-all` ★ | Force logout | user:sessions | FR-ADMIN-010 |
| API-ADM-015 | POST `/users/{id}/pii-reveal` ★ | Reveal masked PII fields (reason) | pii:reveal | FR-ADMIN-010 |
| API-ADM-016 | POST `/users/{id}/wallet-adjustments` ★⧉ | Credit/debit wallet | wallet:adjust | FR-ADMIN-010 |
| API-ADM-017 | POST `/users/{id}/cod-block` ★ | Set/clear COD block | user:flags | FR-ADMIN-010 |
| API-ADM-018 | POST `/users/{id}/recover` ★ | Complete account recovery (CORE) | account:recover | FR-AUTH-014 |
| API-ADM-019 | GET `/users/{id}/sessions` | User's sessions | user:sessions | FR-ADMIN-010 |
| API-ADM-020 | GET `/restaurant-applications?status&page` | Application queue | restaurant:review | FR-ADMIN-020 |
| API-ADM-021 | GET `/restaurant-applications/{id}` | Application details | restaurant:review | FR-ADMIN-020 |
| API-ADM-022 | POST `/restaurant-applications/{id}/start-review` | Claim for review | restaurant:review | FR-ADMIN-020 |
| API-ADM-023 | POST `/restaurant-applications/{id}/approve` ★ | Approve | restaurant:approve | FR-REST-004 |
| API-ADM-024 | POST `/restaurant-applications/{id}/reject` ★ | Reject with reason | restaurant:approve | FR-REST-005 |
| API-ADM-025 | POST `/restaurant-applications/{id}/request-changes` | Field/document comments | restaurant:review | FR-REST-003 |
| API-ADM-026 | GET `/restaurants?status&zone&q&page` | Restaurants | restaurant:read | FR-ADMIN-021 |
| API-ADM-027 | GET `/restaurants/{id}` | Restaurant 360 | restaurant:read | FR-ADMIN-021 |
| API-ADM-028 | PATCH `/restaurants/{id}` ★ | Edit non-financial fields | restaurant:update | FR-ADMIN-021 |
| API-ADM-029 | POST `/restaurants/{id}/suspend` ★ | Suspend (cancelActive?) | restaurant:suspend | FR-ADMIN-023 |
| API-ADM-030 | POST `/restaurants/{id}/unsuspend` ★ | Unsuspend | restaurant:suspend | FR-ADMIN-023 |
| API-ADM-031 | POST `/branches/{id}/suspend` ★ | Suspend branch | restaurant:suspend | FR-ADMIN-023 |
| API-ADM-032 | POST `/branches/{id}/unsuspend` ★ | Unsuspend branch | restaurant:suspend | FR-ADMIN-023 |
| API-ADM-033 | POST `/branches/{id}/approve` ★ | Approve new branch | restaurant:approve | FR-REST-011 |
| API-ADM-034 | GET `/change-requests?type&status` | Legal/tax/bank change requests | restaurant:review | FR-ADMIN-022 |
| API-ADM-035 | POST `/change-requests/{id}/approve` ★ | Approve change | restaurant:approve | FR-ADMIN-022 |
| API-ADM-036 | POST `/change-requests/{id}/reject` ★ | Reject change | restaurant:approve | FR-ADMIN-022 |
| API-ADM-037 | PUT `/restaurants/{id}/commission` ★⧉ | Set commission override (effective date) | commission:write | FR-ADMIN-072 |
| API-ADM-038 | PUT `/restaurants/{id}/cod` ★ | Enable/disable COD | restaurant:update | FR-ADMIN-021 |
| API-ADM-039 | POST `/menu-items/{id}/hide` ★ | Moderate item | menu:moderate | FR-MENU-015 |
| API-ADM-040 | GET `/documents/{id}/url` | Signed URL for verification document (logged) | document:read | FR-FILE-004 |
| API-ADM-041 | GET `/partner-applications?status&zone&page` | Partner queue | partner:review | FR-ADMIN-030 |
| API-ADM-042 | GET `/partner-applications/{id}` | Application | partner:review | FR-ADMIN-030 |
| API-ADM-043 | POST `/partner-applications/{id}/approve` ★ | Approve | partner:approve | FR-DP-003 |
| API-ADM-044 | POST `/partner-applications/{id}/reject` ★ | Reject | partner:approve | FR-ADMIN-030 |
| API-ADM-045 | POST `/partner-applications/{id}/request-changes` | Comments | partner:review | FR-ADMIN-030 |
| API-ADM-046 | GET `/partners?status&online&zone&q&page` | Partners | partner:read | FR-ADMIN-031 |
| API-ADM-047 | GET `/partners/{id}` | Partner 360 | partner:read | FR-ADMIN-031 |
| API-ADM-048 | POST `/partners/{id}/suspend` ★ | Suspend | partner:suspend | FR-ADMIN-031 |
| API-ADM-049 | POST `/partners/{id}/unsuspend` ★ | Unsuspend | partner:suspend | FR-ADMIN-031 |
| API-ADM-050 | POST `/partners/{id}/force-offline` ★ | Force offline | partner:ops | FR-ADMIN-031 |
| API-ADM-051 | POST `/partners/{id}/cash-deposits` ★ | Record cash remittance | partner:cash | FR-EARN-005 |
| API-ADM-052 | POST `/partners/{id}/earning-adjustments` ★⧉ | Adjust earnings | earnings:adjust | FR-EARN-004 |
| API-ADM-053 | GET `/partners/{id}/location-trail?deliveryId` | Location trail for a delivery (logged) | partner:location | FR-ADMIN-040 |
| API-ADM-054 | POST `/vehicles/{id}/verify` ★ | Verify vehicle docs | partner:review | FR-DP-005 |
| API-ADM-060 | GET `/orders?q&status&zone&restaurantId&partnerId&from&to&page` | Search orders | order:read:any | FR-ADMIN-040 |
| API-ADM-061 | GET `/orders/{id}` | Order 360 (payments, webhooks, assignments, trail, notifications) | order:read:any | FR-ADMIN-040 |
| API-ADM-062 | POST `/orders/{id}/cancel` ★ | Cancel with fault attribution | order:cancel:any | FR-ADMIN-041 |
| API-ADM-063 | POST `/orders/{id}/mark-delivered` ★ | Admin T15 with evidence | order:override | FR-ADMIN-041 |
| API-ADM-064 | POST `/orders/{id}/mark-failed` ★ | T16 | order:override | FR-ADMIN-041 |
| API-ADM-065 | POST `/orders/{id}/extend-acceptance` ★ | Extend acceptance timer once | order:ops | FR-ADMIN-041 |
| API-ADM-066 | POST `/orders/{id}/notifications/resend` | Resend a notification | order:ops | FR-ADMIN-041 |
| API-ADM-067 | GET `/orders/{id}/audit` | Order audit trail | audit:read | FR-ADMIN-040 |
| API-ADM-068 | PATCH `/orders/{id}/delivery-address` ★ | Support address correction (≤ 500 m) (CORE) | order:ops | FR-ORDER-032 |
| API-ADM-070 | GET `/deliveries?status&escalated&zone&page` | Dispatch board | dispatch:read | FR-DISP-009 |
| API-ADM-071 | GET `/deliveries/{id}/candidates` | Ranked eligible partners | dispatch:assign | FR-DISP-011 |
| API-ADM-072 | POST `/deliveries/{id}/assign` ★ | Manual assignment (force?) | dispatch:assign | FR-DISP-011 |
| API-ADM-073 | POST `/deliveries/{id}/reassign` ★ | Reassign | dispatch:assign | FR-DISP-012 |
| API-ADM-074 | POST `/deliveries/{id}/redispatch` | Restart automatic dispatch | dispatch:assign | FR-DISP-009 |
| API-ADM-075 | POST `/deliveries/{id}/extend-deadline` ★ | Extend no-partner deadline once | dispatch:assign | FR-DISP-010 |
| API-ADM-080 | GET `/payments?status&provider&from&to&q&page` | Payments | payment:read | FR-ADMIN-050 |
| API-ADM-081 | GET `/payments/{id}` | Payment + attempts + events | payment:read | FR-ADMIN-050 |
| API-ADM-082 | POST `/payments/{id}/sync` ★ | Re-fetch provider status & apply | payment:ops | FR-ADMIN-050 |
| API-ADM-083 | GET `/webhook-events?provider&status&page` | Webhook log | payment:read | FR-ADMIN-050 |
| API-ADM-084 | GET `/refunds?status&page` | Refunds | refund:read | FR-ADMIN-051 |
| API-ADM-085 | POST `/orders/{id}/refunds` ★ | Initiate refund (amount, items, destination, reason) — Idem | refund:create | FR-ADMIN-051 |
| API-ADM-086 | POST `/refunds/{id}/approve` ★⧉ | Approve refund above limit | refund:approve | FR-REFUND-008 |
| API-ADM-087 | POST `/refunds/{id}/retry` ★ | Retry failed refund | refund:create | FR-ADMIN-051 |
| API-ADM-088 | GET `/reconciliation/runs` | Reconciliation runs | finance:read | FR-RECON-001 |
| API-ADM-089 | GET `/reconciliation/exceptions?status` | Exceptions | finance:read | FR-RECON-002 |
| API-ADM-090 | POST `/reconciliation/exceptions/{id}/resolve` ★ | Resolve with note | finance:write | FR-RECON-002 |
| API-ADM-091 | GET `/payout-batches?type&status` | Payout batches | payout:read | FR-ADMIN-121 |
| API-ADM-092 | POST `/payout-batches` ★ | Generate batch for period (Idem) | payout:create | FR-SETTLE-002 |
| API-ADM-093 | GET `/payout-batches/{id}` | Batch with lines | payout:read | FR-ADMIN-121 |
| API-ADM-094 | POST `/payout-batches/{id}/approve` ★⧉ | Approve batch | payout:approve | FR-SETTLE-003 |
| API-ADM-095 | GET `/payout-batches/{id}/export` | Bank transfer file | payout:approve | FR-ADMIN-121 |
| API-ADM-096 | POST `/payout-batches/{id}/lines/{lineId}/mark-paid` ★ | Record UTR | payout:execute | FR-SETTLE-003 |
| API-ADM-097 | POST `/payout-batches/{id}/lines/{lineId}/mark-failed` ★ | Record failure | payout:execute | FR-SETTLE-003 |
| API-ADM-100 | GET `/coupons?status&q&page` | Coupons | coupon:read | FR-ADMIN-060 |
| API-ADM-101 | POST `/coupons` ★ | Create | coupon:write | FR-ADMIN-060 |
| API-ADM-102 | GET `/coupons/{id}` | Details & stats | coupon:read | FR-ADMIN-060 |
| API-ADM-103 | PATCH `/coupons/{id}` ★ | Update (terms locked after redemption) | coupon:write | FR-ADMIN-060 |
| API-ADM-104 | POST `/coupons/{id}/deactivate` ★ | Deactivate | coupon:write | FR-ADMIN-060 |
| API-ADM-105 | GET `/coupons/{id}/redemptions?page` | Redemptions | coupon:read | FR-ADMIN-060 |
| API-ADM-106 | GET `/promotions?scope&status` | Promotions | promo:read | FR-ADMIN-061 |
| API-ADM-107 | POST `/promotions` ★ | Create platform promotion | promo:write | FR-ADMIN-061 |
| API-ADM-108 | PATCH `/promotions/{id}` ★ | Update | promo:write | FR-ADMIN-061 |
| API-ADM-109 | POST `/promotions/{id}/approve` ★ | Approve restaurant promotion | promo:approve | FR-RPROMO-001 |
| API-ADM-110 | GET `/banners` | Banners | content:read | FR-ADMIN-061 |
| API-ADM-111 | POST `/banners` | Create | content:write | FR-ADMIN-061 |
| API-ADM-112 | PATCH `/banners/{id}` | Update/schedule | content:write | FR-ADMIN-061 |
| API-ADM-113 | DELETE `/banners/{id}` | Remove | content:write | FR-ADMIN-061 |
| API-ADM-114 | GET `/collections` | Curated collections | content:read | FR-ADMIN-061 |
| API-ADM-115 | POST `/collections` | Create | content:write | FR-ADMIN-061 |
| API-ADM-116 | PATCH `/collections/{id}` | Update members/order | content:write | FR-ADMIN-061 |
| API-ADM-117 | DELETE `/collections/{id}` | Remove | content:write | FR-ADMIN-061 |
| API-ADM-120 | GET `/zones` | Zones | zone:read | FR-ADMIN-070 |
| API-ADM-121 | POST `/zones` ★ | Create (GeoJSON polygon) | zone:write | FR-ADMIN-070 |
| API-ADM-122 | GET `/zones/{id}` | Zone | zone:read | FR-ADMIN-070 |
| API-ADM-123 | PATCH `/zones/{id}` ★ | Update polygon/settings | zone:write | FR-ADMIN-070 |
| API-ADM-124 | POST `/zones/{id}/suspend` ★ | Suspend delivery in zone | zone:ops | FR-ADMIN-070 |
| API-ADM-125 | POST `/zones/{id}/activate` ★ | Re-activate | zone:ops | FR-ADMIN-070 |
| API-ADM-126 | PUT `/zones/{id}/surge` ★ | Set surge (amount, until) (CORE) | zone:ops | BR-PRICE-007 |
| API-ADM-130 | GET `/settings` | Platform settings | settings:read | FR-ADMIN-100 |
| API-ADM-131 | PATCH `/settings/{key}` ★ | Update setting | settings:write (critical: S) | FR-ADMIN-100 |
| API-ADM-132 | GET `/settings/{key}/history` | Change history | settings:read | FR-CFG-001 |
| API-ADM-133 | GET `/fee-schedules` | Fee schedules | pricing:read | FR-ADMIN-071 |
| API-ADM-134 | POST `/fee-schedules` ★⧉ | New effective-dated schedule | pricing:write (S) | FR-ADMIN-071 |
| API-ADM-135 | GET `/tax-rules` | Tax rules | pricing:read | FR-ADMIN-071 |
| API-ADM-136 | POST `/tax-rules` ★⧉ | New effective-dated tax rule | pricing:write (S) | FR-ADMIN-071 |
| API-ADM-137 | GET `/commission-plans` | Default commission plans | commission:read | FR-ADMIN-072 |
| API-ADM-138 | POST `/commission-plans` ★⧉ | New plan | commission:write (S) | FR-ADMIN-072 |
| API-ADM-139 | GET `/partner-pay-plans` | Partner pay configs | earnings:read | FR-ADMIN-073 |
| API-ADM-140 | POST `/partner-pay-plans` ★⧉ | New pay plan | earnings:config (S) | FR-ADMIN-073 |
| API-ADM-141 | GET `/incentive-programs` | Incentives (CORE) | earnings:read | FR-EARN-003 |
| API-ADM-142 | POST `/incentive-programs` ★ | Create (CORE) | earnings:config | FR-EARN-003 |
| API-ADM-143 | PATCH `/incentive-programs/{id}` ★ | Update/end (CORE) | earnings:config | FR-EARN-003 |
| API-ADM-144 | GET `/feature-flags` | Flags (CORE) | flags:read | FR-ADMIN-101 |
| API-ADM-145 | POST `/feature-flags` ★ | Create (CORE) | flags:write (S) | FR-ADMIN-101 |
| API-ADM-146 | PATCH `/feature-flags/{key}` ★ | Update targeting/rollout (CORE) | flags:write (S) | FR-ADMIN-101 |
| API-ADM-147 | GET `/approvals?status` | Maker-checker queue (CORE) | approvals:read | ⧉ |
| API-ADM-148 | POST `/approvals/{id}/approve` ★ | Approve (approver ≠ maker) (CORE) | approvals:decide | ⧉ |
| API-ADM-149 | POST `/approvals/{id}/reject` ★ | Reject (CORE) | approvals:decide | ⧉ |
| API-ADM-150 | GET `/tickets?queue&status&priority&assignee&page` | Ticket queue | support:read | FR-ADMIN-080 |
| API-ADM-151 | GET `/tickets/{id}` | Ticket + context | support:read | FR-ADMIN-080 |
| API-ADM-152 | POST `/tickets/{id}/messages` | Reply / internal note | support:write | FR-ADMIN-080 |
| API-ADM-153 | POST `/tickets/{id}/assign` | Assign agent | support:assign | FR-ADMIN-080 |
| API-ADM-154 | PATCH `/tickets/{id}` | Status/priority/category | support:write | FR-ADMIN-080 |
| API-ADM-155 | POST `/tickets/{id}/escalate` | Escalate tier | support:write | FR-ADMIN-080 |
| API-ADM-156 | GET `/macros` | Reply templates | support:read | FR-ADMIN-080 |
| API-ADM-157 | POST `/macros` | Create template | support:admin | FR-ADMIN-080 |
| API-ADM-158 | GET `/complaints?against&status&page` | Complaints (CORE) | complaint:read | FR-ADMIN-081 |
| API-ADM-159 | POST `/complaints` | Log complaint (CORE) | complaint:write | FR-ADMIN-081 |
| API-ADM-160 | PATCH `/complaints/{id}` ★ | Investigate/resolve/penalize (CORE) | complaint:write | FR-ADMIN-081 |
| API-ADM-161 | GET `/disputes?status` | Disputes (CORE) | dispute:read | FR-ADMIN-042 |
| API-ADM-162 | POST `/disputes/{id}/resolve` ★ | Decide outcome (CORE) | dispute:resolve | FR-ADMIN-042 |
| API-ADM-163 | GET `/reviews/reports?status` | Reported reviews (CORE) | review:moderate | FR-ADMIN-082 |
| API-ADM-164 | POST `/reviews/{id}/hide` ★ | Hide review | review:moderate | FR-ADMIN-082 |
| API-ADM-165 | POST `/reviews/{id}/unhide` ★ | Restore review | review:moderate | FR-ADMIN-082 |
| API-ADM-170 | GET `/analytics/overview?from&to&zone` | KPI series | analytics:read | FR-ADMIN-090 |
| API-ADM-171 | GET `/analytics/orders?from&to&zone&groupBy` | Orders & cancellations | analytics:read | FR-ADMIN-090 |
| API-ADM-172 | GET `/analytics/dispatch?from&to&zone` | Dispatch & delivery performance | analytics:read | FR-ADMIN-090 |
| API-ADM-173 | GET `/analytics/restaurants?from&to&sort` | Restaurant leaderboard | analytics:read | FR-ADMIN-090 |
| API-ADM-174 | GET `/analytics/funnel?from&to` | Conversion funnel (CORE) | analytics:read | FR-ADMIN-090 |
| API-ADM-175 | POST `/reports` | Request export (202) (CORE) | reports:export (+pii:export) | FR-ADMIN-091 |
| API-ADM-176 | GET `/reports/{id}` | Export status / URL (CORE) | reports:export | FR-ADMIN-091 |
| API-ADM-180 | GET `/roles` | Roles & permissions | iam:read | FR-ADMIN-110 |
| API-ADM-181 | POST `/roles` ★ | Custom admin role (CORE) | iam:write (S) | FR-ADMIN-110 |
| API-ADM-182 | PATCH `/roles/{id}` ★ | Edit role permissions (CORE) | iam:write (S) | FR-ADMIN-110 |
| API-ADM-183 | GET `/permissions` | Permission catalog | iam:read | FR-ADMIN-110 |
| API-ADM-184 | POST `/users/{id}/roles` ★ | Grant platform role | iam:assign (S) | FR-ADMIN-110 |
| API-ADM-185 | DELETE `/users/{id}/roles/{role}` ★ | Revoke platform role | iam:assign (S) | FR-ADMIN-110 |
| API-ADM-186 | POST `/staff-invitations` ★ | Invite admin/support account | iam:assign (S) | FR-ADMIN-111 |
| API-ADM-187 | GET `/audit-logs?actor&target&action&from&to&page` | Audit search | audit:read | FR-AUDIT-003 |
| API-ADM-188 | POST `/audit-logs/export` ★ | Export (CORE) | audit:export (S) | FR-AUDIT-003 |
| API-ADM-190 | GET `/faqs` | FAQs | content:read | FR-ADMIN-122 |
| API-ADM-191 | POST `/faqs` | Create | content:write | FR-ADMIN-122 |
| API-ADM-192 | PATCH `/faqs/{id}` | Update | content:write | FR-ADMIN-122 |
| API-ADM-193 | DELETE `/faqs/{id}` | Delete | content:write | FR-ADMIN-122 |
| API-ADM-194 | GET `/legal-documents?type` | Versions | content:read | FR-ADMIN-122 |
| API-ADM-195 | POST `/legal-documents` ★ | Publish version (material?) | legal:publish (S) | FR-ADMIN-122 |
| API-ADM-196 | GET `/cuisines` | Cuisine catalog | content:read | FR-ADMIN-122 |
| API-ADM-197 | POST `/cuisines` | Create | content:write | FR-ADMIN-122 |
| API-ADM-198 | PATCH `/cuisines/{id}` | Update/deactivate | content:write | FR-ADMIN-122 |
| API-ADM-199 | POST `/broadcasts` ★ | Segment notification (CORE) | notify:broadcast | FR-ADMIN-123 |
| API-ADM-200 | GET `/notification-templates` | Templates | notify:templates | FR-NOTIF-005 |
| API-ADM-201 | PUT `/notification-templates/{key}` ★ | New template version | notify:templates (S) | FR-NOTIF-005 |
| API-ADM-202 | GET `/jobs/failed?queue` | Dead-letter jobs | ops:jobs | E27 |
| API-ADM-203 | POST `/jobs/{queue}/{jobId}/retry` ★ | Retry dead job | ops:jobs | E27 |

### System — `API-SYS`

| ID | Method & path | Purpose | Auth |
|---|---|---|---|
| API-SYS-001 | GET `/health/live` | Liveness (process up) | Public (no envelope) |
| API-SYS-002 | GET `/health/ready` | Readiness (DB, Redis, migrations) — degraded flags | Internal network |
| API-SYS-003 | GET `/metrics` | Prometheus metrics | Internal network / token |
| API-SYS-004 | GET `/api/v1/openapi.json` + `/api/docs` | Generated OpenAPI + Swagger UI | Public in dev; restricted in prod |
| API-SYS-005 | GET `/api/v1/config/public` | Public client config (feature flags for app, min app version, maps key alias) | Public |

---

## 14.3 Detailed specifications for critical endpoints

The remaining endpoints' request/response schemas are defined as Zod schemas in `packages/validation` during implementation and published via OpenAPI; their business rules, permissions and errors are already fixed above and in the referenced FRs.

### API-AUTH-004 — POST /api/v1/auth/login
- **Headers:** `X-Client-App` (required), `Origin` (must match app allowlist), `X-Request-Id`.
- **Body:** `{ "identifier": "user@example.com" | "+919876543210", "password": "string(8..128)" }`
- **200:** `{ data: { accessToken, accessTokenExpiresAt, user: { id, fullName, roles, emailVerified, phoneVerified, profileComplete }, session: { id } } }` + `Set-Cookie: fos_rt_customer=…; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=2592000`
- **200 (MFA):** `{ data: { mfaRequired: true, mfaToken (5 min, single use) } }` (admin)
- **Errors:** 400 VALIDATION_ERROR · 401 AUTH_INVALID_CREDENTIALS · 403 AUTH_ACCOUNT_SUSPENDED, AUTH_APP_NOT_PERMITTED, ACCOUNT_PENDING_DELETION (after a correct password during the deletion grace period; `error.details` carries `{ code: "REACTIVATION_TOKEN", message: <token> }` for API-AUTH-023) · 429 RATE_LIMITED.
- **Rules:** BR-AUTH-001, 004, 005, 010. **Rate limit:** RL-AUTH. **Idempotency:** not applicable (each success creates a session by design).

### API-AUTH-005 — POST /api/v1/auth/refresh
- **Headers:** Cookie `fos_rt_<app>`, `X-Client-App`, `Origin`.
- **Body:** none.
- **200:** `{ data: { accessToken, accessTokenExpiresAt } }` + rotated `Set-Cookie`.
- **Errors:** 401 AUTH_REFRESH_INVALID / AUTH_REFRESH_REUSED / AUTH_SESSION_EXPIRED / AUTH_SESSION_REVOKED (all clear the cookie) · 409 AUTH_REFRESH_RACE (do not clear cookie; client retries once after 100–300 ms) · 403 CSRF_ORIGIN_MISMATCH.
- **Rules:** FR-AUTH-022, BR-AUTH-006, BR-AUTH-007, BR-AUTH-019.

### API-CART-002 — POST /api/v1/cart/items
- **Body:** `{ branchId, foodItemId, variantId?, optionIds: string[] (≤ 30), quantity: int 1..20, instructions?: string ≤ 250, replaceCart?: boolean }`
- **200/201:** `{ data: { cart: { id, branch: { id, name, isAcceptingOrders }, lines: [ { id, foodItemId, name, variant, options:[{id,name,price}], quantity, unitPrice, lineTotal, dietaryMarker, status: "OK"|"UNAVAILABLE"|"PRICE_CHANGED" } ], couponCode?, preview: PriceBreakdown, version } } }`
- **Errors:** 404 ITEM_NOT_FOUND · 409 CART_BRANCH_CONFLICT `{ existingCart: { branchId, restaurantName, itemCount } }` · 422 ITEM_UNAVAILABLE, VARIANT_REQUIRED, CUSTOMIZATION_INVALID `{ details: [{ groupId, code: "MIN_NOT_MET"|"MAX_EXCEEDED"|"OPTION_UNAVAILABLE"|"OPTION_NOT_IN_GROUP" }] }`, CART_LIMIT_EXCEEDED.

### API-CHK-001 — POST /api/v1/checkout/sessions
- **Body:** `{ cartId, addressId, paymentMethod: "ONLINE"|"COD"|"WALLET", useWallet: boolean, tipAmount: int (paise, 0..50000, multiple of 100), deliveryInstructions?: string ≤ 200, contactless?: boolean, contact?: { name, phone } }`
- **201:** `{ data: { id, status: "OPEN", expiresAt, quote: { lines:[…], itemsSubtotal, promotionDiscount, couponDiscount, packagingFee, deliveryFee, surgeFee, smallOrderFee, platformFee, taxes:[{code,label,base,rateBps,amount}], tip, walletApplied, total, payable, currency, savings }, eta: { minMinutes, maxMinutes }, address: {…snapshot}, paymentMethods: [...], warnings: [] } }`
- **Errors:** 422 CART_EMPTY, CART_INVALID, ADDRESS_NOT_SERVICEABLE, BRANCH_NOT_ACCEPTING_ORDERS, ORDER_BELOW_MINIMUM, ORDER_ABOVE_MAXIMUM, COD_NOT_AVAILABLE, COUPON_* · 403 AUTH_VERIFICATION_REQUIRED, PROFILE_INCOMPLETE.

### API-CHK-004 — POST /api/v1/checkout/sessions/{id}/confirm
- **Headers:** `Idempotency-Key` (required, UUID).
- **Body:** `{ expectedPayable: int }`
- **201:** `{ data: { order: { id, number, status: "PAYMENT_PENDING"|"PLACED", payable }, payment?: { id, provider: "RAZORPAY", providerOrderId, keyId, amount, currency, prefill: { name, email, contact } } } }`
- **200 (replay):** same body, header `Idempotent-Replayed: true`.
- **Errors:** 409 IDEMPOTENCY_KEY_REUSED, CART_CHANGED, CHECKOUT_SESSION_CONSUMED `{ orderId }` · 410 CHECKOUT_SESSION_EXPIRED · 422 PRICE_CHANGED `{ previousPayable, newQuote }`, ITEM_UNAVAILABLE, COUPON_EXPIRED, COUPON_LIMIT_REACHED, INSUFFICIENT_WALLET_BALANCE, BRANCH_NOT_ACCEPTING_ORDERS · 502 PAYMENT_PROVIDER_UNAVAILABLE (order created; `payment` null; client retries API-PAY-002).

### API-PAY-004 — POST /api/v1/payments/{paymentId}/verify
- **Headers:** `Idempotency-Key`.
- **Body (Razorpay):** `{ providerPaymentId, providerOrderId, signature }`
- **200:** `{ data: { paymentStatus: "CAPTURED"|"PENDING"|"FAILED", orderStatus } }` — `PENDING` means signature valid but provider not yet captured; client keeps polling.
- **Errors:** 400 PAYMENT_SIGNATURE_INVALID (security log) · 404 · 409 PAYMENT_ORDER_MISMATCH · 502 PAYMENT_PROVIDER_UNAVAILABLE (retryable; webhook will settle).

### API-PAY-007 — POST /api/v1/payments/webhooks/{provider}
- **Headers:** provider signature (`X-Razorpay-Signature`), event ID (`X-Razorpay-Event-Id`).
- **Body:** raw provider JSON (≤ 1 MB). Body parser for this route preserves raw bytes for HMAC verification.
- **Responses:** 200 (accepted or duplicate) · 400 malformed · 401 invalid signature. No envelope.
- **Processing:** enqueue JOB-PAY-001 keyed by event ID; handler idempotent; status precedence rules (FR-PAY-009).

### API-RORD-004 — POST /api/v1/merchant/orders/{orderId}/accept
- **Headers:** `Idempotency-Key`, `If-Match` (optional order version).
- **Body:** `{ prepTimeMinutes?: int 5..90 }`
- **200:** `{ data: { order: { id, status: "ACCEPTED", acceptedAt, readyBy, version } } }`
- **Errors:** 403 FORBIDDEN (not branch member / lacks order:accept) · 404 · 409 ORDER_STATE_CONFLICT `{ currentStatus, actedBy? }`, CONFLICT_STALE_VERSION · 422 PREP_TIME_OUT_OF_RANGE.

### API-DPDEL-002 — POST /api/v1/partner/offers/{offerId}/accept
- **Headers:** `Idempotency-Key`.
- **Body:** `{ lat, lng, accuracy }` (current position; used for ETA)
- **200:** `{ data: { delivery: { id, status: "ASSIGNED", order: { number, itemsCount, paymentType, codAmount? }, pickup: { branchName, address, location, phoneMasked, pickupCode }, dropArea, etaToRestaurant } } }`
- **Errors:** 404 OFFER_NOT_FOUND · 409 OFFER_EXPIRED, OFFER_ALREADY_TAKEN, OFFER_WITHDRAWN, PARTNER_NOT_ELIGIBLE `{ reason }`.
- **Rules:** FR-DISP-006/007.

### API-DPDEL-009 — POST /api/v1/partner/deliveries/{deliveryId}/complete
- **Headers:** `Idempotency-Key` (client generates once per completion attempt and reuses on retries).
- **Body:** `{ method: "OTP"|"PHOTO", otp?: "^[0-9]{4}$", photoFileId?, cashCollected?: int, location: { lat, lng, accuracy }, deviceTime }`
- **200:** `{ data: { delivery: { id, status: "DELIVERED" }, earnings: { total, breakdown } } }`
- **Errors:** 409 DELIVERY_STATE_CONFLICT · 422 DELIVERY_OTP_INVALID `{ attemptsLeft }`, DELIVERY_OTP_LOCKED, PHOTO_PROOF_NOT_ALLOWED (not contactless/prepaid), COD_AMOUNT_MISMATCH · 403 FORBIDDEN (not assigned).

### API-ORD-007 — POST /api/v1/orders/{orderId}/cancel
- **Headers:** `Idempotency-Key`.
- **Body:** `{ quoteId, reasonCode: "CHANGED_MIND"|"ORDERED_BY_MISTAKE"|"DELAY"|"ADDRESS_ISSUE"|"PAYMENT_ISSUE"|"OTHER", note?: string ≤ 300 }`
- **200:** `{ data: { order: { id, status: "CANCELLED" }, cancellation: { fee, refund: { amount, destination, status, expectedBy } } } }`
- **Errors:** 409 ORDER_STATE_CONFLICT (state advanced; new preview required), CANCELLATION_QUOTE_STALE · 422 CANCELLATION_NOT_ALLOWED `{ reason: "ORDER_PICKED_UP"… , supportLink }`.

### API-ADM-085 — POST /api/v1/admin/orders/{orderId}/refunds
- **Headers:** `Idempotency-Key`.
- **Body:** `{ amount: int > 0, items?: [{ orderItemId, quantity }], destination: "SOURCE"|"WALLET", reasonCode, note (required ★), costBearer: "PLATFORM"|"RESTAURANT"|"PARTNER" }`
- **201:** `{ data: { refund: { id, status: "PROCESSING"|"REQUESTED"(needs approval)|"SUCCEEDED"(wallet) } } }`
- **Errors:** 422 REFUND_EXCEEDS_REFUNDABLE `{ refundable }`, REFUND_LIMIT_EXCEEDED (support agent above limit → creates REQUESTED pending approval instead when `requestApproval=true`) · 403 · 409.
