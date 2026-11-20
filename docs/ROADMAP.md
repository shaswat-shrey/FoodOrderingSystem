# Development Roadmap, Task Breakdown & Risks

> Phase 1 · v0.4.1 (APPROVED 2026-11-20). Phases follow the master prompt §28. Each phase ends with: code merged, tests green, PROJECT_STATUS.md + Traceability Matrix updated, demo of the phase's acceptance criteria. No phase starts before the previous one's exit criteria are met (except overlapping frontend work noted below).

## 1. Phase roadmap

| Phase | Goal | Key outputs | Exit criteria | Release |
|---|---|---|---|---|
| 1 | Requirements & architecture | SRS, architecture, ADRs, ERD, API inventory, roadmap | **Owner approval** | — |
| 2 | Repository & infrastructure | pnpm/Turborepo monorepo, TS configs, ESLint/Prettier, boundary rules, Docker Compose (Postgres+PostGIS, Redis×2, SeaweedFS (S3), Mailpit), API & worker skeletons (health, config, logger, error handling, envelope), 4 Vite app shells with design-system package, Vitest/Playwright setup, CI pipeline | `docker compose up` brings everything up; CI green; health checks pass | — |
| 3 | Database | Prisma schema for all MVP entities, SQL migrations (PostGIS, partial uniques, checks, triggers, partitions), seed data (pilot city), DB docs | Migrations apply cleanly; constraint tests pass; seed loads | — |
| 4 | Auth & security | Registration/login/OTP, sessions, rotation & reuse detection, logout(-all), email/phone verification, password flows, RBAC + policies, rate limiting, audit log, security headers | AC-AUTH-*, AC-RBAC-001…006 pass | MVP |
| 5 | Core customer backend | Profile, addresses, geo adapters, zones/serviceability, restaurants & branches read, menus, discovery, search, favorites | AC-DISC-*, AC-MENU-004 | MVP |
| 6 | Cart, pricing, checkout | Cart, pricing engine, fees/taxes config, coupons, checkout sessions, payments (Mock + Razorpay), webhooks, wallet & ledger core, idempotency | AC-CART-*, AC-PRICE-*, AC-PAY-001…007 | MVP |
| 7 | Order management | Order creation, state machine, timers & sweeper, cancellations & refunds, history, invoices, notifications core (in-app, email, SMS) | AC-ORDER-*, AC-PAY-008 | MVP |
| 8 | Restaurant application | Onboarding & documents, approval hooks, branch ops, menu management, order queue & KDS, staff, dashboard & basic analytics, settlements view | AC-REST-*, AC-MENU-001…003 | MVP |
| 9 | Delivery application | Partner onboarding, availability, dispatch engine, offers, pickup/drop-off, OTP/photo proof, tracking ingestion, earnings, cash-in-hand | AC-DEL-* | MVP |
| 10 | Real-time | Socket gateway hardening, room auth, outbox relay fan-out, tracking fan-out, revocation propagation | AC-RT-* | MVP |
| 11 | Admin | Admin app: dashboard, approvals, users/restaurants/partners, orders & interventions, dispatch board, payments/refunds/reconciliation, coupons/promotions, zones, configs, support desk, audit, payouts | AC-ADMIN-* | MVP |
| 12 | Frontend integration | Complete customer/restaurant/delivery/admin UIs wired to APIs; loading/error/empty states; session refresh; role navigation; responsive; a11y | AC-E2E-001…003, AC-NFR-002 | MVP |
| 13 | Testing & hardening | Full E2E incl. failure scenarios, load tests, chaos tests, security scans, fixes | AC-E2E-004…009, AC-NFR-001, 003, 004 | MVP |
| 14 | Finalization | README, setup, API docs (generated), DB docs, env docs, deployment guide, demo accounts, known limitations, future roadmap | Docs complete; MVP sign-off | **MVP release** |
| 15+ | CORE release | OAuth, promotions engine, granular staff permissions, stock counts & schedules, combos, incentives, automated payouts, reconciliation UI, complaints/disputes, item reviews, moderation, search suggestions/trending/typo, web push, notification prefs, reports/exports, feature flags UI, surge, admin MFA (TOTP), maker-checker | per CORE ACs | CORE |
| later | ADV / FUT | Batching, ML ETA, chat, masked calling, fraud scoring, per-branch pricing, Hindi, native apps, scheduled/group orders, POS | — | ADV/FUT |

