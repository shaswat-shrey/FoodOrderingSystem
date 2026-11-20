# SRS Section 16 — Non-Functional Requirements

> Part of FOS-SRS-001 v0.6.0 (APPROVED 2026-11-20). **All numeric targets are proposed engineering objectives**, not contractual SLAs. They assume the MVP pilot load profile (A-12) on modest production infrastructure (2–3 API instances, 1–2 worker instances, managed PostgreSQL with 4 vCPU/16 GB, managed Redis). Targets are verified by load tests (k6) in a production-like staging environment before launch, and re-baselined after real traffic.

**Load profiles**
- **Normal:** 20 orders/min, 2,000 concurrent customer sessions, 200 online partners, 300 open restaurant dashboards.
- **Peak:** 60 orders/min (dinner peak), 6,000 concurrent customer sessions, 500 online partners (100 location updates/s), 500 restaurant dashboards.

## 16.1 Performance (NFR-PERF)

| ID | Requirement | Normal | Peak |
|---|---|---|---|
| NFR-PERF-001 | Generic authenticated read APIs (server time, excluding network) | p95 ≤ 200 ms | p95 ≤ 400 ms |
| NFR-PERF-002 | Generic mutations (non-payment) | p95 ≤ 300 ms | p95 ≤ 600 ms |
| NFR-PERF-003 | Restaurant discovery listing (`API-DISC-001`) | p95 ≤ 500 ms | p95 ≤ 800 ms |
| NFR-PERF-004 | Menu load (`API-MENU-001`) — cache hit / miss | p95 ≤ 100 ms / ≤ 400 ms | ≤ 150 / ≤ 600 ms |
| NFR-PERF-005 | Search autocomplete / full search | p95 ≤ 200 ms / ≤ 400 ms | ≤ 300 / ≤ 700 ms |
| NFR-PERF-006 | Checkout session create/update (quote) | p95 ≤ 600 ms | p95 ≤ 1,000 ms |
| NFR-PERF-007 | Order confirmation (excluding payment provider round trip) | p95 ≤ 800 ms | p95 ≤ 1,500 ms |
| NFR-PERF-008 | Real-time: commit → client for order/delivery events; location fan-out | p95 ≤ 1 s; ≤ 2 s | ≤ 2 s; ≤ 3 s |
| NFR-PERF-009 | Dispatch: order dispatchable → first offer sent | p95 ≤ 5 s | p95 ≤ 10 s |
| NFR-PERF-010 | Dashboard initial load (restaurant/admin) — time to interactive on broadband desktop | ≤ 2.5 s | ≤ 3.5 s |
| NFR-PERF-011 | Customer web Core Web Vitals on mid-range Android (Moto G-class, 4G): LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 (75th percentile field data); initial JS ≤ 200 KB gzipped per route | — | — |
| NFR-PERF-012 | No query in a P0 flow exceeds 100 ms p95 at peak; every list endpoint is verified free of N+1 queries (query-count assertions in integration tests). | — | — |
| NFR-PERF-013 | Location ingestion sustains 200 updates/s per API instance with < 50 % CPU. | — | — |
| NFR-PERF-014 | Background jobs: notification enqueue → provider send p95 ≤ 10 s; webhook receipt → processing p95 ≤ 5 s. | — | — |

## 16.2 Scalability (NFR-SCALE)

| ID | Requirement |
|---|---|
| NFR-SCALE-001 | API instances are stateless (no in-memory session state, no local file storage) and horizontally scalable behind a load balancer. |
| NFR-SCALE-002 | Workers scale independently per queue (queue-specific concurrency; separate worker deployments for heavy queues such as notifications and analytics). |
| NFR-SCALE-003 | Socket.IO scales horizontally via the Redis adapter; room fan-out avoids per-socket loops; location broadcasts are throttled per order. Target 20k concurrent sockets per 3 instances. |
| NFR-SCALE-004 | Database: read replicas for analytics/reporting (CORE); monthly partitioning for `audit_logs`, `delivery_locations`, `notifications` when the DB-SCALE-001 thresholds are reached (regular tables until then); connection pooling via PgBouncer. Vertical scaling first; sharding not planned before multi-city scale. |
| NFR-SCALE-005 | Redis: separate logical stores for cache (evictable), queues (noeviction), and realtime/geo (noeviction); can be split into separate instances without code changes (config-driven connection strings). |
| NFR-SCALE-006 | Geographic expansion: zones, fees, taxes, partner pay and feature flags are zone/city-configurable; adding a city requires configuration, not code. Timezone stored per branch. |
| NFR-SCALE-007 | Module boundaries allow extracting dispatch/tracking into a separate service if location throughput exceeds a single cluster's capacity (ADR-001). |

