# FoodOrderSystem — Online Food Ordering & Delivery Platform

A production-oriented, Swiggy-style food delivery platform: a customer app, a restaurant app with a kitchen display, a delivery-partner app and an admin console, on one Node.js/TypeScript modular-monolith backend (Express, Socket.IO, PostgreSQL + PostGIS, Prisma, Redis, BullMQ) with a background worker.

> **Status:** MVP complete — release candidate (Phases 1–14). Awaiting owner sign-off; real SMS/email/push providers and the Razorpay live checkout are not integrated yet. See [PROJECT_STATUS.md](PROJECT_STATUS.md) and [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).

## What's in it

| App                                        | Port          | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Customer** (`apps/customer-web`)         | 5173          | Sign-in by phone OTP or password; location by saved address, GPS or area search; discovery with filters and sorting; search with typo tolerance; menus with variants and add-ons; cart with coupons and price-change flags; checkout with tip, contactless delivery, COD, wallet and online payment (dev provider); live order tracking with partner location and ETA; cancellation with fee preview; order history, invoices, reorder, issue reports; ratings and reviews; addresses, profile, food preferences, favourites, wallet, notifications inbox, help tickets |
| **Restaurant** (`apps/restaurant-web`)     | 5174          | Self-serve onboarding (business, tax and bank details encrypted, documents, first outlet, hours); order queue with alerts, accept with prep time, reject, preparing, ready, handover with the partner's pickup code; kitchen display without prices; menu management (categories, dishes, photos, variants, option groups, per-outlet stock); outlet status, pause, rush mode, hours and holidays; team invitations with role and outlet scope; dashboard and analytics; reviews with responses; payouts with settlement breakdown                                      |
| **Delivery partner** (`apps/delivery-web`) | 5175          | Application with documents, vehicle and bank details; online/offline with location fix, breaks and blockers; live offers with a countdown; trip stages with geofenced arrivals, pickup code, OTP or photo proof and COD collection; earnings, trips, cash in hand, payouts and bank change                                                                                                                                                                                                                                                                              |
| **Admin** (`apps/admin-web`)               | 5176          | Password + emailed code sign-in; permission-filtered console: dashboard and ops alerts, restaurant and partner approvals, users (masked PII, suspend, sessions, wallet adjustments), restaurants, partners, orders (cancel, mark delivered/failed, refunds), dispatch board with manual assignment, payments and webhooks, refunds, payout batches (maker ≠ checker), coupons, zones with surge, settings, fees, taxes, commission and pay plans, support desk, review moderation, roles, audit log, failed jobs                                                        |
| **API** (`apps/api`)                       | 4000          | REST under `/api/v1` (395 operations, [OpenAPI](docs/api/README.md)), Socket.IO gateway with room policies, payment webhooks, file uploads                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Worker** (`apps/worker`)                 | 4001 (health) | Outbox relay (single leader), order timers, dispatch and offer timeouts, notifications, payments and refunds, settlements, sweeps and maintenance jobs                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Architecture at a glance

```
 customer / restaurant / delivery / admin  (React + Vite SPAs, served as static files)
                     │  same origin: /api/v1 (REST) · /socket.io (WebSocket)
                     ▼
        Nginx / load balancer (TLS, one proxy hop)
                     ▼
   API × N  (Express + Socket.IO, stateless; Redis adapter for sockets)
     │            ▲ realtime events (Redis pub/sub)
     ▼            │
 PostgreSQL 16 + PostGIS ◄──── Worker × M (BullMQ queues, schedulers, outbox relay leader)
 Redis core (queues, locks, sessions, live geo — noeviction)   Redis cache (LRU)
 S3-compatible object storage (public media + private documents)
```

- **Modular monolith**: one module per domain under `apps/api/src/modules/*`, each used by others only through its `index.ts`.
- **Transactional outbox**: state changes write `outbox_events` in the same transaction; the worker relays them to consumers, notifications and socket rooms, so pushes always follow commits.
- **Money** in integer paise, a double-entry ledger with a balance trigger, idempotency keys on every money-moving request.
- **Auth**: short-lived JWT access tokens, rotating refresh cookies with reuse detection, per-app audiences, RBAC with resource policies, admin MFA.

Details: [SYSTEM-ARCHITECTURE.md](docs/architecture/SYSTEM-ARCHITECTURE.md) · [ADRs](docs/architecture/adr/README.md) · [state machines](docs/architecture/STATE-MACHINES.md) · [events and jobs](docs/architecture/EVENTS-AND-JOBS.md) · [dispatch algorithm](docs/architecture/DELIVERY-ASSIGNMENT-ALGORITHM.md) · [payments](docs/architecture/PAYMENT-ARCHITECTURE.md).

## Prerequisites

- **Node.js 22.12+** (`.nvmrc`): `nvm use`
- **pnpm 10** via Corepack: `corepack enable`
- Either **Docker** with Compose v2, or local **PostgreSQL 16+ with PostGIS** and **Redis 7** (see "Without Docker").

## Quick start

