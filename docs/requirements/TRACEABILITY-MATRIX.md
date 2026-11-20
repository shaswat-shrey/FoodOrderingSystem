# SRS Section 22 — Requirement Traceability Matrix

> Part of FOS-SRS-001 v0.10.1 (APPROVED 2026-11-20). Rows in §22.1 and §22.2 are `Planned`; requirements delivered so far are listed in §22.1a (platform), §22.1b (database), §22.1c (authentication), §22.1d (customer backend), §22.1e (cart, pricing, checkout, payments), §22.1f (orders, support, notifications), §22.1g (restaurant application), §22.1h (delivery application, tracking, reviews), §22.1i (real-time) and §22.1j (administration).
>
> **Granularity.** In Phase 1 the matrix traces *requirement groups* (contiguous ID ranges that share module, APIs, entities and pages) so that every one of the 408 FR IDs is covered without 400 near-identical rows. When implementation of a group starts, its row is split into one row per requirement, and the `Code` and `Tests` columns are filled with file paths and test names (rule §27.2: no `Implemented` without code reference, no `Verified` without test reference).
>
> Test case IDs (`TC-*`) are reserved here and become test names (`describe('TC-AUTH-001 …')`) so CI reports map back to requirements.

## 22.1 Functional requirements

| Requirement IDs | Requirement (summary) | Module(s) | API(s) | Database entities | Frontend page(s) | Test cases | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| FR-AUTH-001…003 | Registration & login (password, OTP) | auth, users | API-AUTH-001…004 | users, user_credentials, otp_codes, login_attempts, user_consents | All apps: Login, Register, OTP | TC-AUTH-001…012 | AC-AUTH-001…004 | Planned |
| FR-AUTH-004 | OAuth sign-in | auth | API-AUTH-017, 018 | oauth_accounts | Customer: Login | TC-AUTH-013…015 | — | Planned |
| FR-AUTH-005…007 | Logout, logout-all, session list/revoke | auth, realtime | API-AUTH-006…009 | user_sessions, refresh_tokens, push_subscriptions | Settings → Devices | TC-AUTH-016…022 | AC-AUTH-008…010 | Planned |
| FR-AUTH-008…013 | Email/phone verification, OTP, password flows | auth, notifications | API-AUTH-002, 010…015 | otp_codes, verification_tokens | Verify, Forgot/Reset password, Settings | TC-AUTH-023…040 | AC-AUTH-011, 012 | Planned |
| FR-AUTH-014 | Account recovery | auth, support | API-AUTH-024, API-ADM-018 | support_tickets, audit_logs | Support, Admin users | TC-AUTH-041 | — | Planned |
| FR-AUTH-020…024 | Session creation, token validation, rotation, expiry, permission propagation | auth, iam | API-AUTH-005, API-USER-003 | user_sessions, refresh_tokens, users(token/permission version) | API client (all apps) | TC-AUTH-050…070 | AC-AUTH-005…008, 015; AC-RBAC-006 | Planned |
| FR-AUTH-030…032 | Brute-force protection, step-up, admin MFA | auth | API-AUTH-016, 019…021 | login_attempts, mfa_factors, mfa_recovery_codes | Admin login | TC-AUTH-071…085 | AC-AUTH-004 | Planned |
| FR-AUTH-040…042 | Suspension, deletion, reactivation | auth, users, admin | API-AUTH-022, 023, API-ADM-012, 013 | users, audit_logs | Settings → Delete account; Admin users | TC-AUTH-086…095 | AC-AUTH-013, 014 | Planned |
| FR-NOTIF-001…010 | Notification dispatch, inbox, templates, preferences, push | notifications | API-NTF-001…010, API-ADM-200, 201 | notifications, notification_deliveries, notification_templates, notification_preferences, push_subscriptions | Notifications pages (all apps) | TC-NOTIF-001…030 | — | Planned |
| FR-FILE-001…007 | Uploads, validation, private docs, cleanup | files | API-FILE-001…003, API-ADM-040 | files | Upload components | TC-FILE-001…015 | AC-NFR-003 | Planned |
| FR-AUDIT-001…003 | Audit capture, immutability, query | audit | API-ADM-187, 188 | audit_logs | Admin: Audit logs | TC-AUDIT-001…008 | AC-ADMIN-001 | Planned |
| FR-CFG-001…004 | Typed settings, effective-dated config, flags | config | API-ADM-130…149 | platform_settings, fee_schedules, tax_rules, feature_flags | Admin: Platform configuration | TC-CFG-001…012 | AC-ADMIN-004 | Planned |
| FR-CUST-001…008 | Customer profile & preferences | users, customers | API-USER-001…014 | users, customer_profiles, customer_allergens, customer_dietary_preferences | Profile, Settings | TC-CUST-001…015 | — | Planned |
| FR-LOC-001…006 | Location detection, geocoding, serviceability | geo | API-GEO-001…005 | zones, geocode_cache | Location selection | TC-GEO-001…015 | AC-DISC-001 | Planned |
| FR-ADDR-001…006 | Address management | addresses, geo | API-ADDR-001…006 | customer_addresses | Address management | TC-ADDR-001…012 | — | Planned |
| FR-DISC-001…013 | Discovery listing, filters, sort, collections, ranking | discovery, geo, restaurants | API-DISC-001…011, API-REST-005 | branches, zones, restaurants, collections, banners, analytics_* | Home, Discovery | TC-DISC-001…035 | AC-DISC-002…006 | Planned |
| FR-SRCH-001…008 | Search, autocomplete, history, trending | search | API-SRCH-001…006 | food_items.search_vector, restaurants, search_history, search_query_stats | Search | TC-SRCH-001…020 | AC-DISC-007 | Planned |
| FR-MENUC-001…010 | Restaurant page & menu display | restaurants, menu, reviews | API-REST-001…008, API-MENU-001…008 | branches, menu_categories, food_items, variants, customization_*, branch_item_availability | Restaurant details, Menu, Item sheet | TC-MENUC-001…025 | AC-MENU-001, 003 | Planned |
| FR-CART-001…013 | Cart lifecycle & validation | cart, menu, pricing | API-CART-001…012 | carts, cart_items, cart_item_options | Cart, Item sheet | TC-CART-001…035 | AC-CART-001…004 | Planned |
| FR-PRICE-001…005 | Pricing engine | pricing, config | API-CART-011, API-CHK-001/003 | fee_schedules, delivery_fee_slabs, tax_rules, order_price_components | Cart, Checkout | TC-PRICE-001…060 | AC-PRICE-001…003 | Planned |
| FR-COUP-001…005 | Coupons | coupons | API-COUP-001…003, API-CART-009/010 | coupons, coupon_redemptions, coupon_* targets | Cart → Coupons | TC-COUP-001…030 | AC-PRICE-004, 005 | Planned |
| FR-CHK-001…008 | Checkout sessions & order confirmation | checkout, orders, payments | API-CHK-001…004, API-PAY-001 | checkout_sessions, orders | Checkout, Confirmation | TC-CHK-001…030 | AC-ORDER-001…004 | Planned |
| FR-CPAY-001…005 | Customer payment UX, history, wallet | payments, wallet | API-PAY-002…006, API-REF-001/002, API-WAL-001/002 | payments, refunds, ledger_* | Payment, Wallet, Payment history | TC-CPAY-001…015 | AC-PAY-001 | Planned |
| FR-CORD-001…012 | Order history, details, tracking, cancel, reorder, invoice, issues | orders, tracking, support | API-ORD-001…013, API-TRK-001/002 | orders, order_*, order_issues, invoices, deliveries | Order history, Order details, Tracking | TC-CORD-001…040 | AC-ORDER-007, 008; AC-DEL-007 | Planned |
| FR-REV-001…007 | Reviews & ratings | reviews | API-REV-001…005, API-REST-007/008 | reviews, review_*, branches (aggregates) | Reviews, Order details | TC-REV-001…020 | — | Planned |
| FR-FAV-001…003 | Favorites | favorites | API-FAV-001…006 | favorite_restaurants, favorite_items | Favorites | TC-FAV-001…006 | — | Planned |
| FR-CSUP-001…006 | Customer support | support | API-SUP-001…009 | support_tickets, support_ticket_messages, faqs | Support | TC-SUP-001…015 | — | Planned |
| FR-REST-001…006 | Restaurant onboarding & verification | restaurants, files | API-MER-001…007, API-ADM-020…025 | restaurants, restaurant_documents, restaurant_bank_accounts, restaurant_application_reviews | Restaurant onboarding, Verification; Admin approvals | TC-REST-001…030 | AC-REST-001 | Planned |
| FR-REST-010…020 | Restaurant & branch management | restaurants | API-MER-008…027, API-ADM-033…036 | branches, branch_operating_hours, branch_holidays, branch_status_events, restaurant_change_requests | Settings, Operating hours, Branches | TC-REST-031…060 | AC-REST-004 | Planned |
| FR-MENU-001…015 | Menu management | menu | API-RMENU-001…035, API-ADM-039 | menu_*, food_*, customization_*, branch_*_availability, branch_item_stock, combo_components | Menu, Food items, Categories, Customizations, Inventory | TC-MENU-001…045 | AC-MENU-001…004 | Planned |
| FR-RPROMO-001…003 | Restaurant promotions | promotions | API-RPROMO-001…005, API-ADM-109 | promotions, promotion_* | Offers / Promotions | TC-PROMO-001…012 | — | Planned |
| FR-RORD-001…015 | Restaurant order handling & KDS | orders, realtime | API-RORD-001…014 | orders, order_status_history | Orders, Order details, Kitchen display, Order queue | TC-RORD-001…040 | AC-REST-002, 003 | Planned |
| FR-RSTAFF-001…006 | Restaurant staff | restaurant-members, iam | API-RSTAFF-001…011 | restaurant_members, restaurant_member_branches, restaurant_invitations | Staff management | TC-RSTAFF-001…020 | AC-RBAC-003, 006 | Planned |
| FR-RANL-001…006, FR-RFIN-001…004, FR-RREV-001…003, FR-RNOT-001 | Restaurant analytics, finance, reviews, notifications | analytics, payouts, reviews, notifications | API-RANL-*, API-RFIN-*, API-RREV-* | analytics_*, restaurant_settlements, payouts, reviews | Dashboard, Analytics, Payments, Payouts, Reviews | TC-RANL-001…030 | AC-REST-005 | Planned |
| FR-DP-001…007 | Partner onboarding & profile | delivery-partners, files | API-DP-001…013, API-ADM-041…045, 054 | delivery_partners, partner_documents, partner_vehicles, partner_bank_accounts | Registration, Verification, Documents, Profile | TC-DP-001…025 | — | Planned |
| FR-DP-010…015 | Partner availability | delivery-partners, tracking | API-DP-014…019 | delivery_partners, partner_online_sessions (+ Redis state) | Dashboard, Online toggle | TC-DP-026…045 | AC-DEL-001 | Planned |
| FR-DEL-001…037 | Offers & delivery workflow | dispatch, deliveries, orders | API-DPDEL-001…013, API-DP-021 | deliveries, delivery_assignments, delivery_status_history, delivery_otp_attempts | Delivery requests, Active delivery, Pickup, Drop-off, History | TC-DEL-001…060 | AC-DEL-002…006 | Planned |
| FR-TRK-001…008 | Location tracking | tracking, realtime | Socket EVT-C-004, API-DP-020, API-TRK-001/002 | delivery_locations, delivery_partners.last_location (+ Redis GEO) | Active delivery; Customer tracking | TC-TRK-001…025 | AC-DEL-007 | Planned |
| FR-EARN-001…008 | Earnings, incentives, cash, payouts | earnings, payouts, wallet | API-EARN-001…012 | partner_earnings, partner_pay_plans, incentive_*, ledger_*, payouts | Earnings, Incentives, Wallet, Payouts, Ratings | TC-EARN-001…030 | AC-DEL-008 | Planned |
| FR-ADMIN-001…003 | Admin login, dashboard, live map | admin, analytics | API-ADM-001…004 | (aggregates) | Admin login, Dashboard | TC-ADM-001…010 | — | Planned |
| FR-ADMIN-010 | Customer management | admin, users | API-ADM-010…019 | users, customer_profiles | Customers | TC-ADM-011…025 | AC-ADMIN-005 | Planned |
| FR-ADMIN-020…023 | Restaurant administration | admin, restaurants | API-ADM-020…040 | restaurants, branches, change requests | Restaurants, Restaurant approvals, Restaurant details | TC-ADM-026…045 | AC-REST-001 | Planned |
| FR-ADMIN-030, 031 | Partner administration | admin, delivery-partners | API-ADM-041…054 | delivery_partners, partner_* | Delivery partners, Partner approvals | TC-ADM-046…060 | — | Planned |
| FR-ADMIN-040…042 | Order management, interventions, disputes | admin, orders, dispatch | API-ADM-060…075, 161, 162 | orders, deliveries, disputes, audit_logs | Orders, Order details, Dispatch board | TC-ADM-061…085 | AC-ADMIN-002 | Planned |
| FR-ADMIN-050…052 | Payments, refunds, reconciliation | admin, payments, refunds | API-ADM-080…090 | payments, payment_webhook_events, refunds, reconciliation_* | Payments, Refunds | TC-ADM-086…100 | AC-ADMIN-003 | Planned |
| FR-ADMIN-060, 061 | Coupons, promotions, banners | admin, coupons, promotions | API-ADM-100…117 | coupons, promotions, banners, collections | Coupons, Promotions | TC-ADM-101…115 | — | Planned |
| FR-ADMIN-070…073 | Zones, fees, taxes, commission, pay config | admin, geo, config | API-ADM-120…143 | zones, fee_schedules, tax_rules, commission_plans, partner_pay_plans | Platform configuration, Zones | TC-ADM-116…135 | AC-ADMIN-004 | Planned |
| FR-ADMIN-080…082 | Support desk, complaints, moderation | support, reviews | API-ADM-150…165 | support_*, complaints, review_reports | Support, Complaints | TC-ADM-136…155 | — | Planned |
| FR-ADMIN-090, 091 | Analytics & reports | analytics, reports | API-ADM-170…176 | analytics_*, report_exports | Analytics, Reports | TC-ADM-156…165 | — | Planned |
| FR-ADMIN-100…123 | Settings, flags, IAM, admin accounts, audit, payouts, content, broadcasts | admin, config, iam, payouts | API-ADM-130…149, 180…203, 091…097 | platform_settings, feature_flags, roles, permissions, user_roles, payout_batches, faqs, legal_documents | Platform configuration, User roles, Permissions, Audit logs | TC-ADM-166…200 | AC-ADMIN-001 | Planned |
| FR-FE-001…010 | Frontend cross-cutting | (frontend packages) | API-USER-003, API-AUTH-005 | — | All apps | TC-FE-001…030 | AC-RT-004, AC-NFR-002 | Planned |
| FR-ORDER-001…003, 020…023, 030…032 | Order creation, dedupe, cancellation, changes | orders, checkout, coupons, payments | API-CHK-004, API-ORD-006/007/010, API-ADM-068 | orders, order_*, coupon_redemptions, idempotency_keys | Checkout, Tracking | TC-ORD-001…050 | AC-ORDER-002…010 | Planned |
| FR-PAY-001…016 | Payments | payments, wallet | API-PAY-001…007 | payments, payment_attempts, payment_webhook_events, ledger_* | Payment | TC-PAY-001…050 | AC-PAY-001…005 | Planned |
| FR-REFUND-001…009 | Refunds | refunds, wallet | API-ADM-084…087, API-REF-* | refunds, refund_items, ledger_* | Admin refunds; customer order details | TC-REF-001…030 | AC-PAY-006, 008 | Planned |
| FR-RECON-001…004 | Reconciliation & ledger integrity | payments, wallet | API-ADM-088…090 | reconciliation_*, ledger_* | Admin reconciliation | TC-RECON-001…012 | AC-PAY-007 | Planned |
| FR-SETTLE-001…004 | Settlement & payouts | payouts, wallet | API-ADM-091…097, API-RFIN-*, API-EARN-007/008 | restaurant_settlements, payout_batches, payouts, ledger_* | Payouts (restaurant/partner/admin) | TC-SETTLE-001…020 | — | Planned |
| FR-DISP-001…016 | Dispatch engine | dispatch | API-DPDEL-002/003, API-ADM-070…075 | deliveries, delivery_assignments, partner_stats (+ Redis) | Delivery requests; Admin dispatch board | TC-DISP-001…060 | AC-DEL-002…005, 009 | Planned |
| FR-DELV-001…003 | Delivery verification & proof | deliveries | API-DPDEL-009 | deliveries, delivery_otp_attempts, files | Drop-off | TC-DELV-001…012 | AC-DEL-006 | Planned |
| FR-RT-001…028 | Real-time gateway | realtime | Socket namespaces, EVT-* | outbox_events | All apps (socket client) | TC-RT-001…040 | AC-RT-001…004 | Planned |