## 16.3 Availability (NFR-AVAIL)

| ID | Requirement |
|---|---|
| NFR-AVAIL-001 | Proposed availability objective: 99.5 % monthly for order placement and restaurant order handling during operating hours (MVP); 99.9 % target for CORE. |
| NFR-AVAIL-002 | Planned maintenance requiring downtime is scheduled 03:00–05:00 IST with in-app notice ≥ 24 h ahead; zero-downtime deploys (rolling) for application releases. |
| NFR-AVAIL-003 | **Degraded modes:** maps/geocoding down → manual pin entry, haversine distances, cached geocodes; SMS provider down → fallback provider (CORE) or email OTP for users with verified email; email down → queue & retry; payment provider down → COD (if eligible) and wallet still available, online payment shows outage banner; push down → socket + SMS for critical events. |
| NFR-AVAIL-004 | **Redis outage:** session validation falls back to DB; rate limiting falls back to per-instance memory limits (fail-closed for auth endpoints); caches bypassed; BullMQ jobs and dispatch paused with alerts; outbox accumulates and drains on recovery; cross-instance socket fan-out degraded (clients fall back to polling at 15 s). |
| NFR-AVAIL-005 | **Database outage:** API returns 503 with retryable flag; readiness probe fails so instances are removed from rotation; no writes are acknowledged that were not committed. |
| NFR-AVAIL-006 | Health endpoints: liveness (process), readiness (DB + Redis + migrations applied) used by orchestrator. |

## 16.4 Reliability (NFR-REL)

| ID | Requirement |
|---|---|
| NFR-REL-001 | Financial transaction integrity: every money movement is a balanced ledger transaction committed atomically with the business state change it reflects. |
| NFR-REL-002 | Duplicate prevention: idempotency keys on all P0 mutating endpoints with client retry potential (order creation, payment initiation/verification, cancellations, refunds, restaurant transitions, partner stage actions); DB uniqueness constraints as the final guard (DB-INT-003). |
| NFR-REL-003 | Retry policies: external HTTP calls — timeout 5 s (payments 10 s), 3 retries with exponential backoff + jitter for idempotent operations only; circuit breaker opens after 50 % failures over 20 requests, half-open after 30 s. |
| NFR-REL-004 | Jobs are idempotent and retried per queue policy (default 5 attempts, exponential backoff from 10 s); permanently failed jobs go to a dead-letter list with alerting and admin retry. |
| NFR-REL-005 | Outbox relay guarantees at-least-once publication of committed events; consumers dedupe by event ID. |
| NFR-REL-006 | Timers are recoverable from DB state (JOB-ORD-007 sweeper) — no business deadline depends solely on an in-memory or Redis-only timer. |
| NFR-REL-007 | Graceful shutdown: API stops accepting new connections, finishes in-flight requests (≤ 25 s), closes sockets with reconnect hint; workers finish or return active jobs to the queue. |

## 16.5 Security (NFR-SEC)

