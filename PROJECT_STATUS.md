# Project Status

_Last updated: 2026-11-21_

## Summary

| Item              | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current phase     | **Phase 13 — Testing & hardening: in progress**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Next phase        | Phase 14 — Finalization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SRS version       | FOS-SRS-001 v0.11.0 (APPROVED 2026-11-21; v0.9.0 adds D-16, D-17; v0.10.0 adds D-18, D-19; v0.10.1 editorial; v0.11.0 adds D-20)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Business features | Accounts and sign-in (all apps); customer backend for locations, addresses, restaurants, menus, discovery, search, favourites, cart, coupons, checkout, wallet, payments, orders, cancellations, refunds, invoices, support and notifications; restaurant onboarding, profile, outlet operations, menu management, order queue, kitchen display, staff and dashboard (API and restaurant web app); delivery partner onboarding, availability, dispatch, trip stages with geofences and proof, COD, earnings, cash, payouts view and bank changes (API and delivery web app); customer tracking; reviews and ratings |

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
| 8 Restaurant application      | ✅ Complete 2026-11-21 (D-13…D-15 approved)               |
| 9 Delivery application        | ✅ Complete 2026-11-21 (D-16, D-17 decided)               |
| 10 Real-time                  | ✅ Complete 2026-11-21 (D-18, D-19 decided)               |
| 11 Admin                      | ✅ Complete 2026-11-21                                    |
| 12 Frontend integration       | ✅ Complete 2026-11-21 (D-20 decided)                     |
| 13 Testing & hardening        | Not started                                               |
| 14 Finalization               | Not started                                               |

## Phase 12 deliverables

| App        | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer   | Location (saved, current, area search or coordinates), discovery with filters and sort, search, restaurant menu with customisation, cart with coupons and price-change flags, checkout (address, tip, contactless, COD/online/wallet), dev payment step, live order tracking with cancellation; orders history, invoice, reorder, issue reports, ratings and reviews, addresses, profile and food preferences, wallet, favourites, notifications inbox with a live badge, help tickets |
| Restaurant | Full dish editor (fields, photos, variants with one default, option groups per dish/variant, If-Match conflicts), option group management, category management, holidays and delivery settings, order details with live partner status and pickup-code handover, analytics charts, reviews with responses and reports, payouts (new API-RFIN-006), profile and change requests with re-authentication                                                                                  |
| Delivery   | Live notices for expired/withdrawn offers, revoked assignments and cancelled orders; profile with emergency contact, preferred zone and vehicles                                                                                                                                                                                                                                                                                                                                       |

## Verification notes (Phase 12)