## 22.1a Platform requirements implemented in Phase 2

These rows are at single-requirement granularity because code and tests exist. "Verified" = automated tests pass locally; container-level verification is pending a Docker host (PROJECT_STATUS.md).

| Requirement | Summary | Code | Tests | Status |
|---|---|---|---|---|
| API-SYS-001 | Liveness probe | `apps/api/src/platform/health/health.routes.ts`, `apps/worker/src/health-server.ts` | `apps/api/src/platform/http/app.test.ts`, `apps/worker/src/worker.test.ts` | Verified |
| API-SYS-002 | Readiness probe (DB critical, Redis degradable) | `apps/api/src/platform/health/readiness.ts` | `app.test.ts`, `readiness.test.ts`, `worker.test.ts` | Verified |
| NFR-AVAIL-004 / 005 / 006 | Degraded vs unavailable readiness semantics | `readiness.ts`, `apps/api/src/server.ts` | `app.test.ts` | Verified |
| NFR-REL-007 | Graceful shutdown (API, worker) | `apps/api/src/server.ts`, `apps/worker/src/main.ts`, `closeRedis` | `apps/api/src/platform/redis.test.ts` + manual SIGTERM smoke | Verified |
| NFR-SEC-004 | Strict JSON bodies, 100 KB limit, 415 for non-JSON | `apps/api/src/platform/http/app.ts`, `require-json.ts` | `app.test.ts` | Verified |
| NFR-SEC-005 | Ban `$queryRawUnsafe` / `$executeRawUnsafe` | `eslint.config.js` | Lint rule exercised manually (Phase 2) | Implemented |
| NFR-SEC-008 / 009 | Helmet headers, CORS allowlist | `app.ts` | `app.test.ts` | Verified |
| NFR-SEC-011 | Env validated at boot, no secret echo | `apps/api/src/config/env.ts`, `apps/worker/src/env.ts` | `env.test.ts`, `worker.test.ts` | Verified |
| NFR-SEC-013 / ERR-004 | No internals in error responses | `error-handler.ts` | `app.test.ts` | Verified |
| NFR-SEC-014 | Log redaction of secrets | `apps/api/src/platform/logger.ts` | `logger.test.ts` | Verified |
| NFR-SEC-020 (partial) | Socket gateway deny-by-default until auth | `socket-server.ts` | `socket-server.test.ts` | Verified (auth itself: Phase 4) |
| NFR-OBS-001 / 002 | Structured logs, request IDs | `logger.ts`, `request-id.ts`, `request-logger.ts` | `app.test.ts` | Verified |
| NFR-MAINT-001 | Module boundaries enforced by lint | `eslint.config.js` | Lint rule exercised manually (Phase 2) | Implemented |
| ERR-001 / 002 | Standard error envelope, single error boundary | `envelope.ts`, `errors.ts`, `error-handler.ts` | `app.test.ts` | Verified |
| BR-PRICE-002 (helper) | Integer-paise, half-up basis-point rounding | `packages/shared/src/money.ts` | `money.test.ts` | Verified (pricing engine: Phase 6) |
| UI-DS-005 / NFR-ACCESS-004 | Dietary marker by shape + label | `packages/ui/src/components/DietaryMarker.tsx` | `components.test.tsx`, E2E | Verified |
| NFR-ACCESS-002 / 007 (partial) | Skip link, focus styles, axe scan | app shells, `packages/ui/src/styles.css` | `tests/e2e/specs/customer-shell.spec.ts` | Verified (customer shell) |
| FR-FE-005 (partial) | Loading / error / empty states with retry | app shells, `@fos/ui` | app `HomePage.test.tsx` | Verified (shells) |

