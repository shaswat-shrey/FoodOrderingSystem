# Project Status

_Last updated: 2026-11-20_

## Summary

| Item              | Status                                                                      |
| ----------------- | --------------------------------------------------------------------------- |
| Current phase     | **Phase 3 — Database: complete, awaiting owner review**                     |
| Next phase        | Phase 4 — Authentication & security                                         |
| SRS version       | FOS-SRS-001 v0.2.2 (APPROVED 2026-11-20; 0.2.1–0.2.2 are editorial patches) |
| Business features | None yet (they start in Phase 4)                                            |

## Phases

| Phase                         | Status                                                    |
| ----------------------------- | --------------------------------------------------------- |
| 1 Requirements & architecture | ✅ Approved 2026-11-20 (defaults adopted for OD-01…OD-16) |
| 2 Repository & infrastructure | ✅ Complete 2026-11-20                                    |
| 3 Database                    | ✅ Complete 2026-11-20 (3 proposed SRS changes pending)   |
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

## Phase 3 deliverables

| Area                    | Delivered                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                  | Multi-file Prisma schema (10 domain files): 147 tables, 105 enums, UUIDv7 keys, integer-paise money, PostGIS geography, `ON DELETE RESTRICT` by default                                                                                                   |
| Migrations              | `extensions` · `core_schema` (generated) · `constraints` (partial uniques, CHECKs, GiST/GIN/trigram indexes, ledger balance, append-only, zone overlap, hours limit, search-vector triggers) · `immutability` (configs, offers, webhooks, location trail) |
| Drift control           | `db:drift` proves migrations replay to exactly the schema; database-vs-schema diff is empty                                                                                                                                                               |
| Seed                    | Repeatable pilot-city dataset: 2 zones, 8 fictional restaurants / 10 branches / 41 items, 21 users across all roles, 6 partners, fees/taxes/commission/pay plan, settings, flags, coupons, ledger accounts, permission catalog                            |
| Shared code             | Permission catalog + default role grants (`@fos/shared/permissions`), UUIDv7 generator                                                                                                                                                                    |
| Tests                   | 33 database integration tests on PostGIS (rebuilt from migrations each run); 97 tests repo-wide (unit, component and database)                                                                                                                                                          |
| CI                      | PostGIS service in the verify job; DB tests and drift check run in CI                                                                                                                                                                                     |
| Local DB without Docker | `infrastructure/scripts/local-postgres.sh` (PostgreSQL 18 + PostGIS on port 5433)                                                                                                                                                                         |
| Docs                    | `docs/database/SCHEMA-NOTES.md` (workflow, every SQL rule → requirement, Prisma error mapping, seed accounts)                                                                                                                                             |

## Verification notes

- ✅ Built from scratch on PostgreSQL 18.7 + PostGIS 3.7 (project-local instance): all 4 migrations apply; both drift checks report no differences; seed loads in ~250 ms and is repeatable.
- ✅ 33 database tests pass; each asserts the specific constraint/trigger that fires (none can pass vacuously).
- ✅ Spot checks: serviceability query returns only in-zone, in-radius branches; misspelled "biriyani" search finds biryanis.
- ⚠️ CI targets PostGIS 16 (as in Docker Compose); local verification used PostgreSQL 18. CI has not run yet (nothing pushed).
- ⚠️ Docker Compose and the Dockerfiles are still unverified (no Docker on this machine).

## Known discrepancies (awaiting owner decision — SRS not changed)

