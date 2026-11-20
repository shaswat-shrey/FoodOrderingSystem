# Testing Strategy

> Phase 1 · v0.6.0 (APPROVED 2026-11-20). Requirements traceability: SRS §22–23.

## 1. Test pyramid & tools

| Level | Scope | Tools | Runs |
|---|---|---|---|
| Static | Types, lint, dependency boundaries, SRS ID checker, OpenAPI drift | tsc, ESLint, dependency-cruiser, `docs/tools/requirements-index.mjs --check` | Every PR |
| Unit | Pure domain logic: pricing, state machines, dispatch ranking, policies, money, validators, serializers | Vitest, fast-check (property tests) | Every PR |
| Integration (API) | HTTP endpoints against real Postgres+PostGIS and Redis; repositories; jobs with fake clock; webhooks with MockProvider; sockets with socket.io-client | Vitest + Supertest + Testcontainers (or CI service containers), BullMQ in-process | Every PR |
| Contract | Generated OpenAPI vs Zod; api-client types compile against spec | zod-to-openapi, tsc | Every PR |
| Component (frontend) | UI components & feature components with MSW-mocked API | Vitest + Testing Library + axe | Every PR |
| End-to-end | Real stack in Docker Compose; four apps in multiple browser contexts (customer, restaurant, partner, admin simultaneously) | Playwright | PR (smoke) + nightly (full) |
| Performance | Discovery, menu, checkout, order placement, socket fan-out, location ingestion | k6 (+ xk6-websockets) | Nightly/pre-release on staging |
| Security | Authorization matrix, auth attack tests (reuse, brute force), ZAP baseline, dependency audit | Vitest, OWASP ZAP, npm audit/OSV | PR + weekly |
| Resilience | Redis down, DB failover, provider timeouts, worker crash mid-job | Toxiproxy + scripted chaos in integration env | Weekly / pre-release |
| Accessibility | axe-core in component + E2E | @axe-core/playwright | PR |

## 2. Critical test suites (must exist before their phase is "done")

| Suite | Contents | Phase |
|---|---|---|
| Auth & sessions | Registration, login timing parity, lockout, OTP lifecycle, refresh rotation, reuse detection, race grace, revocation propagation to sockets, logout-all, cookie flags | 4 |
| Authorization matrix | Auto-generated from route table × role fixtures; asserts allow/deny & NOT_FOUND semantics | 4 (grows each phase) |
| Pricing | ≥ 40 table-driven scenarios + property tests (sum, non-negativity, caps, determinism) | 6 |
| Coupons concurrency | 50 parallel redemptions vs limit | 6 |
| Order state machine | Exhaustive state × event matrix; concurrency (double accept, cancel vs accept race) | 7 |
| Idempotency | Concurrent identical requests; key reuse with different body | 6–7 |
| Payments | Signature forgery, webhook dedupe, out-of-order, late capture refund, amount mismatch, double capture | 6 |
| Dispatch | Eligibility filters, ranking determinism, sequential offers, timeout, round expansion, escalation, double-accept race, heartbeat loss | 9 |
| Tracking | Validation (accuracy, skew, speed), throttled fan-out, privacy windows | 9–10 |
| Ledger | Balanced postings for every flow; nightly integrity check on fixture dataset | 6–11 |
| Realtime | Handshake auth, room authorization, revocation, ordering/version, reconnect resync | 10 |
| E2E flows | AC-E2E-001…009 | 12–13 |

## 3. Test data & environments
- Deterministic seed (`packages/db/seed`): pilot city zone polygon, 30 restaurants/45 branches with realistic menus (veg/non-veg/egg, variants, customizations), 20 partners with scripted locations, customers, coupons, fee/tax configs. Demo accounts documented in README (Phase 14).
- Factories for tests (no shared mutable fixtures); each integration test runs in a transaction or isolated schema; Redis DB flushed per test file.
- Fake clock (Vitest timers + injectable `Clock` service) for all timeout/job tests — no real sleeps.
- External providers always mocked in CI; Razorpay test mode only in staging.

## 4. Quality gates (CI)
Lint, typecheck, unit + integration green; coverage thresholds (domain ≥ 90 %, backend ≥ 75 %); no new critical vulnerabilities; OpenAPI drift = 0; SRS ID check = 0 duplicates/dangling; E2E smoke green; axe serious/critical = 0 on touched pages.

## 5. Traceability in tests
Test titles start with requirement/test IDs (`TC-AUTH-005 [FR-AUTH-022] rotates refresh token`), enabling a CI report that maps results back to the Traceability Matrix.