## 22.1b Database requirements implemented in Phase 3

Code: `packages/db/prisma/schema/**`; tests: `packages/db/test/constraints.test.ts`. Rule-by-rule mapping: `docs/database/SCHEMA-NOTES.md` §4.

| Requirement | Summary | Status |
|---|---|---|
| DB-TECH-001…005 | PostgreSQL + extensions, Prisma with SQL extensions, no binaries in DB | Verified |
| DB-CONV-001…004, 006, 008, 010, 011 | Naming, UUIDv7 keys, timestamps/versions, soft delete, enums, JSONB limits, timestamptz, history tables | Implemented |
| DB-CONV-005 | Money as integer minor units (Int per-transaction, BigInt totals — v0.3.0) | Implemented |
| DB-CONV-007 | RESTRICT by default | Verified |
| DB-CONV-009 | No array relationships | Implemented (one exception: `audit_logs.actor_roles` text[] snapshot of role keys) |
| DB-INT-003 | Business uniqueness in the database | Verified |
| DB-INT-004 | Balanced ledger, non-negative wallets | Verified |
| DB-INT-005 | Snapshots render after menu changes | Implemented (verified with order flows in Phase 7) |
| DB-INT-006 | Outbox table | Implemented (relay in Phase 7) |
| §15.6 immutable snapshots (incl. `payment_attempts` rule, v0.3.0) | Append-only and guard triggers | Verified |
| DB-SCALE-001 | Partitioning deferred until volume/retention thresholds | Planned (by design, v0.3.0) |
| BR-AUTH-014, BR-ADDR-001, BR-CART-001, BR-MENU-002…005, BR-COUPON-003/004, BR-DEL-014, BR-REVIEW-002, BR-REST-003, BR-ADMIN-001 | Rules with database backstops | Verified (database layer; service-level enforcement comes with each module) |
| FR-DISP-006/007, FR-DISP-013, FR-PAY-004, FR-PAY-008, FR-REFUND-003, FR-CFG-002, FR-AUDIT-002, FR-ADMIN-070 | Database backstops for these requirements | Verified (database layer) |

