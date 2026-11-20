# Project Status

_Last updated: 2026-11-20_

## Summary

| Item              | Status                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| Current phase     | **Phase 4 — Auth & security: complete; Phase 5 awaiting go-ahead**      |
| Next phase        | Phase 5 — Core customer backend                                         |
| SRS version       | FOS-SRS-001 v0.3.1 (APPROVED 2026-11-20; v0.3.1 is an editorial update) |
| Business features | Accounts, sign-in, sessions and permissions (all four apps)             |

## Phases

| Phase                         | Status                                                    |
| ----------------------------- | --------------------------------------------------------- |
| 1 Requirements & architecture | ✅ Approved 2026-11-20 (defaults adopted for OD-01…OD-16) |
| 2 Repository & infrastructure | ✅ Complete 2026-11-20                                    |
| 3 Database                    | ✅ Complete 2026-11-20 (SRS changes D-1…D-3 approved)     |
| 4 Auth & security             | ✅ Complete 2026-11-20 (D-4…D-6 await decision)           |
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

## Phase 4 deliverables

| Area              | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts          | Email + phone + password registration with consent; phone-OTP sign-in that creates customer accounts; phone and email verification; verification gate on all other features                                                                                                                                                                                                                                               |
| Credentials       | Argon2id passwords (m=19 MiB, t=2, p=1); policy checks (length, not email/phone, common-password list — see D-4); forgot/reset by email link or phone code; change password                                                                                                                                                                                                                                               |
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

Open — awaiting owner decision (SRS §27.3):

| ID  | Requirement                                                         | Observed                                                                                                                                                                                                                                                                                                                       | Proposal                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-4 | BR-AUTH-001 (breached-password check against a local top-100k list) | The API embeds an interim list of about 150 very common passwords plus pattern checks (sequences, repeats, app name). The 100k list needs a one-off download of a public list, which needs approval.                                                                                                                           | **Change code:** approve downloading a public top-100k list (e.g. the SecLists 100k file) into the repo as a data file, checked at startup. Alternative: approve the HIBP k-anonymity range API (optional in BR-AUTH-001) instead. |
| D-5 | SRS §19.2 error catalogue                                           | Two codes the API needs are not in the SRS: `AUTH_TERMS_REQUIRED` (422 — first OTP sign-in for a new number without consent, BR-AUTH-020) and `ACCOUNT_PENDING_DELETION` (403 — sign-in during the deletion grace period, carries the reactivation token).                                                                     | **Change requirement:** add both codes to §19.2 and to API-AUTH-003/004.                                                                                                                                                           |
| D-6 | API-AUTH-023 (reactivate: “Deactivated user session”)               | No session is issued to a deactivated account. Signing in returns `ACCOUNT_PENDING_DELETION` with a one-time reactivation token (15 min); `POST /auth/account/reactivate {token}` reactivates and signs in. This matches FR-AUTH-042 (“sign in successfully and confirm”) without giving a pending-deletion account a session. | **Change requirement:** update API-AUTH-023 to “one-time reactivation token from sign-in”.                                                                                                                                         |

Resolved: D-1…D-3 (owner decision 2026-11-20, SRS v0.3.0). Editorial only (v0.3.1): four error codes already used in §14 were added to the §19.2 table.

Not discrepancies: ADV-only tables (chat, per-member permission overrides) are intentionally not created yet; OAuth (FR-AUTH-004), account recovery (FR-AUTH-014) and TOTP (CORE) are later releases.

## Modules

| Module                                                                | Status                    |
| --------------------------------------------------------------------- | ------------------------- |
| Platform (HTTP, logging, config, health, Redis, socket gateway shell) | Implemented (Phase 2)     |
| Database schema, migrations, seed for all MVP + CORE domains          | Implemented (Phase 3)     |
| auth, iam, audit, notifications (dev sinks), users (`/me`)            | Implemented (Phase 4)     |
| Socket authentication and revocation                                  | Implemented (Phase 4)     |
| Other domain modules (customers … admin)                              | Designed; not implemented |

## APIs

- Implemented (24): **API-SYS-001/002** (health), **API-AUTH-001…016, 021…023** (auth), **API-USER-001** `GET /me`, **API-USER-003** `GET /me/permissions`.
- Planned: 470 remaining (see `docs/requirements/API-SPECIFICATION.md`).

## UI pages

- Implemented: app shells for all four apps (home with platform status, 404, route error); auth screens shared by all four apps: sign-in, sign-up (not admin), verify phone, verify email, forgot/reset password, sign-in and security (devices, change password).
- Planned: customer 21, restaurant 24, delivery 19, admin 31 feature pages.

## Database migrations

| Migration                               | Purpose                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `20261120000000_extensions`             | postgis, pg_trgm, unaccent, citext, pgcrypto                               |
| `20261120000100_core_schema`            | All tables, enums, indexes, foreign keys (generated)                       |
| `20261120000200_constraints`            | Partial uniques, CHECKs, ledger/append-only/overlap/hours/search triggers  |
| `20261120000300_immutability`           | Effective-dated configs, dispatch offers, webhook payloads, location trail |
| `20261120000400_payment_attempts_guard` | Payment attempt facts immutable, status may progress (SRS v0.3.0, D-1)     |
| `20261120151832_auth_enum_values`       | OTP purpose `MFA_LOGIN`, token purpose `REACTIVATE_ACCOUNT` (Phase 4)      |

## Known bugs

- None known.

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

## Machine changes made during Phase 4

- A project-local Redis (core on 6390, cache on 6391, data in `.local/redis`) started with `infrastructure/scripts/local-redis.sh`, using the Homebrew `redis-server` already installed. The existing Redis on 6379 was not touched. Nothing new was installed.

## Machine changes made during Phase 3 (with owner approval)

- Homebrew: installed `postgis` 3.7 and `postgresql@18` (keg-only, not started as a service, not linked over v17). Dependencies installed included LLVM, GDAL, `python@3.15` (unlinked) and `numpy` (unlinked); `simdjson` and `snappy` were upgraded.
- `fbthrift` was temporarily unlinked for the install and relinked afterwards; `python3` was relinked to 3.14.
- A project-local PostgreSQL 18 instance runs on port 5433 with data in `.local/postgres` (stop with `infrastructure/scripts/local-postgres.sh stop`). The existing PostgreSQL 17 on port 5432 was not touched.

## Blockers

- Legal/tax review items (SRS §20.4) — needed before launch.

## Next steps

1. Owner decisions on D-4, D-5 and D-6.
2. Owner go-ahead for Phase 5 (core customer backend: profiles, addresses, serviceability, restaurant discovery and menus).

## TODO

- [x] Decide D-1…D-3 (accepted 2026-11-20)
- [x] Phase 4: auth & security
- [ ] Decide D-4…D-6
- [ ] Run Docker Compose and the Dockerfiles on a Docker host (or via CI)
- [ ] Push to GitHub so CI runs (moves §22.1a–c rows to _Verified_)
- [ ] Dedicated test for idle/absolute session expiry (FR-AUTH-023)