| #   | SRS text                                                                         | Implementation                                                                                               | Proposal                                                                                                                              |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | §15.6 lists `payment_attempts` as immutable                                      | Attempt status changes in place (CREATED → AUTHORIZED → CAPTURED/FAILED), as one provider payment progresses | Amend §15.6: provider IDs and amount immutable, status mutable (enforce with a guard trigger like webhook events)                     |
| D-2 | §15.3 / NFR-SCALE-004: `audit_logs` and `delivery_locations` partitioned monthly | Regular tables with time indexes; 90-day trail retention will use DELETE                                     | Defer partitioning until volume requires it or the retention jobs land (Phase 9/11), implemented as a dedicated migration             |
| D-3 | DB-CONV-005: money columns are `bigint`                                          | `Int` for bounded per-transaction amounts (≤ ₹2.1 crore), `BigInt` for balances and totals                   | Amend DB-CONV-005 to this split (avoids JS `bigint` handling on every order field; ADR-007 already says TS uses safe-integer numbers) |

Not discrepancies: ADV-only tables (chat, per-member permission overrides) are intentionally not created yet.

## Modules

| Module                                                                | Status                    |
| --------------------------------------------------------------------- | ------------------------- |
| Platform (HTTP, logging, config, health, Redis, socket gateway shell) | Implemented (Phase 2)     |
| Database schema, migrations, seed for all MVP + CORE domains          | Implemented (Phase 3)     |
| Domain modules (auth … realtime)                                      | Designed; not implemented |

## APIs

- Implemented: **API-SYS-001** `/health/live`, **API-SYS-002** `/health/ready`.
- Planned: 492 remaining (see `docs/requirements/API-SPECIFICATION.md`).

## UI pages

- Implemented: app shells for all four apps (home with platform status, 404, route error).
- Planned: customer 21, restaurant 24, delivery 19, admin 31 feature pages.

## Database migrations

| Migration                     | Purpose                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `20261120000000_extensions`   | postgis, pg_trgm, unaccent, citext, pgcrypto                               |
| `20261120000100_core_schema`  | All tables, enums, indexes, foreign keys (generated)                       |
| `20261120000200_constraints`  | Partial uniques, CHECKs, ledger/append-only/overlap/hours/search triggers  |
| `20261120000300_immutability` | Effective-dated configs, dispatch offers, webhook payloads, location trail |

## Known bugs

- None known.

## Technical decisions (Phase 3)

- Multi-file Prisma schema per domain; migrations generated with `--create-only` and reviewed; SQL-only rules documented and tested.
- Spatial/search indexes declared in the schema; partial/expression indexes live only in SQL (Prisma ignores them, so no drift).
- Optional relations use `ON DELETE RESTRICT` (DB-CONV-007) instead of Prisma's `SET NULL` default.
- Append-only tables allow UPDATE only for retention/anonymisation jobs via `SET LOCAL fos.allow_redaction = 'on'`.
- The permission catalog lives in `@fos/shared` so the seed and the Phase 4 IAM module share one source.
- RESTRICT/CHECK/trigger violations surface as `PrismaClientUnknownRequestError`; the API error mapper must handle them (SCHEMA-NOTES §5).

## Machine changes made during Phase 3 (with owner approval)

- Homebrew: installed `postgis` 3.7 and `postgresql@18` (keg-only, not started as a service, not linked over v17). Dependencies installed included LLVM, GDAL, `python@3.15` (unlinked) and `numpy` (unlinked); `simdjson` and `snappy` were upgraded.
- `fbthrift` was temporarily unlinked for the install and relinked afterwards; `python3` was relinked to 3.14.
- A project-local PostgreSQL 18 instance runs on port 5433 with data in `.local/postgres` (stop with `infrastructure/scripts/local-postgres.sh stop`). The existing PostgreSQL 17 on port 5432 was not touched.

## Blockers

- Owner decisions on D-1…D-3 (none block Phase 4).
- Legal/tax review items (SRS §20.4) — needed before launch.

## Next steps

1. Owner review of Phase 3 and decisions on D-1…D-3.
2. Phase 4 — authentication & security (registration, OTP, sessions, refresh rotation, RBAC, rate limiting, audit).

## TODO

- [ ] Decide D-1…D-3
- [ ] Run Docker Compose and the Dockerfiles on a Docker host (or via CI)
- [ ] Push to GitHub so CI runs
- [ ] Phase 4: auth & security