## 22.1c Authentication & security implemented in Phase 4

Code: `apps/api/src/modules/{auth,iam,audit,notifications,users}`, `apps/api/src/platform/{rate-limit,crypto}.ts`, `apps/worker/src/processors.ts`, `packages/api-client/src/{client,auth-api,auth-store}.ts`, `packages/auth-web/**`, `packages/validation/src/auth.ts`. Tests: `apps/api/test/auth.integration.test.ts` (API), `apps/api/test/realtime.integration.test.ts` and `apps/api/src/platform/realtime/socket-server.test.ts` (sockets), `apps/api/src/modules/auth/auth-units.test.ts`, `packages/api-client/src/auth.test.ts`, `packages/auth-web/src/auth-web.test.tsx`, `tests/e2e/specs/auth.fullstack.spec.ts` (opt-in, real API + worker).

Status is **Implemented** with tests passing locally; rows move to *Verified* once CI has run them (§27.2).

| Requirement | Summary | Status / note |
|---|---|---|
| FR-AUTH-001, BR-AUTH-020 | Email + phone + password registration with consent; phone verification gate (`AUTH_VERIFICATION_REQUIRED`) | Implemented |
| FR-AUTH-002 | Phone + OTP sign-in; first-time numbers create a customer account | Implemented (UI collects name and consent, then sends a fresh code) |
| FR-AUTH-003 | Password sign-in by email or 10-digit phone | Implemented |
| FR-AUTH-005, 006, 007 | Logout, logout-all, list and revoke device sessions | Implemented |
| FR-AUTH-008, 009, 010 | Email link verification, phone verification, OTP issue/verify (HMAC-stored, cooldown, attempts) | Implemented |
| FR-AUTH-011, 012, 013 | Forgot / reset (link or phone code) / change password | Implemented |
| FR-AUTH-020, 021, 022 | Session + token issuance, access-token validation (audience, `tv`/`pv`, live session), refresh rotation with race grace and reuse detection | Implemented |
| FR-AUTH-023 | Idle and absolute session expiry per app | Implemented (no dedicated test yet) |
| FR-AUTH-024 | Role/permission changes apply on the next request | Implemented |
| FR-AUTH-030, BR-AUTH-004 | Lockout (5 failures → 15 min, doubling, 24 h cap) and per-IP/per-identifier throttling | Implemented |
| FR-AUTH-031, BR-AUTH-017 | Step-up re-authentication (5 min) | Implemented (used by account deletion) |
| FR-AUTH-032, BR-AUTH-018 | Admin second factor: emailed code (TOTP is CORE) | Implemented (interim email code) |
| FR-AUTH-040, BR-AUTH-012 | Suspended accounts cannot sign in | Implemented (admin suspend action: Phase 11) |
| FR-AUTH-041, 042, BR-AUTH-011, 013 | Account deletion with 30-day grace, blockers, reactivation, anonymisation job | Implemented |
| FR-AUTH-004, FR-AUTH-014 | OAuth sign-in, account recovery | Planned (CORE) |
| BR-AUTH-001 | Password policy, Argon2id, breached-password check against the NCSC 100k list (D-4, approved) | Implemented |
| BR-AUTH-003, 005, 006, 007, 008, 009, 010, 014, 015, 016, 019 | OTP policy, session cap, token lifetimes, refresh grace, link lifetimes, revocation on credential change, app–role compatibility, uniqueness, generic conflicts, cookie endpoints require trusted Origin | Implemented |
| BR-AUTH-002 | Verified phone before checkout | Partial (verification gate in place; checkout arrives in Phase 6) |
| FR-AUDIT-001 | Security events written to the audit log with redaction | Implemented |
| FR-RT-001…005, 007 | Socket handshake auth per app namespace, token refresh on the socket, revocation disconnects, personal/session rooms, connect rate limit | Implemented |
| FR-FE-001, 002, 003 | Route guards, in-memory access token with silent restore, single-flight refresh across tabs | Implemented |
| NFR-SEC-002, 004, 007, 009, 010, 011, 013, 014, 018, 020 | Authentication model, strict input schemas, CSRF origin check on cookie endpoints, CORS allowlist with credentials, rate limits, validated secrets, explicit response shapes, log redaction, audit logging, socket handshake security | Implemented (CAPTCHA adapter in NFR-SEC-010: Planned) |
| NFR-ACCESS-001, 003 | Contrast ≥ 4.5:1 on auth screens; labelled fields with announced errors | Implemented (axe checks on sign-in and sign-up) |

## 22.1d Core customer backend implemented in Phase 5

Code: `apps/api/src/modules/{geo,catalog,customers,discovery,search,config}`, `apps/api/src/platform/pagination.ts`, `packages/validation/src/{geo,customers,catalog,discovery}.ts`, `packages/api-client/src/customer-api.ts`. Tests: `apps/api/test/{catalog,profile,addresses,menu,discovery,search}.integration.test.ts`; unit tests in `apps/api/src/modules/{catalog,discovery,search}/*.test.ts`.

Status is **Implemented** with tests passing locally; rows move to *Verified* once CI has run them (§27.2).

| Requirement | Summary | Status / note |
|---|---|---|
| FR-LOC-002, 003, 006; IF-GEO-001, 002, 006 | Geocoding adapter (mock gazetteer for development, `none` for degraded production), 30-day cache, routing estimate, serviceability with reason codes | Implemented |
| FR-LOC-001, 004, 005 | Browser geolocation, map pin, session location | Planned (customer screens, Phase 12); the API treats the pin as authoritative |
| BR-GEO-001 (a)–(c), (e); BR-GEO-002, 003 | Active zone, same zone, radius capped by zone, accepting orders; road distance estimate for fees | Implemented — (b) is same-zone only in MVP (D-7, approved); (d) routing check applies at checkout (Phase 6) |
| BR-REST-001, 003, 004, 010, 011 | Accepting-orders computation (hours across midnight, holidays, pause, manual close, FSSAI expiry, zone status), last-order cutoff, FSSAI on page | Implemented |
| FR-CUST-001, 002, 003, 004, 006, 007 | Profile, preferences, email and phone change, account status | Implemented |
| FR-CUST-005, 008 | Avatar upload, data export | Planned (file uploads with Phase 8; export is CORE) |
| BR-AUTH-020 (API-USER-013/014) | Current legal documents and acceptance | Implemented |
| FR-ADDR-001…006, BR-ADDR-001, 002 | Address book with limits, labels, default, soft delete, India and PIN checks, pin-distance warning, per-branch serviceability | Implemented (India bounding box per D-8, approved) |
| FR-MENUC-001…006, 008 | Branch page, menu with smart sections, item cards and details, availability, filters, cache by menu version with ETag | Implemented — bestsellers by 30-day orders and item schedules join when order data exists (Phase 7) / CORE |
| FR-MENUC-007 | Allergen warnings for signed-in customers | Implemented |
| FR-MENUC-009, API-REST-007/008, API-MENU-008 | Reviews and rating summary | Planned (Phase 7) |
| FR-MENUC-010 | Branches of a brand with serviceability | Implemented |
| FR-DISC-001…005, 007…012 | Listing, filters, sorting, cursor pagination, collections, banners, cuisine browse, veg-only, delivery info, ETA, recommended ranking, order again | Implemented — offers-based filters and sections return nothing until promotions exist (Phase 6) |
| FR-DISC-013, API-DISC-007, API-REST-006 | Offers by restaurant / restaurants by offer | Planned (Phase 6) |
| FR-SRCH-001…005, 007, 008 | Full-text + trigram search, ranking, typo tolerance, suggestions, history, dish results, filters | Implemented |
| FR-SRCH-006 | Trending searches | Partial — read endpoint implemented; the hourly aggregation job (JOB-SRCH-001) and profanity filter are CORE |
| FR-FAV-001…003 | Favourite restaurants and dishes with serviceability | Implemented |
| FR-CFG-001, 004 | Typed settings with defaults, 5-second cache | Implemented (settings editing arrives with the admin app, Phase 11) |
| NFR-PERF-003 | Listing p95 ≤ 500 ms | Not yet measured (k6 in Phase 13); local requests take about 5–20 ms on seed data |