| ID | Requirement |
|---|---|
| NFR-SEC-001 | **Transport:** TLS 1.2+ everywhere (HSTS max-age 1 year, includeSubDomains); no plaintext HTTP in production except redirect. |
| NFR-SEC-002 | **Authentication:** per Section 5; Argon2id passwords; access JWT 15 min; refresh tokens opaque, hashed, rotated, reuse-detected; no tokens in URLs or localStorage. |
| NFR-SEC-003 | **Authorization:** deny by default; every route declares required permission and resource-scope policy; policy unit tests cover allow & deny cases for every role (authorization test matrix generated from the permission catalog). |
| NFR-SEC-004 | **Input validation:** strict Zod schemas on every REST body/query/param and socket payload; size limits (JSON body 100 KB default, 1 MB webhooks); string normalization (NFC) and HTML stripping for free text. |
| NFR-SEC-005 | **Injection:** Prisma parameterized queries only; raw SQL only via tagged templates (`$queryRaw\`…\``) — `$queryRawUnsafe` forbidden by lint rule. |
| NFR-SEC-006 | **XSS:** React escaping; no `dangerouslySetInnerHTML` except sanitized (DOMPurify) CMS content; CSP `default-src 'self'`; no inline scripts; `frame-ancestors 'none'`; uploaded files served with `Content-Disposition` and correct type from a separate domain/bucket. |
| NFR-SEC-007 | **CSRF:** API uses bearer tokens (not cookies) for all endpoints except refresh/logout, which require SameSite=Strict cookie + Origin allowlist + custom header. |
| NFR-SEC-008 | **Headers:** Helmet defaults + CSP, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (geolocation only on customer/delivery origins), `X-Content-Type-Options: nosniff`. |
| NFR-SEC-009 | **CORS:** explicit allowlist of the four app origins per environment; credentials allowed only for auth routes. |
| NFR-SEC-010 | **Rate limiting & abuse prevention:** tiers per §14.1; CAPTCHA adapter after suspicious auth patterns (CORE); OTP pumping protection (per-destination, per-IP, per-country-prefix limits; only +91 enabled in MVP). |
| NFR-SEC-011 | **Secrets:** never committed; loaded from environment / secrets manager; validated at boot (zod env schema); rotation supported for JWT keys (kid), webhook secrets, encryption keys (envelope encryption with key versioning). |
| NFR-SEC-012 | **Encryption at rest:** managed DB/storage encryption; additionally application-level AES-256-GCM encryption for bank account numbers, PAN, TOTP secrets, and change-request payloads. |
| NFR-SEC-013 | **Sensitive data exposure:** API serializers are explicit allowlists (DTOs); password hashes, token hashes, encrypted fields, internal flags never leave the API; error responses never include stack traces or SQL. |
| NFR-SEC-014 | **Logging hygiene:** structured logs redact `password`, `token`, `otp`, `authorization`, `cookie`, `secret`, card-like and Aadhaar-like patterns, bank numbers; enforced by logger redaction config + unit test. |
| NFR-SEC-015 | **File uploads:** magic-byte type check, size limits, EXIF stripping, random object keys, private bucket for documents, no execution, optional AV scanning (CORE). |
| NFR-SEC-016 | **Webhooks:** HMAC signature verification on raw body; timestamp tolerance where provider supports; replay dedupe by event ID. |
| NFR-SEC-017 | **Dependency security:** lockfile committed; automated vulnerability scanning (npm audit / OSV) in CI; criticals block merge; Renovate/Dependabot weekly. |
| NFR-SEC-018 | **Audit logging:** per BR-ADMIN-002; audit logs immutable to application roles. |
| NFR-SEC-019 | **Security testing:** OWASP ASVS L2 checklist review before launch; authenticated DAST scan (OWASP ZAP) in staging; external penetration test before public launch (recommended). |
| NFR-SEC-020 | **Socket security:** per §13 (handshake auth, room authorization, payload validation, rate limits, revocation propagation). |

## 16.6 Privacy (NFR-PRIV)

| ID | Requirement |
|---|---|
| NFR-PRIV-001 | Data minimization: each role's API projection exposes only fields needed for its task (e.g., restaurants never receive customer phone or full address; kitchen sees no customer data; partners see customer address/phone only during the active delivery). |
| NFR-PRIV-002 | Location data: collected from partners only while online; from customers only on explicit action; partner live location visible to the customer only during their active delivery. |
| NFR-PRIV-003 | Consent records for terms/privacy; notification marketing consent separately opt-in. |
| NFR-PRIV-004 | Data subject requests: access/export (FR-CUST-008), correction (profile edit), deletion (FR-AUTH-041), grievance channel (FR-CSUP-006). |
| NFR-PRIV-005 | Retention per §20; automated purge/anonymization jobs with audit trail. |
| NFR-PRIV-006 | PII masking in admin UI by default; reveal requires permission & reason (audited). |
| NFR-PRIV-007 | No PII in analytics events or third-party scripts; analytics use pseudonymous IDs. |

