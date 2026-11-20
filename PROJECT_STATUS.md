# Project Status

_Last updated: 2026-11-20_

## Summary

| Item              | Status                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current phase     | **Phase 7 — Order management: complete; Phase 8 awaiting go-ahead**                                                                                                                                                                           |
| Next phase        | Phase 8 — Restaurant application                                                                                                                                                                                                              |
| SRS version       | FOS-SRS-001 v0.7.0 (APPROVED 2026-11-20; v0.7.0 adds owner-approved D-10…D-12)                                                                                                                                                                |
| Business features | Accounts and sign-in (all apps); customer backend for locations, addresses, restaurants, menus, discovery, search, favourites, cart, coupons, checkout, wallet, payments, orders, cancellations, refunds, invoices, support and notifications |

## Phases

| Phase                         | Status                                                    |
| ----------------------------- | --------------------------------------------------------- |
| 1 Requirements & architecture | ✅ Approved 2026-11-20 (defaults adopted for OD-01…OD-16) |
| 2 Repository & infrastructure | ✅ Complete 2026-11-20                                    |
| 3 Database                    | ✅ Complete 2026-11-20 (SRS changes D-1…D-3 approved)     |
| 4 Auth & security             | ✅ Complete 2026-11-20 (D-4…D-6 approved)                 |
| 5 Core customer backend       | ✅ Complete 2026-11-20 (D-7, D-8 approved)                |
| 6 Cart, pricing, checkout     | ✅ Complete 2026-11-20 (D-9 approved)                     |
| 7 Order management            | ✅ Complete 2026-11-20 (D-10…D-12 approved)               |
| 8 Restaurant application      | Not started                                               |
| 9 Delivery application        | Not started                                               |
| 10 Real-time                  | Not started                                               |
| 11 Admin                      | Not started                                               |
| 12 Frontend integration       | Not started                                               |
| 13 Testing & hardening        | Not started                                               |
| 14 Finalization               | Not started                                               |

## Phase 7 deliverables

Backend only (screens in Phase 12). The restaurant, partner and admin transitions (accept, reject, ready, pickup, deliver) exist in the state machine and are exposed by Phases 8, 9 and 11; tests drive them through the transition service.

| Area                  | Delivered                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order creation        | API-CHK-004 in one transaction: cart-hash and price re-check, stock locked and decremented, item/option/price/address snapshots, coupon reserved, wallet held, COD or online payment record, history and events; idempotent and race-safe; online payment initiated after commit                                                                                                                                        |
| State machine         | §10.3 transition table with allowed actors; version check under a row lock; timestamps; history (two rows for T13c); an outbox event per transition                                                                                                                                                                                                                                                                     |
| Outbox relay          | Leader-elected relay in the worker: sequence order, per-aggregate ordering when a consumer fails, retries with an ops alert, stale-event alert                                                                                                                                                                                                                                                                          |
| Payment reactions     | Capture places the order (coupon redeemed, wallet hold debited, acceptance timers); duplicate captures refunded; refund status kept on the order                                                                                                                                                                                                                                                                        |
| Timers                | Payment window (asks the provider before failing; gives back coupon, wallet and stock), acceptance reminder and timeout (full refund; branch auto-paused after 3 misses), auto-preparing, delay alerts, self-healing sweeper, checkout-session expiry                                                                                                                                                                   |
| Cancellations         | Preview with fee, refund split and quote id; customer cancels free before acceptance, free for 60 s after, then 50 % of food, 100 % + packaging while preparing, refused once ready; every other initiator with fault and full refund; split refunds (card to source, wallet to wallet), fee to the restaurant, food compensation for platform/partner-fault cancellations after cooking; abandon payment (API-PAY-005) |
| Settlement & invoices | Settlement split checked to balance and posted once; invoices numbered gap-free per financial year, issued on delivery, PDF download                                                                                                                                                                                                                                                                                    |
| Order reads           | History (status groups, date range, paging), active orders, snapshot details, status, timeline, delivery-details edits until pickup, reorder at current prices                                                                                                                                                                                                                                                          |
| Support               | Tickets (daily cap, SLA due times, replies, close, reopen within 7 days, CSAT), FAQs, legal pages and grievance officer; order issue reports with item refunds (small ones auto-approved to wallet), "not delivered" as an urgent ticket                                                                                                                                                                                |
| Notifications         | Versioned templates, dispatch with preferences, in-app inbox per app, delivery records with worker retries, push subscription registry, notifications for order, refund and ticket events to customers and branch staff                                                                                                                                                                                                 |