## 22.1e Cart, pricing, checkout and payments implemented in Phase 6

Code: `apps/api/src/modules/{pricing,checkout,offers,ledger,payments}`, `apps/api/src/platform/{outbox,ops-alerts,jobs}.ts`, `apps/api/src/platform/http/middleware/idempotency.ts`, `apps/worker/src/processors.ts`. Tests: `apps/api/src/modules/{pricing,payments}/*.test.ts` (including a seeded property test of pricing invariants), `apps/api/test/{cart,offers,ledger,checkout,payments}.integration.test.ts`, `apps/worker/src/worker.test.ts`.

Status is **Implemented** with tests passing locally; rows move to *Verified* once CI has run them (§27.2). Order creation (API-CHK-004, FR-ORDER-001) and the order transitions that consume payment events are Phase 7.

| Requirement | Summary | Status / note |
|---|---|---|
| FR-PRICE-001…004, BR-PRICE-001…012 | Pure pricing engine: lines, item discounts, best promotion, coupon, packaging caps, slab delivery fee and free-delivery waiver, surge cap, small-order and platform fees, per-component taxes, tip, wallet; funding split; min/max order | Implemented |
| FR-PRICE-005 | Price-change re-confirmation at order confirmation | Implemented in Phase 7 (§22.1f) |
| FR-CFG-002 | Effective-dated fee, tax and commission configuration | Implemented (reads; editing in Phase 11) |
| FR-CART-001…013, BR-CART-001…006 | Cart with full line validation, merging, branch conflicts, limits, revalidation flags, preview, guest merge, instructions, 7-day expiry job | Implemented (`cart_items.unit_amount_seen`, D-9 approved) |
| FR-COUP-001…003, 005; BR-COUPON-001…005, 007, 008 | Coupon listing with reasons, terms, validation, application, promotions vs coupons, new-user rule, expiry re-check | Implemented (device-fingerprint heuristics in BR-COUPON-007 are CORE) |
| FR-COUP-004, BR-COUPON-006 | Reservation under a row lock, redeem, release | Implemented (called from order flows in Phase 7) |
| FR-CHK-001, 003, 005…007, BR-ORDER-001, BR-PAY-002, BR-PAY-007, BR-DEL-009 (contactless prepaid) | Checkout sessions with quote, address snapshot, config versions, cart hash, TTL, re-quote, COD eligibility, wallet rules | Implemented |
| FR-CHK-004 | ETA at checkout | Implemented without the dispatch load factor (Phase 9) |
| FR-CHK-002, FR-ORDER-001, API-CHK-004, API-PAY-005 | Confirm checkout / create order / abandon payment | Implemented in Phase 7 (§22.1f) |
| FR-ORDER-002 (a) | Idempotency-Key storage and replay (24 h), concurrent duplicates | Implemented (applied to payment endpoints now; order confirmation in Phase 7) |
| FR-PAY-001…005, 007…009, 014, 015; BR-PAY-003…006 | Provider adapter (mock + Razorpay), initiation with reuse and attempt limit, signature + provider verification, raw-body webhooks with dedupe and async processing, amount integrity, status precedence, secret rotation, masked instruments | Implemented |
| FR-PAY-006, 016 | Payment expiry and cancellation | Implemented in Phase 7 (§22.1f) |
| FR-PAY-010 | Capture of payments stuck in AUTHORIZED | Partial — the hourly poll resolves them from the provider; an explicit capture call is not made (Razorpay auto-capture is required on the account) |
| FR-PAY-011 | COD payment records | Implemented in Phase 7 (records); collection in Phase 9 |
| FR-PAY-012, BR-WALLET-001, 003 | Wallet hold, debit (earliest-expiring credits first), release; never negative | Implemented |
| BR-WALLET-002 | Credit expiry | Partial — lots carry expiry dates; the expiry job arrives with promotional credits (Phase 11) |
| FR-PAY-013, FR-RECON-003 | Double-entry ledger, idempotent postings, nightly integrity check | Implemented |
| FR-RECON-004 | Stuck payment resolution | Implemented (hourly) |
| FR-RECON-001, 002 | Daily reconciliation against provider reports | Planned (Phase 11) |
| FR-REFUND-001, 003, 005, 006, 009 | Refund records, bound by captured amount under lock, provider submission with backoff and ops hand-off, webhook and poll confirmation, ledger by cost bearer | Implemented (skeleton used by Phase 7) |
| FR-REFUND-002, 004, 007, 008 | Automatic refunds per cancellation matrix, split-payment allocation, COD refunds, approval limits | 002/004 implemented in Phase 7 (§22.1f); 007/008 Phase 11 |
| FR-CPAY-004, 005 | Payment, refund and wallet history | Implemented (API) |

## 22.1f Orders, cancellations, support and notifications implemented in Phase 7

Code: `apps/api/src/modules/{orders,support,notifications}`, `apps/api/src/platform/{outbox-relay,pdf}.ts`, `apps/worker/src/{main,processors}.ts`. Tests: `apps/api/src/modules/orders/{transitions,cancellation-policy,settlement}.test.ts`, `apps/api/src/modules/notifications/catalog.test.ts`, `apps/api/test/{orders,order-events,cancellations,order-reads,support,notifications}.integration.test.ts`, `apps/worker/src/worker.test.ts`.

Status is **Implemented** with tests passing locally; rows move to *Verified* once CI has run them (§27.2). Transitions driven by restaurant, partner and admin screens (T06/T07/T11/T13/T15/T16) exist in the state machine and are exposed by Phases 8, 9 and 11.