## 16.7 Usability (NFR-UX)

| ID | Requirement |
|---|---|
| NFR-UX-001 | **Customers:** a returning customer can reorder in ≤ 4 taps from home; checkout fits on one screen on 360 px width with sticky "Place order" button showing the final amount; prices shown always include a breakdown sheet. |
| NFR-UX-002 | Veg/non-veg markers are consistent across discovery, menu, cart, checkout, order details, and invoices; veg-only toggle is reachable from home and menu. |
| NFR-UX-003 | Every error message tells the user what happened and what to do next (no raw codes); all blocking states offer a recovery action. |
| NFR-UX-004 | **Restaurant staff:** a new order can be accepted in one tap from anywhere in the app; new order alerts are audible and visible even if the tab is in background (title flashing + notification). |
| NFR-UX-005 | Restaurant UI usable on 10" tablets with touch targets ≥ 44 px. |
| NFR-UX-006 | **Kitchen display:** readable from 2 m (min 20 px body text, 32 px ticket numbers), high-contrast theme, no hover-dependent interactions. |
| NFR-UX-007 | **Delivery partners:** one primary action per screen, ≥ 48 px buttons, works one-handed; offer card readable in sunlight (high contrast mode); critical actions require confirmation with slide-to-confirm to prevent accidental taps. |
| NFR-UX-008 | **Administrators:** data tables support sort, filter, column visibility, keyboard navigation, and saved filters; destructive actions use confirmation dialogs stating consequences. |
| NFR-UX-009 | All forms validate inline on blur and on submit with field-level messages. |
| NFR-UX-010 | Loading: skeletons for content ≥ 300 ms; optimistic updates only for non-financial toggles (favorites, availability) with rollback. |

## 16.8 Accessibility (NFR-ACCESS)

| ID | Requirement |
|---|---|
| NFR-ACCESS-001 | Customer and restaurant apps target WCAG 2.2 Level AA; delivery and admin apps target AA for core flows. |
| NFR-ACCESS-002 | Full keyboard operability; visible focus indicators (≥ 3:1 contrast); logical tab order; skip-to-content link. |
| NFR-ACCESS-003 | Screen reader support: semantic HTML landmarks, labeled controls, `aria-live` regions for order status updates and toasts, dialogs with focus trap & return focus. |
| NFR-ACCESS-004 | Color contrast ≥ 4.5:1 text, ≥ 3:1 UI components; dietary markers convey meaning by shape (square/triangle) + text label, not color alone. |
| NFR-ACCESS-005 | Forms: programmatic labels, error identification with `aria-describedby`, error summary on submit. |
| NFR-ACCESS-006 | Respect `prefers-reduced-motion`; no auto-playing animations > 5 s without pause. |
| NFR-ACCESS-007 | Automated checks (axe-core) in component tests and E2E on key pages; zero serious/critical violations to merge. |

## 16.9 Maintainability (NFR-MAINT)

| ID | Requirement |
|---|---|
| NFR-MAINT-001 | Modular monolith: each module exposes a public interface (`index.ts`); cross-module imports of internals are forbidden (enforced by ESLint `import/no-restricted-paths` / dependency-cruiser). |
| NFR-MAINT-002 | TypeScript strict mode; no `any` without justification comment; ESLint + Prettier enforced in CI; conventional commits. |
| NFR-MAINT-003 | Test coverage targets: domain services (pricing, state machines, dispatch, auth) ≥ 90 % lines/branches; overall backend ≥ 75 %; critical E2E flows covered. |
| NFR-MAINT-004 | Dependencies pinned via lockfile; major upgrades through dedicated PRs with changelog review. |
| NFR-MAINT-005 | Semantic versioning for releases; CHANGELOG maintained; API versioned by path. |
| NFR-MAINT-006 | OpenAPI generated from Zod schemas used at runtime; CI fails if generated spec differs from committed spec. |
| NFR-MAINT-007 | Database migrations are reviewed, forward-only in production, follow expand/contract for breaking changes, and are tested against a production-like snapshot before release. |
| NFR-MAINT-008 | Every module has a README describing responsibilities, public API, events emitted/consumed, and jobs. |
| NFR-MAINT-009 | SRS, traceability matrix and PROJECT_STATUS.md updated in the same PR as the related code change. |