- ✅ 599 tests pass repo-wide (API 441, customer 25, restaurant 13, delivery 8, admin 9, plus packages); all four apps build.
- ✅ Browser check of the customer app against the real API (customer app on port 5183 because 5173 belongs to another project; the API's customer origin pointed at it for the check): location, discovery with live restaurants and the restaurant page with menu, offers and FSSAI number worked; closed restaurants showed a raw status code, now shown in plain words.
- Bugs found and fixed: closed-restaurant status codes shown to customers; the restaurant order details never returned the assigned partner (Phase 9 placeholder); the discovery rating filter was sent as a number.
- ⚠️ Not yet exercised end to end in a browser: placing and paying an order and the restaurant/partner screens of this phase (the seeded restaurants were closed at the time of checking; covered by UI tests). Phase 13 adds end-to-end runs.

## Phase 11 deliverables

The admin API (built in three batches) and the admin console. Every admin mutation is audited; ★ actions require a reason and are recorded as high-sensitivity; maker-checker is CORE.

| Area                      | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts                  | Users (masked search, PII reveal, suspend with session revocation, sign-out everywhere, wallet adjustments, COD block, sessions); restaurant applications (review, approve, reject, request changes, signed document links), restaurants and branches (edit, suspend, approve, commission override, COD), change requests applied with encryption; partner applications and vehicles, partner management (suspend, force offline, cash deposits, earning adjustments, location trail)                                                                                                              |
| Operations                | Dashboard (today in IST), ops alerts; order search and 360 view, cancel with fault, mark delivered/failed with settlement, extend acceptance, audit trail; dispatch board with ranked candidates, manual assignment that the partner must acknowledge within 60 s, reassign, redispatch, deadline extension; payments with provider sync and webhook log; refunds with a per-order support limit and approval; payout batches for partners and restaurants (create for a week, approve by another admin, CSV export, mark paid with UTR through a payout clearing account, failed lines roll over) |
| Configuration and support | Coupons validated with the checkout's rules; zones with polygon validation, suspension and surge; settings with history; append-only fee schedules, tax rules, commission and partner pay plans; support desk with queues, replies, internal notes, assignment and escalation; review moderation; cuisines; staff roles with last-super-admin and self-change guards; audit search; failed jobs with retry                                                                                                                                                                                         |
| Admin console             | Sidebar filtered by the admin's permissions; dashboard with live ops feed; approvals, users, restaurants, partners, orders, dispatch, finance and payouts, coupons, zones, settings, pricing, support desk, moderation, roles, audit and jobs screens; one reason dialog for every ★ action                                                                                                                                                                                                                                                                                                        |

## Verification notes (Phase 11)

- ✅ 565 tests pass repo-wide (API 439, admin app 9): 34 new admin integration tests across accounts, operations and configuration, plus 9 console tests.
- ✅ Browser check against the real API (port 4100, dev database, worker running): the seeded admin signed in with the emailed second factor; the dashboard showed live tiles with the socket connected; users (masked), settings and zones pages showed real data; no server errors.
- Bugs found and fixed: the partner payout estimate read the payable balance with the wrong sign (Phase 9); restaurant rating recomputes failed a database check written for the wrong scale (migration `20261121150000_rating_scale`); a menu test depended on no reviews existing.
- ⚠️ Not built (CORE or later): maker-checker, reconciliation, promotions/banners/FAQs/legal/templates/broadcasts content screens, custom roles, ops map, incentives, feature flags.

## Phase 10 deliverables

| Area               | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway            | Resource subscriptions decided by a server-side room policy (customer orders, branch order queue and kitchen, assigned delivery, ops and zone rooms, admin order view), identical FORBIDDEN for missing and foreign resources, probing disconnects, ≤ 5 sockets per session, per-socket limits, Zod-validated client events, room changes pushed on assignment and release                                                                                                                                    |
| Delivery of events | The worker's outbox consumers publish per-audience projections on Redis (`rt:events`); every API instance emits to its own sockets, so pushes always follow commits and work across instances                                                                                                                                                                                                                                                                                                                 |
| Projections        | Customer (order created, status, cancelled, ETA, payments, refunds, partner assigned/unassigned, delivery stages, tracking, notifications), restaurant (new order in priced and kitchen views, updates, cancellations, reminders, partner assigned/arrived, picked up, branch status), partner (offer created/expired/withdrawn, assignment confirmed/revoked, order ready/cancelled/prep delayed, status, earnings), admin (order activity, approvals, support tickets, stale partners, restaurant activity) |
| Tracking           | Partner location over the socket (REST batches as fallback) feeds a 3 s-throttled fan-out to the order room, ETA recomputed at most every minute and pushed when it moves by ≥ 2 min, "location updating" after 60 s and an ops alert after 5 min                                                                                                                                                                                                                                                             |
| Clients            | Shared socket client following the session (token refresh, sign-out), backoff with jitter, re-subscription and refetch after reconnect, duplicate and stale-version filtering, React hooks; the restaurant queue and kitchen and the partner app refresh from pushes and poll only as a fallback (15 s while disconnected)                                                                                                                                                                                    |

## Verification notes (Phase 10)

- ✅ 525 tests pass repo-wide (API 405). New in Phase 10: 5 gateway tests (rooms, pushed delivery, room control, partner client events, validation), 4 realtime integration tests (room policy against the database, order projections, a live delivery with throttled tracking and stale detection, offer expiry) and 2 socket client tests.
- ✅ Live check against the real API and Redis (port 4100, worker running): a bad token was refused, a partner's subscription to someone else's delivery was refused, and an event published on `rt:events` reached the partner's socket through its automatic room; no server errors.
- ⚠️ Gateway metrics and latency measurement (FR-RT-027/028) come with the Phase 13 load work; the ops feed is not yet batched per second.

## Phase 9 deliverables

API plus the delivery partner web app. Live socket pushes (offers, location fan-out, tracking events) are Phase 10; until then the apps poll.

| Area               | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partner onboarding | Application with details, PAN (encrypted, masked), Aadhaar last 4 only, emergency contact, vehicle, bank (encrypted), documents (motorized vehicles need DL, RC, insurance; licence expiry checked), age ≥ 18, checklist, submit, review decisions granting the partner role; profile and vehicle changes after approval; guidelines acknowledgement; zone list for applicants                                                                                                                                                                                                      |
| Availability       | Online/offline with a fresh, accurate location fix and blockers (documents, vehicle, guidelines, cash cap), deferred offline during a trip, 15/30-minute breaks, location batches with spoofing checks (stored trail sampled), auto-offline after inactivity, outside zone or missed offers, today's dashboard                                                                                                                                                                                                                                                                      |
| Dispatch           | Sequential single offers ranked by pickup ETA, ready alignment, idle time, acceptance, rating and load; 30 s offers, rounds at 3/5/8 km, bicycle limits, COD cash cap, exclusions; escalation with ops alert and 60 s retries; no-partner deadline cancels as a platform fault with a full refund; exactly-once acceptance (Redis lock + row locks); timeouts, rejections and withdrawals; self-healing sweeps                                                                                                                                                                      |
| Trip stages        | Arrived at restaurant and at customer with geofences (outside → explicit confirm, flagged), pickup only when ready (or the restaurant's handover with the partner's pickup code, straight from preparing), ETA set at pickup, OTP proof (5 tries then lock + ops alert) or photo proof for contactless prepaid orders, COD collection into cash in hand, settlement, partner earnings and the tip, customer-unreachable flow, unassign before pickup with re-dispatch, silent-partner alert at 3 min and release at 5 min, compensation when an order is cancelled after acceptance |
| Earnings           | Day/week/month summary with breakdown and daily totals (IST, Monday–Sunday weeks), statement with tips shown apart, per-delivery breakdown, cash in hand against the cap, next payout estimate (earnings − cash, minimum ₹100, on hold during a bank change) and payout history, 30-day acceptance/completion/on-time rates, aggregate ratings, masked bank details and bank change after re-authentication                                                                                                                                                                         |
| Tracking           | Customer snapshot (status, ETA, restaurant and drop points, partner first name, vehicle and rating, live location with age and a stale flag, delivery code) and a rate-limited location poll; the partner's location is shared only from assignment until delivery, with a database fallback when Redis has no fix                                                                                                                                                                                                                                                                  |
| Reviews            | Restaurant and partner ratings after delivery within 7 days, one per target, tags, up to 3 photos, text cleaned (phone numbers, e-mails, profanity), edit within 48 h, delete any time, my reviews; restaurant team reads reviews by outlet with filters, posts one response (editable 24 h) and reports; three independent reports hide a review; branch, restaurant and partner averages recomputed from the outbox                                                                                                                                                               |
| Delivery web app   | Application form with uploads and checklist; shift screen with online/offline, breaks, blockers, guidelines, offer card with server-clock countdown, location reporting while online; trip screen per stage with pickup code, navigation links, geofence confirmation, OTP or photo proof and cash confirmation, give-back flow; earnings, trips and bank screens                                                                                                                                                                                                                   |

## Verification notes (Phase 9)

- ✅ 516 tests pass repo-wide; the API's 398 include 36 new Phase 9 integration and unit tests (onboarding, availability, dispatch, the full trip with COD/OTP/tip/handover/unassign/heartbeat/compensation, earnings, tracking, reviews, pay rules, ranking, earnings periods, moderation); the delivery app has 6 UI tests; a new test keeps every error code's default message present.
- ✅ Browser check against the real API (port 4100, dev database, worker running): the seeded partner signed in by OTP, went online with a location fix, went offline, and the earnings page showed live data; the API logged no errors. A full trip in the browser was not possible because the seeded restaurants were closed at that hour (01:30 IST); the trip is covered end to end by the API integration tests and the app's UI tests.
- Bugs found and fixed while building: error messages added since Phase 8 were silently missing from the default-message map; partner rating averages were read on the wrong scale (fixed to hundredths of a star, as SCHEMA-NOTES says); the partner ratings page first listed per-review ratings, against BR-REVIEW-006; test isolation between dispatch, availability and delivery files.
- ⚠️ No socket pushes yet (Phase 10): offers, trip screens and tracking poll; the route polyline is empty until a routing provider exists.
- ⚠️ Payout batches are created in Phase 11, so payout history is empty for now; the estimate is live.
- ⚠️ CI still hasn't run (nothing pushed), so Phase 9 traceability rows are _Implemented_, not _Verified_.

## Phase 8 deliverables

API plus the first real restaurant web screens (the remaining restaurant pages and polish are Phase 12). Handover to a delivery partner (API-RORD-009) needs the delivery module and moves to Phase 9.

| Area               | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uploads            | `POST /files` (multipart) with purpose rules (BR-FILE-001), type from magic bytes, SVG refused, EXIF/GPS stripped by re-encoding, WebP thumb/card/hero for public images (originals private), 5-minute signed links for private files (audited), delete of unattached uploads, hourly orphan cleanup; local storage driver for development, S3-compatible for production                                                                                         |
| Onboarding         | Application as the restaurant row in an onboarding state: business details (PAN/GSTIN/IFSC/FSSAI validated, GSTIN check digit), first outlet with zone from the pin and radius cap, weekly hours, bank account, documents, logo; completeness checklist; submit with no-GST declaration; duplicate FSSAI/GSTIN flagged; review decisions (changes requested, rejection with 30-day wait, approval activating restaurant, outlet, documents, bank and owner role) |
| Security           | PAN, bank numbers and change-request payloads encrypted with rotatable AES-256-GCM field keys; IAM grants nothing for unapproved restaurants; merchant guard (404 to non-members, 403 without the permission); permission changes invalidate cached sessions immediately                                                                                                                                                                                         |
| Profile & outlets  | Profile with masked PAN/bank, editable non-legal fields, logo and cover; legal/tax/bank change requests (owner, re-auth); outlet settings within zone, platform and packaging caps; hours, holidays, prep time and rush; effective status with a reason; go online (go-live checklist), offline for today (auto-reopens next day), pause 15–60 min or up to 4 h (auto-resume)                                                                                    |
| Menu               | Management menu, categories (reorder, delete with a target), dishes (offer price, tags, allergens, ingredients, flags, If-Match versions, ≤ 5 photos), variants with one default, reusable option groups with min/max rules attachable per variant, dietary consistency, per-outlet availability until a time or end of day; every change bumps `menu_version`                                                                                                   |
| Orders             | Queue tabs with counts and today's history, restaurant view without customer contact details, accept with prep time (one of two concurrent accepts wins), reject with reason (named items can be switched off), preparing, ready (one action from accepted), one prep extension, owner/manager cancel; kitchen display tickets without prices; delay timers armed                                                                                                |
| Staff              | Invitations by phone/email with role and outlet scope (7-day token by SMS/email), public preview, accept only by the invitee; role, scope, suspend and remove with immediate effect; managers only manage roles below their own                                                                                                                                                                                                                                  |
| Analytics          | Today dashboard (orders by state, food value, settled net payable, AOV, acceptance and prep times, rating) and sales, top dishes, categories, operations metrics from real orders                                                                                                                                                                                                                                                                                |
| Restaurant web app | Workspace with restaurant/outlet switcher and permission-aware navigation; application form with uploads; order queue with repeating alert; kitchen display with offline banner; menu with stock toggles and quick dish creation; outlet status, pause, rush and hours; team; dashboard; invitation acceptance                                                                                                                                                   |

## Verification notes (Phase 8)

- ✅ 476 tests pass repo-wide; the API's 362 include 29 new Phase 8 integration and unit tests (uploads, onboarding, branch operations, menu, restaurant orders, staff and analytics, field encryption, hours, Indian identifiers); the restaurant app has 5 UI tests.
- ✅ Browser check against the real API (port 4100, dev database, worker running): the seeded owner signed in by OTP, landed on the order queue, and the Outlet, Menu and Dashboard pages showed live data; marking a dish out of stock and back worked end to end; the API logged no errors.
- Bugs found and fixed while building: the upload route had to sit before the JSON-only guard; local media had to sit outside the `X-Client-App` requirement and needs `Cross-Origin-Resource-Policy: cross-origin` for the apps to show images; IAM treated draft applications as live memberships; permission changes did not reach cached sessions; a signature-tamper test failed 1 in 16 runs.
- ⚠️ Local storage driver only (no Docker for SeaweedFS here); the S3 driver is untested against a live endpoint.
- ⚠️ Invitations and notifications still go to development message sinks.
- ⚠️ CI still hasn't run (nothing pushed), so §22.1a–g rows are _Implemented_, not _Verified_.

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

- D-20 resolved 2026-11-21 under the owner's standing instruction (SRS v0.11.0): restaurant owners get payout history with the settlement breakdown (API-RFIN-006); settlement statements stay planned.
- D-18 and D-19 resolved 2026-11-21 under the owner's standing instruction (SRS v0.10.0): partner liveness comes from location fixes only (FR-RT-021); clients drop events with a lower aggregate version, equal versions allowed (§13.1).
- D-16 and D-17 resolved 2026-11-21 under the owner's standing instruction to proceed without further approvals (SRS v0.9.0): `GET /partner/zones` is API-DP-022; partners see written rating comments only once they have ≥ 5 ratings (BR-REVIEW-006).
- D-13…D-15 resolved 2026-11-21 by owner decision (“Accept all three”, SRS v0.8.0): image derivatives made during upload (FR-FILE-003); owner membership created with the application, effective on approval (FR-REST-001); analytics computed from orders, hourly roll-up optional (FR-RANL-002). While applying D-13 the original of a public image was found to be publicly served, against FR-FILE-003; originals now stay in the private bucket (owner via signed link) and only WebP sizes are public.
- D-10…D-12 resolved 2026-11-20 by owner decision (“Accept all three”, SRS v0.7.0): order numbers `YYMMDD-XXXXXX` (FR-ORDER-001); the outbox relay runs in the worker (ADR-010, SYSTEM-ARCHITECTURE §3); customer cancellation fees are capped at the amount paid excluding tip, so COD orders cancel without a fee (BR-ORDER-011/012).
- D-9 resolved 2026-11-20 by owner decision (“Approve D-9”, SRS v0.6.0): `cart_items.unit_amount_seen` is part of §15.
- Earlier: D-1…D-3 (v0.3.0), D-4…D-6 (v0.4.0), D-7…D-8 (v0.5.0); v0.3.1, v0.4.1 and v0.5.1 were editorial.

Not discrepancies (planned later): item thumbs (FR-REV-003, CORE), review prompt 30 min after delivery (FR-REV-007, CORE), SOS (API-DP-021, CORE), manual assignment and its acknowledgement (API-DPDEL-012, Phase 11), incentives (API-EARN-004, CORE), payout batches, cash deposits and earning adjustments (Phase 11), socket offers/tracking/ETA pushes (Phase 10), route polylines (needs a routing provider), popularity/trending; new branches (API-MER-015), KDS device pairing, activity log, ownership transfer, stock counts, schedules, combos, bulk edits (CORE); admin review console for applications and change requests (Phase 11); avatar upload (Phase 12); live socket events (Phase 10); support agent tools, refund approvals above limits, invoice content legal review (Phase 11); real SMS/email/push provider adapters (the roadmap lists SMS/email adapters under Phase 7; only the adapter seam and dev sinks exist — needs provider choice and credentials); quiet hours and apology coupons (CORE); dispatch load factor in checkout ETAs (Phase 9); reconciliation reports, refund approvals, promo-credit expiry, settings editing and per-zone payment methods (Phase 11); linked zones, item schedules, data export, OAuth, account recovery and TOTP (CORE).

## Modules

| Module                                                                                                                    | Status                 |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Platform (HTTP, logging, config, health, Redis, socket gateway shell)                                                     | Implemented (Phase 2)  |
| Database schema, migrations, seed for all MVP + CORE domains                                                              | Implemented (Phase 3)  |
| auth, iam, audit, notifications (dev sinks), users (`/me`)                                                                | Implemented (Phase 4)  |
| geo, catalog, customers, discovery, search, config                                                                        | Implemented (Phase 5)  |
| Socket authentication and revocation                                                                                      | Implemented (Phase 4)  |
| pricing, checkout (cart, sessions), offers, ledger (wallet), payments (refunds)                                           | Implemented (Phase 6)  |
| orders (creation, transitions, timers, cancellations, settlement, invoices, issues), support, notifications, outbox relay | Implemented (Phase 7)  |
| files, merchant (onboarding, profile, outlets, menu, staff, analytics), restaurant order handling                         | Implemented (Phase 8)  |
| partners (onboarding, availability, presence, earnings, finance), dispatch (offers, stages, tracking), reviews            | Implemented (Phase 9)  |
| realtime (room policy, projections, live tracking), socket gateway rooms and client events                                | Implemented (Phase 10) |
| admin (accounts, operations, configuration, support desk, governance)                                                     | Implemented (Phase 11) |

## APIs

- Implemented (273 of 495 before Phase 11; Phase 11 adds about 120 admin endpoints): Phase 8's 218 plus API-DP-001…020, API-DPDEL-001…011 and 013, API-RORD-009, API-EARN-001…003 and 005…012, API-TRK-001/002, API-REV-001…005, API-RREV-001…004 (Phase 9). Extra: `GET /partner/zones` (API-DP-022). Phase 8 added: Phase 7's 139 plus API-FILE-001…003, API-MER-001…014 and 016…027, API-RMENU-001…026, API-RORD-001…008 and 010…012, API-RSTAFF-001…008, API-RANL-001…004 and 007. Extra: `GET /merchant/cuisines` (cuisine picker) and `GET /merchant/branches/{id}/go-live` (checklist). A development-only `POST /payments/{id}/mock-checkout` stands in for hosted checkout.
- Planned: 222 remaining in `docs/requirements/API-SPECIFICATION.md`.

## UI pages

- Implemented: all four apps — customer (ordering journey and account area), restaurant (Phases 8 and 12), delivery (Phases 9, 10, 12) and admin (Phase 11).
- Planned: customer 21, restaurant 16, delivery 13, admin 31 feature pages (map pin picker, full dish editor with variants/options, holidays UI, analytics charts and settlements come in Phase 12).

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

## Technical decisions (Phase 11)

- The admin backend was built in three batches by delegated agents with one shared guard file (`admin.http.ts`), so every admin route has the same app check, rate limit, permission check and reason/audit handling.
- Admin actions reuse the domain services (order transitions, cancellation, dispatch, refunds, onboarding decisions, ledger) instead of writing rows directly, so the same rules, events and pushes apply whether a customer, restaurant, partner or admin acts.
- Payouts move money out through a `PAYOUT_CLEARING` ledger account until bank reconciliation exists; a partner line nets their cash in hand off the payable in the same posting.
- Pricing tables stay append-only: admins create future-dated versions; nothing is edited in place.
- Refunds come from the order's liability while it is unsettled and from the cost bearer afterwards, so goodwill refunds never push a liability negative.

## Technical decisions (Phase 10)

- Pushes travel on a Redis channel that every API instance listens to and emits locally, instead of a Socket.IO emitter package: one fewer dependency, and the worker (where the outbox relay runs) never needs a socket server.
- Projections are built per audience in one place from outbox events, reusing the outbox event id as the push id so a retried relay batch is de-duplicated by clients.
- Changes that don't go through the outbox (offer expiry and withdrawal, auto-offline, in-app notifications, location) push through small hooks after the change is committed.
- Socket event handlers are registered before the async room setup, so a client's first `subscribe` right after connecting is never lost.
- Clients keep polling as a fallback and slow it down while connected, so a dead socket degrades to Phase 9 behaviour rather than to stale screens.

## Technical decisions (Phase 9)

- Live partner state (presence, zone GEO set, offer slots) lives in Redis; the database keeps a copy of the last location at most once a minute, which tracking and admin fall back to.
- Dispatch is single-flight per delivery (Redis lock) and acceptance is exactly-once through row locks plus the one-active-delivery index; the Redis locks only reduce contention.
- Delivery transitions go through one table-driven helper that stamps times, writes history and an outbox event, so every stage is audited the same way.
- The delivery OTP is checked in its own transaction before completion, so failed attempts are counted even though completion rolls back.
- Partner pay, tips and compensation are ledger postings (platform delivery cost → partner payable; tip from the order's liability), so a delivered order still settles to zero and payouts can be computed from balances.
- Earnings periods use IST calendar days and Monday–Sunday weeks; performance rates are computed from the source rows over 30 days rather than from cached counters.
- Rating averages are recomputed from the outbox (`review.changed`, JOB-REV-001) rather than in the request, so a burst of reviews costs one recompute each and the request stays fast.
- Restaurant teams see a reviewer's first name only; partners never see per-review ratings (D-17).
- The partner app polls (offer 5 s, availability 15 s, trip 15 s) and sends location batches every 5 s on a trip and 30 s otherwise, until sockets arrive in Phase 10.

## Technical decisions (Phase 8)

- An application is the restaurant row itself in an onboarding state, not a separate table: approval flips states instead of copying data, and every later screen already reads the real restaurant.
- Owner membership exists from the start but IAM only counts approved, active restaurants (D-14). One access rule covers drafts and live restaurants.
- Field encryption uses AES-256-GCM with a one-byte key id, so keys rotate without re-encrypting at once; development derives a key from the HMAC secret, production must configure keys.
- Restaurant-scoped checks return 404 to non-members and 403 to members without the permission, so ids of other restaurants' orders and outlets are never confirmed.
- Images are re-encoded (not metadata-stripped in place) — the only reliable way to drop every EXIF/XMP block — and WebP derivatives are made at upload (D-13).
- The upload and local-media routes sit outside the JSON API chain (multipart bodies; `<img>` requests carry no app header).
- "Offline for today" is recorded as a CLOSED event with an `until`; a sweep reopens at the next day's first slot (configurable), and pause expiry writes a RESUMED event so the log stays complete.
- Restaurant rejection reuses the cancellation path (full refund, coupon and stock back) with the order ending REJECTED, so refunds behave identically.
- Analytics query live orders (D-15); the dashboard's net payable comes from settlement ledger entries, so it shows only money actually settled.
- The restaurant app polls (orders 8 s, kitchen 5 s) until the realtime gateway (Phase 10); the new-order sound needs one click per session because browsers block autoplay.

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

## Machine changes made during Phase 12

- `.claude/launch.json` (git-ignored) gained `api-4100-c5183` and `customer-web-5183` for the customer check (5173 is another project's dev server and was left running). The API, worker and customer app were stopped afterwards.

## Machine changes made during Phase 11

- Migrations `20261121090000_admin_forced_offline`, `20261121120000_admin_operations` and `20261121150000_rating_scale` applied to the dev database (5433).
- For the browser check the seeded dev admin (admin@example.com) got a generated password through the app's own reset flow; the value is only in the session scratchpad. `.claude/launch.json` (git-ignored) gained `admin-web-4100`. The API, worker and admin app were stopped afterwards.

## Machine changes made during Phase 10

- `socket.io-client` added to `@fos/api-client` (already in the lockfile through the API). The API (4100) and worker were started for the live check and stopped; one OTP sign-in for the seeded partner +919000000402. A temporary check script was run from `apps/api` and deleted.

## Machine changes made during Phase 9

- No new packages. `.claude/launch.json` (git-ignored) gained a `delivery-web` entry; the API (port 4100), worker and delivery app were started for the browser check and stopped afterwards. Port 4000 was not touched.
- Dev database: the seeded partner +919000000401 went online and offline (online session rows), one OTP sign-in each for that partner, the seeded customer and the seeded manager, plus one saved address and one cart item for the seeded customer (checkout stopped because the restaurant was closed); no orders were created.

## Machine changes made during Phase 8

- npm packages added to `@fos/api`: `sharp` (prebuilt binary; its install script was not run and isn't needed), `busboy`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, and `@types/busboy` (dev).
- `.claude/launch.json` (git-ignored) gained `api-4100` and `restaurant-web` entries for the browser check; the API, worker and restaurant app were started for it and stopped afterwards. Port 4000 (another project) was not touched.
- Local uploads during the check would go to `.local/storage` (git-ignored); none were made.

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

1. Phase 13 (testing and hardening) — in progress; then Phase 14 (finalization).
2. (Earlier plan) Phase 10 (real-time: socket rooms for orders, branches and deliveries; offer push; location fan-out with throttling; ETA updates; stale-location alerts).

## TODO

- [x] Decide D-1…D-8
- [x] Phases 4–6
- [x] Decide D-9 (approved 2026-11-20)
- [x] Phase 7
- [x] Decide D-10…D-12 (approved 2026-11-20)
- [x] Phase 8
- [x] Decide D-13…D-15 (approved 2026-11-21)
- [x] Phase 9
- [x] Decide D-16, D-17 (standing instruction, 2026-11-21)
- [ ] Walk a full trip in the browser during restaurant hours
- [x] Phase 10
- [x] Phase 11
- [x] Phase 12
- [ ] Exercise the S3 storage driver against SeaweedFS or a real bucket
- [ ] Real SMS, email and Web Push providers (worker refuses production without them)
- [ ] Run Docker Compose and the Dockerfiles on a Docker host (or via CI)
- [ ] Push to GitHub so CI runs (moves §22.1a–g rows to _Verified_)
- [ ] Exercise the Razorpay adapter in Razorpay test mode (needs test keys)
- [ ] Dedicated test for idle/absolute session expiry (FR-AUTH-023)
- [x] Phase 7–8 writers bump `branches.menu_version` on menu, availability, status and stock changes (SCHEMA-NOTES §6a)