| Requirement | Summary | Status / note |
|---|---|---|
| FR-CHK-002, FR-ORDER-001, FR-ORDER-002, API-CHK-004, FR-PRICE-005 | One transaction: revalidate cart hash and price, lock and decrement stock, snapshot items/options/prices/address, reserve coupon, hold wallet, create payment (COD or online), history and events; idempotent and race-safe | Implemented (order number `YYMMDD-XXXXXX`, D-10 approved) |
| FR-ORDER-003 | Order numbers short, unique, non-sequential | Implemented as `YYMMDD-XXXXXX` (13 characters; D-10 approved) |
| SRS §10.3 T01…T16 | Transition table with allowed actors, version check under row lock, timestamps, history (two rows for T13c), outbox event per transition | Implemented |
| ADR-010, NFR-REL-003 | Transactional outbox relay: sequence order, per-aggregate ordering on failure, retries, Redis leader lock, stale-event alert (JOB-OUTBOX-001) | Implemented in the worker (D-11 approved) |
| BR-PAY-003, T03 | Capture places the order: coupon redeemed, wallet hold debited, acceptance timers armed; duplicate capture refunded (E10) | Implemented |
| FR-PAY-006, BR-ORDER-003, T04, JOB-ORD-001 | Payment window: ask the provider (all payments on the provider order) before failing; release coupon, wallet and stock; payment EXPIRED | Implemented (`listOrderPayments` added to the provider interface) |
| FR-PAY-016, API-PAY-005, T05 | Abandon an unpaid order after checking the provider; late capture auto-refunded | Implemented |
| BR-ORDER-004, T08b, JOB-ORD-002, BR-REST-009, AC-ORDER-009 | Acceptance reminder (event for notifications) and timeout cancellation with full refund; branch auto-paused after 3 consecutive misses | Implemented (SMS reminder delivery uses dev sinks until providers exist) |
| JOB-ORD-003…007, AC-ORDER-010 | Auto-preparing, prep/pickup/delivery delay alerts, self-healing timer sweeper with remaining delays | Implemented (004–006 scheduled by Phase 8/9 transitions; T14 at the no-partner deadline is Phase 9) |
| JOB-CHK-001 | Expire checkout sessions | Implemented |
| FR-ORDER-020…023, BR-ORDER-010…013, 016, API-ORD-006, 007 | Cancellation preview with quote id, fees by state and time, refused once ready, every initiator, fault attribution, `order_cancellations`, row-lock serialisation (409 vs stale quote) | Implemented (fee capped at amount paid, D-12 approved) |
| BR-REFUND-001…003, FR-REFUND-002, 004 | Refund matrix for cancellations; split refunds per payment and wallet; fee from wallet first; tip always refunded; cancellation fee to the restaurant; food compensation for platform/partner-fault cancellations after cooking | Implemented |
| BR-COUPON-006 | Coupon released before acceptance or when the customer isn't at fault (including redeemed coupons) | Implemented |
| FR-ORDER-022 (stock) | Stock restored when cancelled before preparation | Implemented (delivery cancellation and partner compensation: Phase 9) |
| FR-SETTLE-001 | Settlement split posted once per delivered order and checked to balance | Implemented (tip settles to the partner in Phase 9; COD collection posts first in Phase 9) |
| FR-CORD-001…003, API-ORD-001…005 | History (status groups, dates, keyset paging), active orders, snapshot details, status, timeline; owner only | Implemented (partner card in Phase 9) |
| FR-ORDER-031, API-ORD-010 | Delivery instructions and contact phone until pickup | Implemented |
| FR-CORD-008, BR-ORDER-018, API-ORD-008 | Reorder at current prices, variants re-resolved, unavailable lines skipped | Implemented |
| FR-CORD-009, BR-ORDER-019, API-ORD-009 | Invoice numbers sequential per series and financial year without gaps; issued on delivery; PDF | Implemented (legal review of invoice content pending, SRS §20.4) |
| FR-CORD-010…012, BR-SUP-002, API-ORD-011…013 | Issue reports with items and refund requests, linked tickets, 48 h window, "not delivered" within 1 h as an urgent ticket | Implemented (photo uploads need the files module, Phase 8) |
| BR-REFUND-006 | Auto-approved small item refunds to wallet | Implemented |
| FR-CSUP-001…006, BR-SUP-001, 003, 004, API-SUP-001…009 | FAQs, tickets with SLA due times, replies, close, reopen within 7 days, CSAT, legal pages, grievance officer | Implemented (agent side in Phase 11) |
| FR-NOTIF-001…003, 005, 007, 010, API-NTF-001…005 | Central dispatch, versioned templates, inbox, read state, delivery records with retries, order/refund/ticket events | Implemented (SMS/email/push providers: dev sinks; production providers pending) |
| FR-NOTIF-004, 006, 009, API-NTF-006…010 | Hide, preferences for optional categories, push subscriptions (one per session, live sessions only) | Implemented |
| FR-NOTIF-008 | Quiet hours for promotional sends | Planned (no promotional sends yet) |
| API-TRK-001/002, FR-CORD-004…006 | Live tracking | Planned (Phase 9/10) |

## 22.1g Restaurant application implemented in Phase 8

Code: `apps/api/src/modules/{files,merchant}`, `apps/api/src/modules/orders/{restaurant-orders.service,merchant-orders.routes}.ts`, `apps/api/src/platform/crypto.ts`, `packages/validation/src/india.ts`, `packages/api-client/src/merchant-api.ts`, `apps/restaurant-web/src`. Tests: `apps/api/test/{files,onboarding,branch-ops,menu-admin,restaurant-orders,staff}.integration.test.ts`, `apps/api/src/modules/merchant/hours.test.ts`, `apps/api/src/platform/crypto.test.ts`, `packages/validation/src/india.test.ts`, `apps/restaurant-web/src/pages/restaurant-app.test.tsx`.

Status is **Implemented** with tests passing locally; rows move to *Verified* once CI has run them (§27.2).

| Requirement | Summary | Status / note |
|---|---|---|
| FR-FILE-001, 002, 004…006, BR-FILE-001, API-FILE-001…003 | Purpose rules, magic-byte typing, size limits, SVG refused, EXIF stripped, private files via audited 5-minute signed links, StorageProvider (local, S3), orphan cleanup | Implemented (FR-FILE-007 scanning is CORE) |
| FR-FILE-003 | WebP derivatives for public images | Implemented during upload; originals private (D-13 approved) |
| FR-REST-001…005, BR-REST-005, 007, 008, API-MER-001…007 | Applications with validated PAN/GSTIN/IFSC/FSSAI, first outlet, hours, bank, documents, logo; checklist; submit; review decisions; reapply wait; resubmission cap | Implemented (owner membership timing D-14 approved; admin console Phase 11) |
| FR-REST-010, BR-REST-012, FR-RFIN-003, API-MER-008…014 | Profile, logo/cover, encrypted change requests after re-auth | Implemented (review and payout hold in Phase 11) |
| FR-REST-012…018, BR-REST-001…004, 006, 009, API-MER-016…027 | Hours, holidays, open/close for today with next-day reopen, pause with auto-resume, prep time and rush, delivery settings within caps, status with reason, go-live checklist | Implemented (FR-REST-011 new branches is CORE) |
| FR-MENU-001…008, 012, BR-MENU-001…005, 007, 008, API-RMENU-001…026 | Categories, dishes, photos, variants, option groups, dietary consistency, availability, If-Match, menu_version bumps | Implemented (FR-MENU-009…011, 013, 014 are CORE/ADV) |
| FR-RORD-001…006, 008…012, BR-ORDER-005, 014, 015, BR-REST-015, API-RORD-001…008, 010…012 | Queue, details with data minimisation, accept (race-safe), reject, preparing, ready, prep extension, restaurant cancel, KDS, KOT data | Implemented (realtime push Phase 10; KOT print layout Phase 12) |
| FR-RORD-007, 013, API-RORD-009 | Handover with pickup code, partner delay | Implemented in Phase 9 (§22.1h); delay push Phase 10 |
| FR-RSTAFF-001, 002, API-RSTAFF-001…008 | Invitations, roles, scope, suspend, remove with immediate effect | Implemented (FR-RSTAFF-004…006 are CORE) |
| FR-RANL-001…003, API-RANL-001…004, 007 | Dashboard, sales, top dishes, categories, operations | Implemented from live queries (D-15 approved) |
| FR-RFIN-001, 002, 004 | Settlements, payouts | Planned (Phase 11) |
| FR-RREV-001…003 | Reviews | Implemented in Phase 9 (§22.1h) |
| NFR-SEC-005 | Field-level encryption of PAN and bank numbers | Implemented |