## Verification notes (Phase 7)

- ✅ 442 tests pass repo-wide; the API's 333 include 42 new Phase 7 integration tests and 26 new unit tests (transition table, cancellation policy and quote ids, settlement balance, templates, Razorpay order-payments listing).
- ✅ Ledger integrity is asserted after placement, cancellation with fee, split refunds and settlement; a delivered order's liability ends at zero.
- ✅ Worker smoke boot (health port 4101): Redis and database up, scheduled jobs and the relay ran, clean shutdown, no errors. No schema drift (`db:drift`).
- Bugs found and fixed while building: BullMQ rejects job ids with a single `:`, so the order timers committed in step 3 would never have been scheduled outside tests (ids now use `-`, and the test queue enforces the same rule); coupon release ignored already-redeemed coupons, so COD cancellations kept the coupon used.
- ⚠️ SMS, email and push still go to development sinks; the worker still refuses to start in production until real providers are configured.
- ⚠️ CI still hasn't run (nothing pushed), so §22.1a–f rows are _Implemented_, not _Verified_.

## Phase 6 deliverables

Backend only (screens in Phase 12). Placing the order (API-CHK-004) and the order transitions that react to payments are Phase 7; everything up to a priced, validated checkout and a verified payment is here.

| Area            | Delivered                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pricing         | Pure, deterministic engine for BR-PRICE-001…012: line prices with variants and options, item discounts, best automatic promotion, coupon (with minimum after the promotion), packaging caps, slab delivery fee and free-delivery waiver (base fee only), surge cap, small-order and platform fees, per-component GST half-up, tip, wallet, funding split. Effective-dated tax and commission config |
| Cart            | Add/edit/remove with full validation (variant, customisation groups min/max, option and item availability, stock), identical-line merging, one restaurant per cart with explicit replace, 30-line/50-unit/20-per-line limits, revalidation flags (price changed, unavailable, removed), pricing preview for an address or location, guest-cart merge, instructions, 7-day expiry job                |
| Offers          | Automatic promotions (percent, flat, free delivery, BOGO; item and branch scope), coupon eligibility (window, zone, restaurant, segment incl. new users, payment method, global and per-user limits counting reservations), listing with "Add ₹X more" reasons, terms, validate-without-applying, reservation under a row lock with redeem/release                                                  |
| Checkout        | Sessions with full quote, address snapshot, config versions, cart hash and 10-minute expiry; re-quote on change with optimistic versions; COD eligibility (cap, restaurant, blocked customers), no wallet with COD, wallet-only and wallet-plus-online, contactless only when prepaid; payment-method availability                                                                                  |
| Ledger & wallet | Double-entry ledger with idempotent postings and locked balances, nightly integrity check; wallet credit lots, hold/debit/release, history with paging                                                                                                                                                                                                                                              |
| Payments        | Provider interface with a mock (scripted outcomes, real signatures) and a Razorpay adapter; initiation with provider-order reuse and 5-attempt limit; signature + provider-fetch verification; raw-body webhooks stored once and processed by the worker; status precedence; amount-mismatch and late-capture refunds with ops alerts; stuck-payment polling; outbox events for Phase 7             |
| Refunds         | Records bounded by the captured amount under lock, worker submission with backoff and ops hand-off, confirmation by webhook or poll, ledger by cost bearer, wallet refunds                                                                                                                                                                                                                          |
| Platform        | Idempotency-Key middleware (replay, conflicting reuse, concurrent duplicates), transactional outbox writer, deduplicated ops alerts, job queue abstraction, raw-body route hook                                                                                                                                                                                                                     |