**Parallelization notes:** UI design-system work (packages/ui) can run alongside Phases 3–5. Phase 8/9 frontend screens can start once their APIs' Zod schemas are merged (contract-first). Phases 10 and 12 overlap with 8–11 by design; they are listed separately to make "done" explicit.

## 2. Implementation task breakdown (Phases 2–7 detailed; later phases at epic level)

### Phase 2 — Repository & infrastructure
1. Initialize pnpm workspace, Turborepo, `tsconfig.base.json` (strict), `.editorconfig`, `.nvmrc` (Node 22).
2. `packages/config`: ESLint (typescript-eslint, import, boundaries), Prettier, Tailwind preset, Vite base.
3. Docker Compose: postgis/postgis:16-3.4, redis (core: noeviction+AOF), redis (cache: allkeys-lru), seaweedfs S3 gateway (+ bucket init), mailpit; healthchecks; named volumes.
4. `apps/api`: Express app factory, config (Zod env), pino logger with redaction, requestId middleware, error middleware & envelope, health/readiness, graceful shutdown, Socket.IO bootstrap (no features).
5. `apps/worker`: BullMQ connection, queue registry, graceful shutdown, health endpoint.
6. `packages/db`: Prisma init, migration scripts, client export.
7. Four Vite React apps with router, QueryClient, Zustand, Tailwind, `@fos/ui` placeholder components (Button, Input, Card…), app shells with real 404/error pages.
8. `packages/api-client` (Axios instance + interceptors skeleton), `packages/validation`, `packages/types`, `packages/shared` (money module + tests).
9. Testing infra: Vitest workspace, Testcontainers/CI services, Playwright config, k6 folder.
10. CI: install, lint, typecheck, unit, integration, build, SRS ID check, docker build.
11. README quick start; PROJECT_STATUS.md update.

### Phase 3 — Database
1. Prisma models: identity/IAM, customers/addresses/geo, restaurants/branches/members, menu, cart/checkout/config/coupons, orders, payments/refunds/ledger, partners/deliveries, reviews/notifications/support, platform tables.
2. SQL migrations: extensions; geography columns & GiST indexes; partial unique indexes; check constraints; ledger balance trigger; audit immutability (REVOKE + trigger); zone overlap trigger; partitioning (audit_logs, delivery_locations); generated tsvector columns + GIN/trigram indexes.
3. Repository helpers for spatial queries; DB constraint test suite.
4. Seed: pilot city zone, cuisines, fee/tax/commission/pay configs, roles & permissions catalog, demo users (customer, owner, manager, kitchen, partner, support, admin, super admin), 30 restaurants/45 branches/menus, partners with coordinates, coupons.
5. `docs/database/` schema notes.

### Phase 4 — Authentication & security
1. Password hashing service (Argon2id), breached-password check.
2. OTP service (HMAC store, throttles, dev sink).
3. Session & token services (JWT key ring, refresh rotation, reuse detection, grace window), cookies.
4. Endpoints API-AUTH-001…016, 022, 023; `/me`, `/me/permissions`.
5. IAM: permission catalog, role grants, membership resolution, `authorize()` middleware, policy helpers, permission version.
6. Rate limiting tiers (Redis + memory fallback), lockout policy.
7. Audit module (writer, immutability), security log stream.
8. Helmet/CSP/CORS config; Origin + `X-Client-App` checks.
9. Frontend auth flows in all apps (login, register, OTP, refresh single-flight, route guards).
10. Tests: AC-AUTH-*, AC-RBAC-*.

### Phase 5 — Core customer backend
Geo adapters (mock + interface), zones & serviceability, address CRUD, restaurant/branch read APIs with status computation (hours/holidays/pause), menu read model & caching, discovery queries (PostGIS + filters + sort + cursor), collections, search (FTS + trigram), favorites, profile/preferences.

### Phase 6 — Cart, pricing, checkout, payments
Cart service & validation; pricing engine (pure, table-driven tests); fee/tax/commission config services (effective-dated); coupons (eligibility, reservation with locking); checkout sessions & quote; idempotency middleware; payments module (adapter interface, MockProvider, RazorpayProvider, verify, webhooks raw-body route, event processor, precedence); wallet & ledger core; refund service skeleton.

### Phase 7 — Order management
Order creation transaction; state machine & transition service; outbox relay; timers (JOB-ORD-001…007); cancellations with preview/quote; refunds end-to-end; order history/details/timeline/invoice (PDF); reorder; issue reports → tickets; notifications module (templates, in-app, email, SMS adapters, preferences baseline).