## 16.10 Compatibility (NFR-COMPAT)

| ID | Requirement |
|---|---|
| NFR-COMPAT-001 | Browsers per §3.5 (last 2 major versions of Chrome, Edge, Firefox, Safari; Samsung Internet); no IE. |
| NFR-COMPAT-002 | Responsive breakpoints: 360, 768, 1024, 1280, 1536 px; customer app fully functional from 360 px; restaurant app from 768 px (phone view limited to order queue); delivery app optimized 360–430 px; admin from 1280 px. |
| NFR-COMPAT-003 | Delivery PWA works on Android 10+ Chrome and iOS 16.4+ Safari (installed). |
| NFR-COMPAT-004 | Server runs on Linux containers (amd64/arm64); local dev on macOS, Linux, Windows (WSL2) via Docker Compose. |

## 16.11 Observability (NFR-OBS)

| ID | Requirement |
|---|---|
| NFR-OBS-001 | Structured JSON logs (pino) with level, timestamp, service, module, requestId, correlationId, userId (pseudonymous), sessionId hash, route, latency, status. |
| NFR-OBS-002 | Request ID generated per request (or accepted from client), propagated to jobs, outbox events, socket emits and provider calls (as metadata) — correlation across API → queue → worker. |
| NFR-OBS-003 | Metrics (Prometheus format, OpenTelemetry-ready): HTTP latency/error by route, DB pool usage & query latency, Redis latency, queue depth/age/failures per queue, socket connections & emits, business metrics (orders by state, dispatch time, payment success rate, webhook lag). |
| NFR-OBS-004 | Tracing: OpenTelemetry instrumentation for HTTP, Prisma, Redis, BullMQ (CORE), exportable to any OTLP backend. |
| NFR-OBS-005 | Error tracking adapter (Sentry-compatible) for API, worker and frontends, with PII scrubbing. |
| NFR-OBS-006 | Alerts (initial set): API 5xx > 2 % for 5 min; p95 latency breach for 10 min; queue age > 2 min; dead-letter growth; payment success rate < 80 % over 15 min; webhook processing lag > 5 min; orders stuck alerts (ops); DB connections > 80 %; Redis unavailable; no location updates platform-wide for 2 min during operating hours. |
| NFR-OBS-007 | Job logs include job ID, queue, attempt, duration, outcome; payment events logged with provider IDs (no secrets); WebSocket connection lifecycle logged at info (connect/disconnect/auth failure). |

## 16.12 Backup & recovery (NFR-BACKUP)

| ID | Requirement |
|---|---|
| NFR-BACKUP-001 | PostgreSQL: continuous WAL archiving / managed PITR; daily full backup; 35-day PITR window; monthly backup retained 12 months; backups encrypted and stored in a separate account/region. |
| NFR-BACKUP-002 | Proposed objectives: **RPO ≤ 5 minutes**, **RTO ≤ 2 hours** for the primary database (MVP); RTO ≤ 1 h for CORE. |
| NFR-BACKUP-003 | Redis is treated as reconstructable: queues are rebuilt from DB state by sweeper jobs; caches are disposable; AOF persistence enabled on the queue instance to minimise job loss. |
| NFR-BACKUP-004 | Object storage: versioning enabled on document buckets; lifecycle rules per retention policy; cross-region replication for documents (CORE). |
| NFR-BACKUP-005 | Restore drills quarterly with documented runbook, measured RTO, ledger integrity verification. |
| NFR-BACKUP-006 | Disaster recovery: infrastructure as code (CORE) so the stack can be recreated in another region from backups; DR plan documented before public launch. |