## Verification notes (Phase 6)

- ✅ 373 tests pass repo-wide; the API’s 265 include 56 new Phase 6 integration tests and 38 new unit tests (pricing tables plus a 500-case seeded property test of invariants, payment precedence, signatures, Razorpay adapter with a stubbed network).
- ✅ Ledger integrity (`verify()` = no mismatches) is asserted after capture, refund and wallet flows; the order liability returns to zero after a full refund.
- ✅ Smoke boot of the real server: unsigned webhook → 401, public catalog and coupon terms open to guests, cart requires sign-in.
- Bugs found and fixed while building: the payments router (mounted at the API root) authenticated every later request, hiding the public catalog — middleware is now scoped and `routes.ts` documents the rule; `sum()` over `bigint` returned a Decimal and broke the ledger check; supertest JSON-encodes Buffers (test harness only — webhook tests send strings); test fixtures dated "now" conflicted with the 13:00 test clock.
- ⚠️ The Razorpay adapter is tested against a stubbed network only; it has not been run against Razorpay's test mode (needs test keys).
- ⚠️ CI still hasn't run (nothing pushed), so §22.1a–e rows are _Implemented_, not _Verified_.

## Phase 5 deliverables

Backend APIs for the customer app (screens follow in Phase 12). Typed client wrappers are in `@fos/api-client` (`createCustomerApi`).

| Area                | Delivered                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locations           | Geocoding adapter: mock Bengaluru gazetteer for development; `none` in production, which takes the manual-pin path. 30-day geocode cache; routing estimate (straight line × 1.3 at 22 km/h); India check; pin-distance warning. API-GEO-001…005                                        |
| Serviceability      | Zone lookup, same-zone rule, branch radius capped by the zone, reason codes. Branch status covers hours (split shifts, past-midnight slots), holidays, pause, manual close, FSSAI expiry, zone suspension, last-order cutoff and "closing soon"                                        |
| Delivery preview    | Fee slabs (BR-PRICE-003), surge with cap, small-order threshold, platform fee, ETA range (FR-DISC-010), from the effective-dated fee schedule                                                                                                                                          |
| Profile             | Profile and language; preferences (veg-only default, dietary tags, allergens); account status; consents. Email change (re-auth, new address unverified, old address told). Phone change (re-auth, code to new number, other devices signed out)                                        |
| Addresses           | CRUD with one HOME/WORK, 20-address limit, single default, soft delete, required pin, PIN-code checks, per-branch serviceability                                                                                                                                                       |
| Restaurants & menus | Brand page, branches with serviceability, branch header (status, weekly hours, FSSAI, delivery details), cached menu with smart sections, item cards and details (variants, customisations, allergen warnings), filters, ETag/304                                                      |
| Discovery           | Listing with 12 filters, 7 sorts, opaque cursors, closed places trailing. Home (banners, curated and built-in collections, specials, best-sellers, cuisines; cached per ~600 m cell, personal parts added per request). Collections, cuisines, dishes by category, facets, order again |
| Search              | Prefix full-text with weighted ranking, typo tolerance, suggestions, history (last 20 distinct), trending read, filters, paging                                                                                                                                                        |
| Favourites          | Restaurants and dishes, idempotent, listed with serviceability and availability where the customer is                                                                                                                                                                                  |
| Platform            | Typed settings service (defaults + `platform_settings`, 5 s cache); shared cursor pagination; optional authentication for public routes; one route table shared by the server and tests                                                                                                |

## Verification notes (Phase 5)