### Phases 8–14 — epics
- **8:** onboarding wizard & documents · admin approval hooks · branch ops (hours/holidays/pause) · menu management UI & APIs · order queue + sound + KDS · staff invitations & scopes · dashboard metrics · settlements view.
- **9:** partner onboarding & docs · availability & eligibility · Redis geo state · dispatch engine (rounds, offers, timeouts, escalation, manual) · stage APIs & geofences · OTP/photo/COD completion · earnings computation · cash-in-hand · partner PWA screens.
- **10:** gateway auth & namespaces · room policies · revocation control channel · per-audience serializers · tracking fan-out & throttling · reconnect resync on clients.
- **11:** admin app modules per FR-ADMIN list, dispatch board, reconciliation & payouts, audit search.
- **12:** finish all UI pages (SRS §17.1), responsive & a11y passes.
- **13:** E2E failure scenarios, k6, chaos, ZAP, fixes.
- **14:** docs, demo accounts, deployment guide.

## 3. Major technical risks & mitigations

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-01 | Scope size: full Swiggy-class platform is very large for a small team | High | High | Strict MVP/CORE staging (SRS §24); phase exit criteria; contract-first APIs; avoid gold-plating; owner reviews per phase |
| R-02 | Payment correctness (duplicate/late/out-of-order events, refunds) | Medium | Critical | Order-before-payment design, idempotency layers, precedence rules, ledger invariants, MockProvider chaos scenarios, daily reconciliation |
| R-03 | Double assignment / race conditions in orders & dispatch | Medium | High | Row locks + version checks + partial unique indexes; concurrency integration tests (AC-ORDER-004, AC-DEL-003) |
| R-04 | PostGIS + Prisma friction (unsupported types, migrations) | High | Medium | Repository pattern with raw SQL, migration SQL reviewed, dedicated tests; documented in ADR-005 |
| R-05 | PWA background GPS limits on partner phones (location gaps when app backgrounded/screen off) | High | High | Wake Lock, foreground guidance, stale detection & ops alerts, heartbeat-based eligibility; Capacitor wrapper as upgrade path (ADR-014) |
| R-06 | Real-time scale & fan-out (location updates) | Medium | Medium | Redis-only hot path, throttled fan-out, sampled persistence, load tests (NFR-PERF-013), separate socket instances if needed |
| R-07 | Redis as a single point of failure (queues, locks, sessions cache, geo) | Medium | High | Managed HA Redis, split cache vs core, DB fallbacks (NFR-AVAIL-004), sweeper rebuilds timers |
| R-08 | Regulatory/tax uncertainty (GST §9(5), TCS/TDS, DPDP, PPI wallet) | High | High | Configurable tax engine, effective-dated configs, legal review items (§20.4) before launch; no compliance claims |
| R-09 | Third-party dependency costs/limits (maps, SMS) | Medium | Medium | Adapters with mocks, caching, rate limits, provider choice deferred (OD-13), SMS used only for critical events |
| R-10 | Refresh-token rotation edge cases (multi-tab races, Safari ITP, cookie domains) | Medium | Medium | Grace window, single-flight refresh with cross-tab lock, same-site deployment design, E2E across browsers |
| R-11 | Outbox relay lag/leader failure delaying events | Low | Medium | Leader election with TTL, LISTEN/NOTIFY wakeups, stale-event alert, multiple candidate relays |
| R-12 | Data privacy incidents (PII leaks via logs/APIs) | Medium | High | Explicit DTO allowlists, log redaction tests, PII masking, role projections, security reviews |
| R-13 | ETA inaccuracy hurting trust | High | Medium | Ranges not points, conservative buffers, metrics to tune, routing provider in production |
| R-14 | Restaurant adoption of digital order handling (missed orders) | Medium | High | Loud alerts, SMS reminders, auto-pause, polling fallback, simple tablet UI |
| R-15 | Test suite slowness with Postgres/Redis containers | Medium | Low | Parallel test DBs/schemas, transactional tests, Turborepo caching, nightly full E2E |
| R-16 | Fraud (COD refusals, coupon abuse, GPS spoofing, refund abuse) | Medium | Medium | COD blocks, coupon per-user limits & device heuristics (CORE), spoofing flags, refund auto-approval limits |