## 22.1h Delivery application, tracking and reviews implemented in Phase 9

Code: `apps/api/src/modules/{partners,dispatch,reviews}`, `packages/api-client/src/partner-api.ts`, `apps/delivery-web/src`, `apps/worker/src/{main,processors}.ts`. Tests: `apps/api/test/{partner-onboarding,partner-availability,dispatch,delivery-flow,partner-earnings,tracking-reviews}.integration.test.ts`, `apps/api/src/modules/partners/{pay,finance}.test.ts`, `apps/api/src/modules/dispatch/ranking.test.ts`, `apps/api/src/modules/reviews/moderation.test.ts`, `packages/shared/src/errors.test.ts`, `apps/delivery-web/src/pages/partner-app.test.tsx`.

Status is **Implemented** with tests passing locally; rows move to *Verified* once CI has run them (§27.2).

| Requirement | Summary | Status / note |
|---|---|---|
| FR-DP-001…005, 007, BR-DEL-016, API-DP-001…013 | Application, encrypted PAN and bank, Aadhaar last 4, documents, vehicle rules, age ≥ 18, review decisions, profile, vehicles, guidelines | Implemented (document expiry reminders FR-DP-006 CORE; admin console Phase 11; zone list D-16 open) |
| FR-DP-010…015, BR-DEL-006, 010, 011, 015, API-DP-014…020 | Online with a valid fix and blockers, offline (deferred on a trip), breaks, location batches with spoofing flags, auto-offline, dashboard | Implemented (API-DP-021 SOS is CORE) |
| FR-DISP-001…009, BR-DEL-001…005, 007, 014, 017, API-DPDEL-001…003 | Dispatch timing, ranked sequential offers, rounds, escalation, no-partner deadline, exactly-once acceptance, reject/expire/withdraw, bicycle limits | Implemented (manual assignment and API-DPDEL-012 Phase 11) |
| FR-DEL-001…005, 010, 020…035, 037, BR-DEL-008, 009, 013, API-DPDEL-004…011, 013, API-RORD-009 | Offer card, active delivery, geofenced arrivals, pickup and handover code, OTP/photo proof, COD collection, delivered, unreachable, unassign, history, heartbeat release | Implemented (offer push Phase 10; FR-DEL-036 SOS CORE) |
| FR-EARN-001, 002, 005…007, BR-EARN-001, 002, 005…007, API-EARN-001…003, 005…012 | Trip pay, tips, cancellation compensation, summaries, statement, cash in hand, payout estimate and history, performance, ratings, bank change after re-auth | Implemented (incentives FR-EARN-003 CORE; adjustments, deposits and payout batches Phase 11; partner ratings view per BR-REVIEW-006 v0.9.0, D-17) |
| FR-CORD-004…006, FR-TRK-001…005, BR-DEL-012, API-TRK-001/002 | Tracking snapshot and poll, location only from assignment to delivery, stale flag, delivery code, last-known location with database fallback | Implemented (fan-out, ETA pushes and stale alerts in Phase 10, §22.1i; route polyline needs a routing provider) |
| FR-REV-001, 002, 004…006, BR-REVIEW-001…006, API-REV-001…005 | Ratings after delivery within 7 days, one per target, tags, photos, text cleaning, edit 48 h, delete, reports hiding after 3, aggregates via outbox | Implemented (FR-REV-003 item thumbs and FR-REV-007 prompt are CORE) |
| FR-RREV-001…003, BR-REVIEW-005, API-RREV-001…004 | Restaurant reviews by outlet with filters, one response editable 24 h, reports | Implemented |

## 22.1i Real-time implemented in Phase 10

Code: `apps/api/src/platform/realtime/{socket-server,publisher}.ts`, `apps/api/src/modules/realtime`, hooks in `modules/{dispatch,partners,notifications}`, `apps/worker/src/main.ts`, `packages/api-client/src/{realtime,realtime-react}.ts`, `apps/restaurant-web/src/lib/live.ts`, `apps/delivery-web/src/lib/{live,location}.ts`. Tests: `apps/api/src/platform/realtime/socket-server.test.ts`, `apps/api/test/realtime.integration.test.ts`, `packages/api-client/src/realtime.test.ts`.

Status is **Implemented** with tests passing locally; rows move to *Verified* once CI has run them (§27.2).

| Requirement | Summary | Status / note |
|---|---|---|
| FR-RT-001…005, 007 | Namespaces per app, handshake token, refresh, revocation, personal/partner/branch-status rooms, ≤ 5 sockets per session, connection rate limit | Implemented (Phase 4 auth plus Phase 10 rooms) |
| FR-RT-006 | Redis adapter; pushes published on `rt:events` and emitted locally by every API instance | Implemented |
| FR-RT-010…014, FR-RT-026 | Server-side room policy, identical FORBIDDEN for missing and foreign resources, probing disconnect and log, room changes on assignment/release, allowed client events only, Zod validation, per-socket limits | Implemented |
| FR-RT-020…025 | Client reconnect with backoff and jitter, re-subscribe, refetch on reconnect, best-effort pushes with polling fallback, version and duplicate filtering | Implemented (D-18, D-19) |
| FR-RT-027, 028 | Gateway metrics and latency targets | Planned (Phase 13 load and observability work) |
| EVT-ORD-001…004, EVT-PAY-001, EVT-REF-001, EVT-DLV-001…003, EVT-NTF-001 | Customer projections | Implemented (customer screens use them in Phase 12) |
| EVT-REST-001…008 | Restaurant projections (priced queue, kitchen view without prices) | Implemented (EVT-REST-009 metrics and 010 menu availability in Phase 12) |
| EVT-DP-001…005, 010…012, 014, 015 | Partner projections | Implemented (EVT-DP-006 manual assignment Phase 11; EVT-DP-013 instruction changes come with FR-ORDER-031) |
| EVT-ADM-001, 002, 004…008 | Ops feed, approvals, partner stale, support, restaurant activity | Implemented without the 1 s batching (Phase 11 with the admin console); EVT-ADM-003 partner positions Phase 11 |
| EVT-C-001…006 | Client events | Implemented (heartbeat acknowledged only, D-18) |
| FR-TRK-001…007, FR-CORD-004 | Location over the socket or REST, throttled fan-out (3 s), ETA recompute (≤ 60 s, Δ ≥ 2 min), stale after 60 s and ops alert after 5 min | Implemented |

## 22.1j Administration implemented in Phase 11

Code: `apps/api/src/modules/admin` (accounts, operations, configuration and desk routers and services), admin hooks in `modules/{dispatch,orders,payments,merchant,partners,offers,reviews,support,config}`, `apps/api/src/platform/jobs.ts`, migrations `20261121090000_admin_forced_offline`, `20261121120000_admin_operations`, `20261121150000_rating_scale`, `packages/api-client/src/admin-api.ts`, `apps/admin-web/src`. Tests: `apps/api/test/admin-{accounts,operations,config}.integration.test.ts`, `apps/admin-web/src/pages/admin-app.test.tsx`.

Status is **Implemented** with tests passing locally; rows move to *Verified* once CI has run them (§27.2). ★ actions require a reason and write HIGH-sensitivity audit records; maker-checker (⧉) is CORE and not built.