- ✅ 277 tests pass repo-wide; the API's 171 include 56 new Phase 5 integration tests against PostgreSQL + PostGIS + Redis and 35 new unit tests (branch status, fees and ETA, filters, sorting and cursors, geohash, search query safety).
- ✅ Smoke run of the real server on the seeded data: home sections, search, menu ETag (304 on repeat), listing in about 5–20 ms locally. `db:drift` reports no difference.
- Bugs found and fixed while building: a `|| true` made one discovery assertion vacuous; importing a helper from another test file ran that file's tests twice; the catalog router's middleware would have run for every later route (now scoped to its paths).
- ⚠️ CI still hasn't run (nothing pushed), so §22.1a–d rows are _Implemented_, not _Verified_.
- ⚠️ Performance targets (NFR-PERF-003…005) are not measured yet; load tests are Phase 13.

## Phase 4 deliverables

| Area              | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts          | Email + phone + password registration with consent; phone-OTP sign-in that creates customer accounts; phone and email verification; verification gate on all other features                                                                                                                                                                                                                                               |
| Credentials       | Argon2id passwords (m=19 MiB, t=2, p=1); policy checks (length, not email/phone, NCSC 100k breached-password list); forgot/reset by email link or phone code; change password                                                                                                                                                                                                                                             |
| Sessions          | 15-min HS256 access tokens with key rotation (`kid`), audience per app, token/permission versions; opaque refresh tokens (SHA-256 at rest) in `HttpOnly; SameSite=Strict` per-app cookies; rotation with 10 s race grace and family revocation on reuse; idle/absolute expiry per app; 10-session cap; Redis session cache with database fallback                                                                         |
| Abuse protection  | Lockout (5 failures → 15 min, doubling, 24 h cap); per-IP and per-identifier rate limits (Redis, in-memory fallback); OTP cooldown, hourly caps, 5 attempts, HMAC-stored codes; no account enumeration; trusted-Origin check on cookie endpoints                                                                                                                                                                          |
| Authorization     | IAM service resolving platform roles and restaurant memberships into permissions; app–role compatibility with onboarding scope for restaurant/delivery applicants; role changes apply on the next request; `/me` and `/me/permissions`                                                                                                                                                                                    |
| Admin             | Password + emailed sign-in code (interim for TOTP, BR-AUTH-018); no self sign-up                                                                                                                                                                                                                                                                                                                                          |
| Account lifecycle | Step-up re-authentication; deletion with blockers and 30-day grace; reactivation on sign-in; hourly anonymisation job in the worker                                                                                                                                                                                                                                                                                       |
| Audit & messages  | Audit writer with redaction for every security event; OTPs, links and security alerts queued to the worker, which writes them to `.local/dev-messages.log` until real providers arrive (Phase 7)                                                                                                                                                                                                                          |
| Realtime          | Socket handshake authentication per app namespace, `auth:refresh` on the socket, expiry disconnect, revocation broadcast to every instance (`rt:control`), connect rate limit                                                                                                                                                                                                                                             |
| Web               | `@fos/api-client`: in-memory token store, bearer interceptor, single-flight refresh shared across tabs (`navigator.locks`), one retry on refresh races. `@fos/ui`: accessible form controls. `@fos/auth-web`: provider, route guards and screens (sign-in by code or password, admin second factor, sign-up, phone/email verification, forgot/reset, reactivation, devices and password change), wired into all four apps |
| Shared validation | Auth request schemas live in `@fos/validation` and are used by both the API and the web forms                                                                                                                                                                                                                                                                                                                             |

## Verification notes (Phase 4)

