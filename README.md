# FoodOrderSystem — Online Food Ordering & Delivery Platform

A production-oriented food delivery ecosystem: customer, restaurant (including kitchen display), delivery-partner and admin applications on a shared Node.js/TypeScript modular-monolith backend (Express, Socket.IO, PostgreSQL + PostGIS, Prisma, Redis, BullMQ).

> **Status:** Phase 3 (database) complete — full schema, migrations and seed data on top of the Phase 2 platform skeleton; no business features yet. See [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Repository layout

| Path                  | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `apps/api`            | REST API (`/api/v1`) + Socket.IO gateway — modular monolith                |
| `apps/worker`         | BullMQ background job worker                                               |
| `apps/customer-web`   | Customer web app (port 5173)                                               |
| `apps/restaurant-web` | Restaurant dashboard & kitchen display (port 5174)                         |
| `apps/delivery-web`   | Delivery partner mobile web app (port 5175)                                |
| `apps/admin-web`      | Admin console (port 5176)                                                  |
| `packages/shared`     | Framework-free domain helpers: integer-paise money, error codes, constants |
| `packages/validation` | Zod schemas shared by API validation and web forms                         |
| `packages/types`      | API contract types (response envelope, readiness report)                   |
| `packages/db`         | Prisma schema (one file per domain), migrations, seed, DB tests            |
| `packages/ui`         | Design system: Tailwind theme tokens + React components                    |
| `packages/api-client` | Axios client + TanStack Query helpers for the web apps                     |
| `packages/config`     | Shared TypeScript presets                                                  |
| `tests/e2e`           | Playwright end-to-end tests                                                |
| `infrastructure/`     | Dockerfiles, service configuration                                         |
| `docs/`               | SRS, architecture, ADRs, ERD, roadmap                                      |

## Prerequisites

- **Node.js 22+** (`.nvmrc`) — `nvm use`
- **pnpm 10** via Corepack:

```bash
corepack enable
```

- **Docker** with Compose v2, for PostgreSQL/PostGIS, Redis, S3-compatible storage (SeaweedFS) and Mailpit.

## Getting started

1. Install dependencies:

```bash
pnpm install
```

2. Create your local environment file (all variables are validated at startup; see `.env.example` for descriptions):

```bash
cp .env.example .env
```

3. Start the infrastructure (Postgres + PostGIS, Redis core and cache, SeaweedFS S3, Mailpit):

```bash
pnpm infra:up
```

4. Apply database migrations and load the development data (fictional pilot-city restaurants, partners and demo accounts — see [docs/database/SCHEMA-NOTES.md](docs/database/SCHEMA-NOTES.md)):

```bash
pnpm --filter @fos/db db:deploy
```

```bash
pnpm --filter @fos/db db:seed
```

No Docker? Run a project-local PostgreSQL 18 + PostGIS on port 5433 instead (macOS: `brew install postgresql@18 postgis`), and point the `*_DATABASE_URL` variables in `.env` at port 5433:

```bash
infrastructure/scripts/local-postgres.sh init
```

and a project-local Redis (core on 6390, cache on 6391; point `REDIS_CORE_URL`, `REDIS_CACHE_URL` and `TEST_REDIS_URL` there):

```bash
infrastructure/scripts/local-redis.sh start
```

5. Run the API, worker and all four web apps with hot reload:

```bash
pnpm dev
```

| Service                                       | URL                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| API liveness / readiness                      | http://localhost:4000/health/live · http://localhost:4000/health/ready |
| Worker health                                 | http://localhost:4001/health/ready                                     |
| Customer / Restaurant / Delivery / Admin apps | http://localhost:5173 · 5174 · 5175 · 5176                             |
| Mailpit (captured email)                      | http://localhost:8025                                                  |
| S3 endpoint (SeaweedFS)                       | http://localhost:8333                                                  |

### Signing in during development

There are no real SMS or email providers until Phase 7. The worker writes every one-time code and email link to `.local/dev-messages.log`, so keep the worker running and read codes from there:

```bash
tail -f .local/dev-messages.log
```

Seed accounts sign in with a code to their phone number (see [SCHEMA-NOTES §6](docs/database/SCHEMA-NOTES.md)); new numbers create a customer account. The admin app is password + emailed code only, with no self sign-up.

### Locations during development

Address search uses a mock geocoder with a dozen Bengaluru localities (`GEO_PROVIDER=mock`). The seeded delivery zones cover Koramangala–HSR (`lat=12.9352&lng=77.6245`) and Indiranagar (`lat=12.9719&lng=77.6412`); Jayanagar (`lat=12.925&lng=77.5838`) is deliberately outside every zone. For example:

```bash
curl -s -H 'X-Client-App: CUSTOMER' 'http://localhost:4000/api/v1/discovery/restaurants?lat=12.9352&lng=77.6245'
```

In production `GEO_PROVIDER` defaults to `none` until a provider is chosen: address search then reports that it is unavailable and customers drop a pin on the map.

### Payments during development

`PAYMENT_PROVIDER=mock` (the default outside production) uses an in-memory provider that signs callbacks and webhooks exactly like Razorpay. Instead of a hosted checkout page, the customer app calls `POST /api/v1/payments/{paymentId}/mock-checkout` with `{"scenario":"success"}` (or `fail`, `authorize_only`, `amount_mismatch`); it returns the `providerPaymentId` and `signature` to send to `/verify`, and delivers the matching webhook. The worker processes webhooks and refunds, so keep it running. Production refuses the mock and needs `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRETS`, with automatic capture enabled on the Razorpay account.

### Orders and notifications during development

Keep the worker running while testing orders: it runs the outbox relay (an order paid online becomes `PLACED` only after the relay sees `payment.captured`), the order timers (15-minute payment window, 5-minute acceptance timeout, auto-preparing), refunds and notification delivery. Without real providers, SMS and email notifications go to `.local/dev-messages.log` and push notifications are written to the worker log. In-app notifications appear at `GET /api/v1/me/notifications` for the app in `X-Client-App`. Invoices (`GET /api/v1/orders/{id}/invoice`) exist only for delivered orders.

### Restaurant app during development

Run the API, the worker and `pnpm --filter @fos/restaurant-web dev` (port 5174, proxied to the API). Seeded staff of Saffron Handi Biryani sign in by mobile OTP (codes appear in `.local/dev-messages.log`): owner `9000000201`, manager `9000000301`, kitchen `9000000302`. A new user who signs up in the restaurant app gets the application form. Uploads use the local storage driver (`STORAGE_DRIVER=local`, files under `.local/storage`, served by the API); set `STORAGE_DRIVER=s3` with the SeaweedFS settings to use object storage. PAN and bank numbers are encrypted with `FIELD_ENCRYPTION_KEYS` (derived from `AUTH_HMAC_SECRET` when unset outside production).

### Delivery app during development

Run the API, the worker and `pnpm --filter @fos/delivery-web dev` (port 5175, proxied to the API; set `VITE_API_PROXY_TARGET` if the API is not on port 4000). Seeded partners sign in by mobile OTP: `9000000401`…`9000000406` (406 rides a bicycle). A new user who signs up in the delivery app gets the application form. Going online needs a location fix, so allow location access in the browser; offers arrive only while the restaurant is open and the worker is running (it creates deliveries from accepted orders and runs dispatch, offer timeouts and the sweeps). The app polls until live updates arrive in Phase 10. The customer delivery code is shown on the order's tracking page (`GET /api/v1/orders/{id}/tracking`).

To run the API and worker in containers instead of on the host:

```bash
docker compose --profile app up -d --build
```

## Quality checks

Everything CI runs (format, lint, typecheck, unit and database tests, SRS ID check). Database tests need `TEST_DATABASE_URL`; they are skipped with a warning when it is unset:

```bash
pnpm check
```

End-to-end smoke tests (first run downloads Chromium):

```bash
pnpm --filter @fos/e2e e2e:install
```

```bash
pnpm --filter @fos/e2e e2e
```

Full-stack auth journeys (need the API, worker, database and Redis running):

```bash
E2E_FULL_STACK=1 pnpm --filter @fos/e2e e2e fullstack
```

## Documentation

- **SRS (source of truth):** [docs/requirements/SRS-Online-Food-Ordering-and-Delivery-Platform.md](docs/requirements/SRS-Online-Food-Ordering-and-Delivery-Platform.md)
- **Architecture:** [docs/architecture/SYSTEM-ARCHITECTURE.md](docs/architecture/SYSTEM-ARCHITECTURE.md) · [ADRs](docs/architecture/adr/README.md)
- **Roadmap & risks:** [docs/ROADMAP.md](docs/ROADMAP.md)
- **Phase 1 review pack:** [docs/PHASE-1-REVIEW.md](docs/PHASE-1-REVIEW.md)

After editing any SRS file, regenerate the requirements index:

```bash
pnpm docs:index
```