| Requirement | Summary | Status / note |
|---|---|---|
| FR-ADMIN-001, 002, API-ADM-001…003 | Admin sign-in with emailed second factor; dashboard tiles; ops alerts with acknowledge/resolve; live feed | Implemented (ops map FR-ADMIN-003 / API-ADM-004 is CORE) |
| FR-ADMIN-010, API-ADM-010…017, 019 | User search with masked contacts, PII reveal, suspend/unsuspend, sign-out everywhere, wallet adjustments, COD block, sessions | Implemented (API-ADM-018 account recovery CORE) |
| FR-ADMIN-020…023, API-ADM-020…038, 040 | Restaurant applications, restaurants and branches, suspension, change requests, commission override, COD, signed document links | Implemented (API-ADM-039 menu moderation CORE) |
| FR-ADMIN-030, 031, API-ADM-041…054 | Partner applications, vehicles, partner management, force offline, cash deposits, earning adjustments, location trail | Implemented |
| FR-ADMIN-040, 041, API-ADM-060…065, 067, API-ADM-070…075, API-DPDEL-012 | Order search and 360 view, cancel with fault, mark delivered/failed, extend acceptance, audit trail; dispatch board, candidates, manual assignment with partner acknowledgement, reassign, redispatch, deadline extension | Implemented (API-ADM-066 resend, 068 address correction CORE) |
| FR-ADMIN-050, 051, 121, API-ADM-080…087, 091…097 | Payments with provider sync and webhook log; refunds with support limit and approval; payout batches (create, approve by another admin, CSV export, mark paid with UTR, failed lines roll over) | Implemented (reconciliation API-ADM-088…090 CORE) |
| FR-ADMIN-060, API-ADM-100…105 | Coupons with checkout rules enforced on create/edit, redemptions | Implemented (promotions and banners API-ADM-106…117 Phase 12 content work) |
| FR-ADMIN-070…073, API-ADM-120…140 | Zones with polygon validation, suspension and surge; settings with history; fee schedules, tax rules, commission and partner pay plans (append-only, future-dated) | Implemented (incentives API-ADM-141…143, feature flags 144…146 CORE) |
| FR-ADMIN-080, 082, API-ADM-150…155, 163…165 | Support desk queues, replies, internal notes, assignment, escalation; review moderation | Implemented (macros, complaints, disputes CORE) |
| FR-ADMIN-110, 111, 120, API-ADM-180, 183…185, 187, 202, 203 | Staff role grant/revoke with immediate effect and guards, audit search, failed jobs with retry | Implemented (custom roles 181/182, audit export 188 CORE) |
| FR-ADMIN-122 (cuisines), API-ADM-196…198 | Cuisine list/create/rename | Implemented (FAQs, legal documents, templates, broadcasts in Phase 12/CORE) |

## 22.2 Non-functional requirements

| Requirement IDs | Verification method | Test / evidence | Status |
|---|---|---|---|
| NFR-PERF-001…014 | k6 load tests in staging; Lighthouse CI & RUM for web vitals; query-count assertions | TC-PERF-001…020 | Planned |
| NFR-SCALE-001…007 | Architecture review; multi-instance socket test; stateless check | TC-SCALE-001…005 | Planned |
| NFR-AVAIL-001…006 | Chaos tests (Redis/DB/provider down) in staging; health probes | TC-CHAOS-001…010, AC-NFR-004 | Planned |
| NFR-REL-001…007 | Integration tests (idempotency, outbox, sweeper, graceful shutdown) | TC-REL-001…020 | Planned |
| NFR-SEC-001…020 | Automated security tests, authorization matrix, ZAP scan, dependency scan, ASVS checklist | TC-SEC-001…060, AC-RBAC-001 | Planned |
| NFR-PRIV-001…007 | Projection tests per role, retention job tests, log scans | TC-PRIV-001…015 | Planned |
| NFR-UX-001…010 | Usability review & E2E assertions | TC-UX-001…010 | Planned |
| NFR-ACCESS-001…007 | axe-core in CI, manual screen-reader pass | TC-A11Y-001…010, AC-NFR-002 | Planned |
| NFR-MAINT-001…009 | Lint rules, coverage thresholds, OpenAPI drift check | CI gates | Planned |
| NFR-COMPAT-001…004 | Cross-browser E2E (Playwright projects: Chromium, Firefox, WebKit, mobile emulation) | TC-COMPAT-001…008 | Planned |
| NFR-OBS-001…007 | Log/metric/trace presence tests; alert rules review | TC-OBS-001…010 | Planned |
| NFR-BACKUP-001…006 | Restore drill | AC-NFR-005 | Planned |

## 22.3 Business rules

Every `BR-*` rule is verified by at least one unit or integration test named with the rule ID (e.g., `it('BR-ORDER-011 charges 50% after 60s in ACCEPTED')`). The generated test report will list rule IDs with pass/fail; until then all business rules are `Planned`.

## 22.4 Change log

| Date | Version | Change |
|---|---|---|
| 2026-11-20 | 0.1.0 | Initial matrix (group-level, all rows Planned). |
| 2026-11-20 | 0.2.1 | Phase 2: added §22.1a with platform requirements implemented and verified. |
| 2026-11-20 | 0.2.2 | Phase 3: added §22.1b with database requirements. |
| 2026-11-20 | 0.3.1 | Phase 4: added §22.1c with authentication, session, realtime-auth and web-auth requirements. |
| 2026-11-20 | 0.4.0 | D-4…D-6 approved: BR-AUTH-001 fully implemented; FR-AUTH-002/003/042 and API-AUTH-003/004/023 text updated. |
| 2026-11-20 | 0.4.1 | Phase 5: added §22.1d with the core customer backend. |
| 2026-11-20 | 0.5.0 | D-7 and D-8 approved: BR-GEO-001 (b) and FR-ADDR-006 text updated; §22.1d notes adjusted. |
| 2026-11-20 | 0.5.1 | Phase 6: added §22.1e with cart, pricing, coupons, checkout, ledger, wallet and payments. |
| 2026-11-20 | 0.6.0 | D-9 approved: §15 `cart_items.unit_amount_seen`. |
| 2026-11-20 | 0.6.1 | Phase 7: added §22.1f with orders, cancellations, refunds, settlement, invoices, support and notifications; D-10…D-12 then open. |
| 2026-11-20 | 0.7.0 | D-10…D-12 approved: FR-ORDER-001 order number format, ADR-010 relay in the worker, BR-ORDER-011/012 fee cap. |
| 2026-11-21 | 0.7.1 | Phase 8: added §22.1g with uploads, onboarding, outlets, menu, restaurant orders, staff and analytics; D-13…D-15 then open. |
| 2026-11-21 | 0.8.0 | D-13…D-15 approved: FR-FILE-003 derivative timing, FR-REST-001 owner membership, FR-RANL-002 pre-aggregation optional. |
| 2026-11-21 | 0.8.1 | Phase 9: added §22.1h with partner onboarding, availability, dispatch, trip stages, earnings, tracking and reviews; D-16 and D-17 then open. |
| 2026-11-21 | 0.9.0 | D-16 and D-17 decided under the owner's standing instruction: API-DP-022 zone list; BR-REVIEW-006 comment threshold. |
| 2026-11-21 | 0.10.0 | Phase 10: added §22.1i (real-time); D-18 (FR-RT-021 liveness) and D-19 (§13.1 version rule) decided under the owner's standing instruction. |
| 2026-11-21 | 0.10.1 | Phase 11: added §22.1j (administration); §19.2 lists codes from Phases 9–11 (editorial). |