- ✅ 185 tests pass repo-wide: 80 API (incl. 33 auth and 2 realtime integration tests on PostgreSQL + Redis), 5 worker, 11 API client, 12 auth screens, 11 UI, 34 database, 16 shared, 4 validation, 12 app shell. `db:drift` reports no difference.
- ✅ Full-stack Playwright journeys (opt-in, `E2E_FULL_STACK=1`) pass on desktop and mobile Chromium: OTP sign-up for a new number, session restored after reload, sign-out ends the session, wrong code rejected, no serious axe violations on sign-in/sign-up.
- ✅ Manual browser run against the real API and worker: OTP sign-up, password sign-up → phone verification → email link, password sign-in (wrong and right), devices page, sign-out; admin app at phone width shows password-only sign-in with no sign-up. Access token never reaches browser storage; the refresh cookie is not readable from JavaScript.
- ✅ Secrets never logged: a test scans captured logs for passwords, OTPs and tokens.
- ✅ The 100k password list is bundled into the API build (no runtime file), and loads under both `tsx` and the built server.
- Bugs found and fixed during verification: “Send new code” ignored the server's resend cooldown; the primary button colour was 3.55:1 contrast (now ≥ 4.5:1, a Phase 2 design-system bug); reactivation failure returned the wrong error code.
- ⚠️ CI has still not run (nothing pushed), so §22.1c rows are _Implemented_, not _Verified_.
- ⚠️ FR-AUTH-023 (idle/absolute expiry) has no dedicated test yet.

## Phase 3 deliverables

| Area                    | Delivered                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                  | Multi-file Prisma schema (10 domain files): 147 tables, 105 enums, UUIDv7 keys, integer-paise money, PostGIS geography, `ON DELETE RESTRICT` by default                                                                                                   |
| Migrations              | `extensions` · `core_schema` (generated) · `constraints` (partial uniques, CHECKs, GiST/GIN/trigram indexes, ledger balance, append-only, zone overlap, hours limit, search-vector triggers) · `immutability` (configs, offers, webhooks, location trail) |
| Drift control           | `db:drift` proves migrations replay to exactly the schema; database-vs-schema diff is empty                                                                                                                                                               |
| Seed                    | Repeatable pilot-city dataset: 2 zones, 8 fictional restaurants / 10 branches / 41 items, 21 users across all roles, 6 partners, fees/taxes/commission/pay plan, settings, flags, coupons, ledger accounts, permission catalog                            |
| Shared code             | Permission catalog + default role grants (`@fos/shared/permissions`), UUIDv7 generator                                                                                                                                                                    |
| Tests                   | 34 database integration tests on PostGIS (rebuilt from migrations each run); 98 tests repo-wide (unit, component and database)                                                                                                                            |
| CI                      | PostGIS service in the verify job; DB tests and drift check run in CI                                                                                                                                                                                     |
| Local DB without Docker | `infrastructure/scripts/local-postgres.sh` (PostgreSQL 18 + PostGIS on port 5433)                                                                                                                                                                         |
| Docs                    | `docs/database/SCHEMA-NOTES.md` (workflow, every SQL rule → requirement, Prisma error mapping, seed accounts)                                                                                                                                             |

## Verification notes (Phase 3)

- ✅ Built from scratch on PostgreSQL 18.7 + PostGIS 3.7 (project-local instance): all 4 migrations apply; both drift checks report no differences; seed loads in ~250 ms and is repeatable.
- ✅ 34 database tests pass; each asserts the specific constraint/trigger that fires (none can pass vacuously).
- ✅ Spot checks: serviceability query returns only in-zone, in-radius branches; misspelled "biriyani" search finds biryanis.
- ⚠️ CI targets PostGIS 16 (as in Docker Compose); local verification used PostgreSQL 18. CI has not run yet (nothing pushed).
- ⚠️ Docker Compose and the Dockerfiles are still unverified (no Docker on this machine).

## Known discrepancies (SRS vs implementation)

- None open.

Resolved:

- D-10…D-12 resolved 2026-11-20 by owner decision (“Accept all three”, SRS v0.7.0): order numbers `YYMMDD-XXXXXX` (FR-ORDER-001); the outbox relay runs in the worker (ADR-010, SYSTEM-ARCHITECTURE §3); customer cancellation fees are capped at the amount paid excluding tip, so COD orders cancel without a fee (BR-ORDER-011/012).
- D-9 resolved 2026-11-20 by owner decision (“Approve D-9”, SRS v0.6.0): `cart_items.unit_amount_seen` is part of §15.
- Earlier: D-1…D-3 (v0.3.0), D-4…D-6 (v0.4.0), D-7…D-8 (v0.5.0); v0.3.1, v0.4.1 and v0.5.1 were editorial.

Not discrepancies (planned later): reviews (API-REV) and popularity/trending from orders — no roadmap phase names them, proposed for Phase 8; images, avatar and issue-photo uploads, manual-close auto-reopen, restaurant accept/reject/ready endpoints (Phase 8); delivery, tracking (API-TRK), COD collection, tip settlement to partners, partner compensation and T14 at the no-partner deadline (Phase 9); live socket events (Phase 10); support agent tools, refund approvals above limits, invoice content legal review (Phase 11); real SMS/email/push provider adapters (the roadmap lists SMS/email adapters under Phase 7; only the adapter seam and dev sinks exist — needs provider choice and credentials); quiet hours and apology coupons (CORE); dispatch load factor in checkout ETAs (Phase 9); reconciliation reports, refund approvals, promo-credit expiry, settings editing and per-zone payment methods (Phase 11); linked zones, item schedules, data export, OAuth, account recovery and TOTP (CORE).

## Modules

| Module                                                                                                                    | Status                    |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Platform (HTTP, logging, config, health, Redis, socket gateway shell)                                                     | Implemented (Phase 2)     |
| Database schema, migrations, seed for all MVP + CORE domains                                                              | Implemented (Phase 3)     |
| auth, iam, audit, notifications (dev sinks), users (`/me`)                                                                | Implemented (Phase 4)     |
| geo, catalog, customers, discovery, search, config                                                                        | Implemented (Phase 5)     |
| Socket authentication and revocation                                                                                      | Implemented (Phase 4)     |
| pricing, checkout (cart, sessions), offers, ledger (wallet), payments (refunds)                                           | Implemented (Phase 6)     |
| orders (creation, transitions, timers, cancellations, settlement, invoices, issues), support, notifications, outbox relay | Implemented (Phase 7)     |
| Other domain modules (restaurant ops, delivery, dispatch, reviews, admin)                                                 | Designed; not implemented |

## APIs

- Implemented (139 of 494): Phase 6's 105 plus API-CHK-004, API-PAY-005, API-ORD-001…013, API-SUP-001…009, API-NTF-001…010. A development-only `POST /payments/{id}/mock-checkout` stands in for hosted checkout with the mock provider.
- Planned: 355 remaining in `docs/requirements/API-SPECIFICATION.md` (API-TRK-001/002 move to Phase 9 with delivery).

## UI pages

- Implemented: app shells for all four apps (home with platform status, 404, route error); auth screens shared by all four apps: sign-in, sign-up (not admin), verify phone, verify email, forgot/reset password, sign-in and security (devices, change password).
- Planned: customer 21, restaurant 24, delivery 19, admin 31 feature pages.

## Database migrations

| Migration                                   | Purpose                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `20261120000000_extensions`                 | postgis, pg_trgm, unaccent, citext, pgcrypto                               |
| `20261120000100_core_schema`                | All tables, enums, indexes, foreign keys (generated)                       |
| `20261120000200_constraints`                | Partial uniques, CHECKs, ledger/append-only/overlap/hours/search triggers  |
| `20261120000300_immutability`               | Effective-dated configs, dispatch offers, webhook payloads, location trail |
| `20261120000400_payment_attempts_guard`     | Payment attempt facts immutable, status may progress (SRS v0.3.0, D-1)     |
| `20261120151832_auth_enum_values`           | OTP purpose `MFA_LOGIN`, token purpose `REACTIVATE_ACCOUNT` (Phase 4)      |
| `20261120180000_phone_change_revoke_reason` | Session revoke reason `PHONE_CHANGED` (Phase 5, FR-CUST-004)               |
| `20261120190000_cart_item_price_seen`       | `cart_items.unit_amount_seen` for PRICE_CHANGED flags (Phase 6, D-9)       |

