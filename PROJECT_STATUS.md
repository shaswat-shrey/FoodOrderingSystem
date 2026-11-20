# Project Status

_Last updated: 2026-11-20_

## Summary

| Item              | Status                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| Current phase     | **Phase 2 — Repository & infrastructure: complete, awaiting owner review** |
| Next phase        | Phase 3 — Database (schema, constraints, migrations, seed)                 |
| SRS version       | FOS-SRS-001 v0.2.1 (APPROVED 2026-11-20; v0.2.1 = editorial storage patch) |
| Business features | None yet (by design — they start in Phase 4)                               |

## Phases

| Phase                         | Status                                                    |
| ----------------------------- | --------------------------------------------------------- |
| 1 Requirements & architecture | ✅ Approved 2026-11-20 (defaults adopted for OD-01…OD-16) |
| 2 Repository & infrastructure | ✅ Complete 2026-11-20 (see verification notes)           |
| 3 Database                    | Not started                                               |
| 4 Auth & security             | Not started                                               |
| 5 Core customer backend       | Not started                                               |
| 6 Cart, pricing, checkout     | Not started                                               |
| 7 Order management            | Not started                                               |
| 8 Restaurant application      | Not started                                               |
| 9 Delivery application        | Not started                                               |
| 10 Real-time                  | Not started                                               |
| 11 Admin                      | Not started                                               |
| 12 Frontend integration       | Not started                                               |
| 13 Testing & hardening        | Not started                                               |
| 14 Finalization               | Not started                                               |

## Phase 2 deliverables

| Area                   | Delivered                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo               | pnpm 10 workspaces, Turborepo pipeline, strict TypeScript presets, ESLint flat config (module-boundary + raw-SQL rules, verified to fire), Prettier, EditorConfig                                                                                                                             |
| Infrastructure         | `docker-compose.yml`: PostGIS 16 (extensions + `fos_test` DB), Redis core (noeviction, AOF), Redis cache (allkeys-lru), SeaweedFS S3 + bucket init, Mailpit; opt-in `app` profile for api/worker; multi-stage non-root Dockerfiles                                                            |
| API (`apps/api`)       | Express 5 app factory, Zod env validation, pino logging with secret redaction, request IDs, Helmet, CORS allowlist, JSON-only 100 KB bodies, standard envelope & error boundary, liveness/readiness, Socket.IO gateway (4 namespaces, deny-all until Phase 4), graceful shutdown, tsup bundle |
| Worker (`apps/worker`) | BullMQ processor registry (empty until feature jobs), health server, graceful shutdown                                                                                                                                                                                                        |
| Packages               | `shared` (money, error codes, constants), `validation`, `types`, `db` (Prisma 6 + extensions migration), `ui` (Tailwind v4 tokens, Button, Card, Spinner, DietaryMarker, Empty/Error states), `api-client` (Axios + TanStack Query defaults)                                                  |
| Web apps               | Customer, restaurant, delivery, admin shells: routing, layout + skip link, 404/error pages, live platform status; feature screens clearly marked "awaiting implementation"                                                                                                                    |
| Tests                  | 56 unit/component tests (Vitest) + 8 Playwright E2E checks (desktop + mobile, axe accessibility scan)                                                                                                                                                                                         |
| CI                     | GitHub Actions: format, lint, typecheck, test, build, SRS ID check, E2E, image builds                                                                                                                                                                                                         |

## Verification notes (what was and wasn't run)

- ✅ `pnpm check` (format, lint, typecheck, all unit tests, SRS ID check) passes locally.
- ✅ All six apps build; API and worker production bundles were booted and probed (live 200, ready 503 with dependencies down, clean SIGTERM shutdown).
- ✅ Customer app verified in a browser against a running API through the Vite proxy; Playwright E2E 8/8 pass.
- ⚠️ **Docker was not available on the development machine**, so `docker compose up` and the Dockerfiles have **not been run**. Image tags were confirmed to exist on Docker Hub. First run on a Docker host (or the CI `docker` job) is the verification step.
- ⚠️ The database migration (extensions only) has not been applied to a live PostgreSQL for the same reason.
- ⚠️ The CI workflow has not run yet (nothing pushed to GitHub).

## Modules

| Module                                                                | Status                    |
| --------------------------------------------------------------------- | ------------------------- |
| Platform (HTTP, logging, config, health, Redis, socket gateway shell) | Implemented (Phase 2)     |
| Domain modules (auth … realtime)                                      | Designed; not implemented |

## APIs

- Implemented: **API-SYS-001** `/health/live`, **API-SYS-002** `/health/ready` (worker exposes the same probes).
- Planned: 492 remaining (see `docs/requirements/API-SPECIFICATION.md`).

## UI pages

- Implemented: app shells (home with platform status, 404, route error) for all four apps.
- Planned: customer 21, restaurant 24, delivery 19, admin 31 feature pages (SRS §17.1).

## Database migrations

- `20261120000000_extensions` — enables postgis, pg_trgm, unaccent, citext, pgcrypto. No tables yet (Phase 3).

## Known bugs

- None known.

## Known discrepancies (SRS vs implementation)

- None open. Resolved: development object storage changed from MinIO to SeaweedFS (MinIO stopped publishing community images) — recorded in SRS v0.2.1.

## Technical decisions (Phase 2)

- ADR-001…014 accepted 2026-11-20.
- Toolchain versions: Node 22 LTS target, pnpm 10, TypeScript 5.9, Express 5, Socket.IO 4, BullMQ 5, Prisma 6.19, Zod 4, React 19, React Router 7, TanStack Query 5, Tailwind CSS 4, Vite 7, Vitest 3, Playwright.
- Workspace packages ship TypeScript sources; API and worker are bundled with tsup (workspace code bundled, third-party packages external and declared per app).
- Readiness: database is critical (503), Redis is degradable (200 "degraded") per NFR-AVAIL-004/005; public readiness output contains generic reasons only, details go to logs.
- Socket gateway is deny-by-default until handshake authentication lands in Phase 4.
- Load-test scaffolding (k6) is deferred to Phase 13 when there are endpoints worth loading.

## Blockers

- None for Phase 3. Docker is needed on a development machine to run the stack.
- Legal/tax review items (SRS §20.4) — needed before launch, not before Phase 3.

## Next steps

1. Owner review of Phase 2.
2. Phase 3 — Prisma models for all MVP entities, SQL migrations (PostGIS columns & indexes, partial uniques, checks, ledger/audit triggers, partitions), seed data, constraint tests.

## TODO

- [ ] Run `docker compose up` and both Dockerfiles on a Docker host (or via CI) and record the result
- [ ] Push to GitHub so the CI workflow runs
- [ ] Phase 3: database
