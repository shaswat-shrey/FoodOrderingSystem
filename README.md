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