## Known bugs

- None known.

## Technical decisions (Phase 7)

- Every status change goes through one transition service; payment, timer, cancellation and (later) restaurant/partner flows call it rather than updating `orders.status`.
- Order reactions to payments run from the outbox relay, not inside the payment code, so a capture is never lost if the order step fails — the event is retried. The cost is up to ~0.5 s before a paid order shows `PLACED`.
- The relay runs in the worker (D-11) and consumers are idempotent by state or by delivery records; the relay can replay events safely.
- Cancellation quote ids are derived from the terms instead of stored; the version in clear lets the API answer 409 (order moved on) vs 422 (only the fee changed).
- A cancellation fee is taken from wallet money first so as much as possible returns to the customer's card or UPI; the fee is capped at what was paid (D-12, approved).
- Settlement uses the order's stored price components plus the quote's funding and tax-collector data, and refuses to post if the split doesn't add up to what the order holds.
- Invoice numbers come from an advisory-locked max + 1, which is gap-free (a sequence is not) — required for tax invoices.
- Invoices are rendered by a small built-in PDF writer (text only, Helvetica) rather than a new dependency; branding can come later.
- Notification sends are keyed by event, recipient and channel, so replays and retries never notify twice; a missing template variable fails the send rather than sending blank text.

## Technical decisions (Phase 6)

- Checkout stops at a priced session; payments are tested against fixture orders. Order creation, and the order transitions that consume `payment.*` outbox events, belong with the order state machine (Phase 7) so that logic exists once.
- Pricing is one pure function (`computeQuote`) fed by a `QuoteBuilder` that gathers configuration; the cart preview, checkout and (in Phase 7) order confirmation all use it, so a preview can never disagree with the charge.
- A coupon's minimum spend is checked inside the engine, after the promotion actually applied, because only the engine knows that amount.
- Ledger balances are stored on each account's normal side so the existing `balance >= 0` wallet checks are correct (sign convention in SCHEMA-NOTES §6b).
- Webhooks are verified over the raw body, stored once and processed by the worker; a sweeper re-processes events if queueing failed, and an hourly poll resolves payments whose webhooks never came.
- A capture with the wrong amount, or for an order that already failed, is recorded (the money did arrive) and refunded automatically; it never advances an order.
- The mock payment provider is refused in production; production requires Razorpay keys, so a missing secret stops boot instead of failing at the first payment.

## Technical decisions (Phase 5)

- Discovery filters and sorts in memory after a PostGIS pre-filter (one zone has tens of branches at pilot scale). Revisit with SQL-side ranking if a zone passes a few hundred branches or NFR-PERF-003 is missed in load tests.
- One branch per brand in listings: open beats closed, then nearest.
- Cursors are base64 JSON of the last sort key plus a fingerprint of the query; reuse with another sort or filter is a VALIDATION_ERROR. They are not signed: a forged but well-formed cursor only skips ahead in the same public list.
- Menus are cached by `menu_version`; availability that changes with time is computed per request, and the ETag is a hash of the final response, so it changes exactly when the content does.
- `GEO_PROVIDER=none` in production rather than refusing to boot: the SRS degraded path (manual pin) keeps ordering possible until a geocoder is chosen (OD-13).
- Weekday convention 0 = Sunday and ratings in hundredths of a star are now documented in SCHEMA-NOTES (the schema left both open).
- A manually closed branch reports no reopening time: FR-REST-014's auto-reopen needs the Phase 8 job, and guessing a time would mislead customers.

## Technical decisions (Phase 4)