```bash
pnpm install
cp .env.example .env          # development values; every variable: docs/guides/ENVIRONMENT.md
```

### Option A — Docker Compose

```bash
pnpm infra:up                 # PostGIS (5432, with fos_test and fos_shadow), Redis core (6379) and cache (6380), SeaweedFS S3 (8333), Mailpit
pnpm --filter @fos/db db:deploy
pnpm --filter @fos/db db:seed
pnpm dev                      # API, worker and the four apps with hot reload
```

`.env.example` already points at these ports. To run the API and worker in containers too: `docker compose --profile app up -d --build`. Stop everything with `pnpm infra:down`.

### Option B — without Docker

Project-local services that never touch other PostgreSQL or Redis servers on the machine (data under `.local/`):

```bash
# macOS: brew install postgresql@18 postgis redis   (PG_BIN overrides the postgresql@18 path)
infrastructure/scripts/local-postgres.sh init     # PostgreSQL + PostGIS on 5433: role fos, databases fos and fos_test
infrastructure/scripts/local-redis.sh start       # Redis core on 6390, cache on 6391
```

Then edit `.env`:

```bash
DATABASE_URL=postgresql://fos:fos_dev_password@localhost:5433/fos
TEST_DATABASE_URL=postgresql://fos:fos_dev_password@localhost:5433/fos_test
SHADOW_DATABASE_URL=postgresql://fos:fos_dev_password@localhost:5433/fos_shadow   # create it once for db:drift
REDIS_CORE_URL=redis://localhost:6390
REDIS_CACHE_URL=redis://localhost:6391
TEST_REDIS_URL=redis://localhost:6390/15
```

and continue with `db:deploy`, `db:seed` and `pnpm dev` as above. `local-postgres.sh start|stop|status` and `local-redis.sh stop|status` manage the services afterwards.

### Running pieces separately

| What           | Command                                 | URL                                                 |
| -------------- | --------------------------------------- | --------------------------------------------------- |
| API            | `pnpm --filter @fos/api dev`            | http://localhost:4000/health/live · `/health/ready` |
| Worker         | `pnpm --filter @fos/worker dev`         | http://localhost:4001/health/ready                  |
| Customer app   | `pnpm --filter @fos/customer-web dev`   | http://localhost:5173                               |
| Restaurant app | `pnpm --filter @fos/restaurant-web dev` | http://localhost:5174                               |
| Delivery app   | `pnpm --filter @fos/delivery-web dev`   | http://localhost:5175                               |
| Admin console  | `pnpm --filter @fos/admin-web dev`      | http://localhost:5176                               |

The apps proxy `/api`, `/health` and `/socket.io` to the API (set `VITE_API_PROXY_TARGET` if it is not on port 4000). **Keep the worker running**: it delivers sign-in codes, runs the outbox relay (online-paid orders become `PLACED` only after it sees the capture), order timers, dispatch, refunds and notifications.

## Signing in during development

There are no real SMS, email or push providers yet. The worker writes every one-time code, emailed code and email link to **`.local/dev-messages.log`**:

```bash
tail -f .local/dev-messages.log
```

- Customers, restaurant staff and partners sign in with a code sent to their phone number. A new number creates a customer account (or, in the restaurant and delivery apps, starts an application).
- The admin console accepts only a password plus an emailed code. Seed accounts have no passwords: use **Forgot password** with the admin's email, open the reset link from the log, set a password, then sign in and read the emailed code from the same log.

Demo accounts and a scripted 15-minute walkthrough: **[docs/guides/DEMO.md](docs/guides/DEMO.md)**.

## Development data

`pnpm --filter @fos/db db:seed` truncates every table and loads a fictional Bengaluru pilot: two delivery zones (Koramangala–HSR, Indiranagar), 8 restaurants with 10 outlets and 41 dishes, customers, restaurant staff, 6 approved partners, admins, fee/tax/commission/pay configuration and coupons `WELCOME50`, `FLAT100`, `FREEDEL`. It refuses to run with `NODE_ENV=production`. Details: [SCHEMA-NOTES §6](docs/database/SCHEMA-NOTES.md).

