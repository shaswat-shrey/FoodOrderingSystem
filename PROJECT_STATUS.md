# Project Status

_Last updated: 2026-11-20_

## Summary

| Item              | Status                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Current phase     | **Phase 5 — Core customer backend: complete; Phase 6 awaiting go-ahead**                                                         |
| Next phase        | Phase 6 — Cart, pricing, checkout, payments                                                                                      |
| SRS version       | FOS-SRS-001 v0.5.0 (APPROVED 2026-11-20; v0.5.0 adds owner-approved D-7, D-8)                                                    |
| Business features | Accounts and sign-in (all apps); customer backend for locations, addresses, restaurants, menus, discovery, search and favourites |

## Phases

| Phase                         | Status                                                    |
| ----------------------------- | --------------------------------------------------------- |
| 1 Requirements & architecture | ✅ Approved 2026-11-20 (defaults adopted for OD-01…OD-16) |
| 2 Repository & infrastructure | ✅ Complete 2026-11-20                                    |
| 3 Database                    | ✅ Complete 2026-11-20 (SRS changes D-1…D-3 approved)     |
| 4 Auth & security             | ✅ Complete 2026-11-20 (D-4…D-6 approved)                 |
| 5 Core customer backend       | ✅ Complete 2026-11-20 (D-7, D-8 approved)                |
| 6 Cart, pricing, checkout     | Not started                                               |
| 7 Order management            | Not started                                               |
| 8 Restaurant application      | Not started                                               |
| 9 Delivery application        | Not started                                               |
| 10 Real-time                  | Not started                                               |
| 11 Admin                      | Not started                                               |
| 12 Frontend integration       | Not started                                               |
| 13 Testing & hardening        | Not started                                               |
| 14 Finalization               | Not started                                               |

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
- D-7 and D-8 resolved 2026-11-20 by owner decision (“Accept both”, SRS v0.5.0):
  - **D-7:** branches serve their own zone only in MVP; linked neighbouring zones are CORE (zone-links table and admin screen).
  - **D-8:** FR-ADDR-006 checks India's bounding box.
- Earlier: D-1…D-3 (v0.3.0) and D-4…D-6 (v0.4.0) resolved by owner decision; v0.3.1 and v0.4.1 were editorial.

Not discrepancies (planned later): offers in listings and the restaurant page (Phase 6); reviews and rating summary, bestsellers and popularity from real orders, trending dishes (Phase 7); avatar uploads and item/restaurant images (file storage, Phase 8); manual-close auto-reopen (Phase 8 branch operations); trending-search aggregation job, item schedules, data export, linked zones, OAuth, account recovery and TOTP (CORE).

## Modules

| Module                                                                | Status                    |
| --------------------------------------------------------------------- | ------------------------- |
| Platform (HTTP, logging, config, health, Redis, socket gateway shell) | Implemented (Phase 2)     |
| Database schema, migrations, seed for all MVP + CORE domains          | Implemented (Phase 3)     |
| auth, iam, audit, notifications (dev sinks), users (`/me`)            | Implemented (Phase 4)     |
| geo, catalog, customers, discovery, search, config                    | Implemented (Phase 5)     |
| Socket authentication and revocation                                  | Implemented (Phase 4)     |
| Other domain modules (cart … admin)                                   | Designed; not implemented |

## APIs

- Implemented (77 of 494): API-SYS-001/002; API-AUTH-001…016, 021…023; API-USER-001…003, 006…011, 013, 014; API-GEO-001…005; API-ADDR-001…006; API-REST-001…005; API-MENU-001…007; API-DISC-001…006, 008…011; API-SRCH-001…006; API-FAV-001…006.
- Planned: 417 remaining in `docs/requirements/API-SPECIFICATION.md` (Phase 5 left for later: API-USER-004/005 avatar, API-USER-012 export, API-REST-006 offers, API-REST-007/008 and API-MENU-008 reviews, API-DISC-007 offers).

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

## Known bugs

- None known.

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

1. Owner go-ahead for Phase 6 (cart, pricing engine, coupons, checkout, idempotency, payments with the mock provider, wallet and ledger core).

## TODO

- [x] Decide D-1…D-6
- [x] Phase 4: auth & security
- [x] Phase 5: core customer backend
- [x] Decide D-7, D-8 (accepted 2026-11-20)
- [ ] Run Docker Compose and the Dockerfiles on a Docker host (or via CI)
- [ ] Push to GitHub so CI runs (moves §22.1a–d rows to _Verified_)
- [ ] Dedicated test for idle/absolute session expiry (FR-AUTH-023)
- [ ] Phase 7–8 writers must bump `branches.menu_version` on menu, availability and stock changes (SCHEMA-NOTES §6a)