- One `authenticate` call per request or socket handshake checks the token, the live session (Redis cache, database fallback) and token/permission versions, so revocation and role changes take effect immediately.
- Refresh cookies are named per app (`fos_rt_<app>`) because cookies are not port-scoped: all four apps on `localhost` would otherwise overwrite each other's sessions.
- A refresh replay inside 10 s is treated as a multi-tab race (`AUTH_REFRESH_RACE`, cookie kept); the client retries once. Outside the window it revokes the whole token family.
- The first OTP sign-in for a new number consumes the code before asking for consent, so the response never reveals whether a number is registered to someone who doesn't hold the phone. The UI then sends a fresh code.
- Rate limits use Redis with an in-memory fallback, so a Redis outage degrades limits per instance instead of failing sign-in (NFR-AVAIL-004).
- The worker refuses to start in production while only dev message sinks exist.

## Technical decisions (Phase 3)

- Multi-file Prisma schema per domain; migrations generated with `--create-only` and reviewed; SQL-only rules documented and tested.
- Spatial/search indexes declared in the schema; partial/expression indexes live only in SQL (Prisma ignores them, so no drift).
- Optional relations use `ON DELETE RESTRICT` (DB-CONV-007) instead of Prisma's `SET NULL` default.
- Append-only tables allow UPDATE only for retention/anonymisation jobs via `SET LOCAL fos.allow_redaction = 'on'`.
- The permission catalog lives in `@fos/shared` so the seed and the Phase 4 IAM module share one source.
- RESTRICT/CHECK/trigger violations surface as `PrismaClientUnknownRequestError`; the API error mapper must handle them (SCHEMA-NOTES §5).

## Machine changes made during Phase 7

- None. The worker smoke boot used health port 4101 and was stopped by its own process id.

## Machine changes made during Phase 6

- None. The smoke boot again used port 4100 (port 4000 belongs to another local project) and was stopped.

## Machine changes made during Phase 5

- None. (Port 4000 was in use by another local project during the smoke test, so the API ran on port 4100 briefly and was stopped; the other process was not touched.)

## Machine changes made during Phase 4

- A project-local Redis (core on 6390, cache on 6391, data in `.local/redis`) started with `infrastructure/scripts/local-redis.sh`, using the Homebrew `redis-server` already installed. The existing Redis on 6379 was not touched. Nothing new was installed.

## Machine changes made during Phase 3 (with owner approval)

- Homebrew: installed `postgis` 3.7 and `postgresql@18` (keg-only, not started as a service, not linked over v17). Dependencies installed included LLVM, GDAL, `python@3.15` (unlinked) and `numpy` (unlinked); `simdjson` and `snappy` were upgraded.
- `fbthrift` was temporarily unlinked for the install and relinked afterwards; `python3` was relinked to 3.14.
- A project-local PostgreSQL 18 instance runs on port 5433 with data in `.local/postgres` (stop with `infrastructure/scripts/local-postgres.sh stop`). The existing PostgreSQL 17 on port 5432 was not touched.

## Blockers

- Legal/tax review items (SRS §20.4) — needed before launch.

## Next steps

1. Owner go-ahead for Phase 8 (restaurant application: onboarding, menu management with `menu_version` bumps, order queue with accept/reject/ready, kitchen display, uploads, reviews).

## TODO

- [x] Decide D-1…D-8
- [x] Phases 4–6
- [x] Decide D-9 (approved 2026-11-20)
- [x] Phase 7
- [x] Decide D-10…D-12 (approved 2026-11-20)
- [ ] Real SMS, email and Web Push providers (worker refuses production without them)
- [ ] Run Docker Compose and the Dockerfiles on a Docker host (or via CI)
- [ ] Push to GitHub so CI runs (moves §22.1a–f rows to _Verified_)
- [ ] Exercise the Razorpay adapter in Razorpay test mode (needs test keys)
- [ ] Dedicated test for idle/absolute session expiry (FR-AUTH-023)
- [ ] Phase 7–8 writers must bump `branches.menu_version` on menu, availability and stock changes (SCHEMA-NOTES §6a)