- **Locations**: a mock geocoder knows a dozen Bengaluru localities (`GEO_PROVIDER=mock`). Koramangala (`12.9352, 77.6245`) and Indiranagar (`12.9719, 77.6412`) are served; Jayanagar (`12.925, 77.5838`) is deliberately outside every zone.
- **Payments**: `PAYMENT_PROVIDER=mock` signs callbacks and webhooks like Razorpay. The customer app's payment step lets you pick "succeeds" or "fails" (`POST /api/v1/payments/{id}/mock-checkout`, development only).
- **Files**: `STORAGE_DRIVER=local` keeps uploads in `.local/storage`; `s3` with the SeaweedFS settings uses object storage.
- **Mailpit** (http://localhost:8025) starts with Docker Compose but receives nothing yet: messages go to the dev log.

## Tests and quality checks

| What                           | Command                                                                              | Needs                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything CI runs on a PR     | `pnpm check` (format check, lint, typecheck, unit + integration tests, SRS ID check) | `TEST_DATABASE_URL`, `TEST_REDIS_URL` for integration tests (skipped with a warning otherwise)                                                                      |
| Unit + integration tests       | `pnpm test`                                                                          | as above                                                                                                                                                            |
| Coverage (thresholds enforced) | `pnpm test:coverage`                                                                 | as above                                                                                                                                                            |
| Migration drift                | `pnpm --filter @fos/db db:drift`                                                     | `SHADOW_DATABASE_URL`                                                                                                                                               |
| End-to-end (Playwright)        | `pnpm --filter @fos/e2e e2e:install` once, then `pnpm --filter @fos/e2e e2e`         | Postgres and Redis from `.env`; builds the apps and starts an isolated stack on 4300/5373–5376 with database `fos_e2e` ([tests/e2e/README.md](tests/e2e/README.md)) |
| Load (k6)                      | `k6 run tests/load/discovery.js` …                                                   | A staging stack and accounts ([tests/load/README.md](tests/load/README.md)); quick smoke without k6: `node tests/load/smoke.mjs --base http://localhost:4000`       |
| API document                   | `pnpm docs:api` (write) · `pnpm docs:api --check` (drift)                            | nothing (no database or Redis needed)                                                                                                                               |
| SRS requirement index          | `pnpm docs:index` (write) · `pnpm docs:check`                                        | —                                                                                                                                                                   |
| Formatting                     | `pnpm format`                                                                        | —                                                                                                                                                                   |

## Project layout

| Path                                                                  | What it is                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                                                            | REST API (`/api/v1`) + Socket.IO gateway; `src/modules/*` (auth, iam, catalog, checkout, orders, payments, dispatch, partners, merchant, admin, …), `src/platform/*` (HTTP, logging, Redis, realtime, outbox) |
| `apps/worker`                                                         | BullMQ processors, schedulers and the outbox relay                                                                                                                                                            |
| `apps/customer-web` · `restaurant-web` · `delivery-web` · `admin-web` | The four React apps                                                                                                                                                                                           |
| `packages/db`                                                         | Prisma schema (one file per domain), SQL migrations, seed, constraint tests                                                                                                                                   |
| `packages/shared`                                                     | Framework-free domain helpers: money in paise, error codes, constants                                                                                                                                         |
| `packages/validation`                                                 | Zod schemas shared by the API and the web forms                                                                                                                                                               |
| `packages/types`                                                      | API contract types                                                                                                                                                                                            |
| `packages/api-client`                                                 | Typed API client, socket client and TanStack Query helpers                                                                                                                                                    |
| `packages/auth-web`                                                   | Shared sign-in, sign-up, recovery and account security pages                                                                                                                                                  |
| `packages/ui`                                                         | Design system (Tailwind tokens + React components)                                                                                                                                                            |
| `packages/config`                                                     | Shared TypeScript presets                                                                                                                                                                                     |
| `tests/e2e` · `tests/load`                                            | Playwright journeys · k6 scripts                                                                                                                                                                              |
| `infrastructure/docker` · `infrastructure/scripts`                    | Production Dockerfiles for API and worker, Compose service config · local Postgres/Redis scripts                                                                                                              |
| `docs/`                                                               | SRS, architecture, database, API, guides                                                                                                                                                                      |

## Documentation

| Topic                          | Document                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Requirements (source of truth) | [SRS](docs/requirements/SRS-Online-Food-Ordering-and-Delivery-Platform.md) · [requirements index](docs/requirements/REQUIREMENTS-INDEX.md) · [traceability matrix](docs/requirements/TRACEABILITY-MATRIX.md) |
| API                            | [Generated OpenAPI 3.1](docs/api/openapi.json) · [how to view it](docs/api/README.md) · [API inventory](docs/requirements/API-SPECIFICATION.md)                                                              |
| Database                       | [ERD](docs/database/ERD.md) · [schema notes and migrations](docs/database/SCHEMA-NOTES.md)                                                                                                                   |
| Configuration                  | [Environment variables](docs/guides/ENVIRONMENT.md)                                                                                                                                                          |
| Operations                     | [Deployment guide](docs/guides/DEPLOYMENT.md)                                                                                                                                                                |
| Demo                           | [Demo accounts and walkthrough](docs/guides/DEMO.md)                                                                                                                                                         |
| Scope                          | [Known limitations](docs/KNOWN-LIMITATIONS.md) · [future roadmap](docs/FUTURE-ROADMAP.md) · [delivery roadmap](docs/ROADMAP.md) · [project status](PROJECT_STATUS.md)                                        |
| Architecture                   | [System architecture](docs/architecture/SYSTEM-ARCHITECTURE.md) · [ADRs](docs/architecture/adr/README.md) · [testing strategy](docs/architecture/TESTING-STRATEGY.md)                                        |

After editing any SRS file, regenerate the requirements index with `pnpm docs:index`. After changing routes or their Zod schemas, regenerate the API document with `pnpm docs:api`.
