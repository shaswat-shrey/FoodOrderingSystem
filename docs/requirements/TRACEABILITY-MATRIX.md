# SRS Section 22 — Requirement Traceability Matrix

> Part of FOS-SRS-001 v0.2.0 (APPROVED 2026-11-20). Rows in §22.1 and §22.2 are `Planned`; platform requirements delivered in Phase 2 are listed in §22.1a.
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
| DB-CONV-005 | Money as integer minor units | Implemented with Int/BigInt split — **discrepancy D-3 pending** |
| DB-CONV-007 | RESTRICT by default | Verified |
| DB-CONV-009 | No array relationships | Implemented (one exception: `audit_logs.actor_roles` text[] snapshot of role keys) |
| DB-INT-003 | Business uniqueness in the database | Verified |
| DB-INT-004 | Balanced ledger, non-negative wallets | Verified |
| DB-INT-005 | Snapshots render after menu changes | Implemented (verified with order flows in Phase 7) |
| DB-INT-006 | Outbox table | Implemented (relay in Phase 7) |
| §15.6 immutable snapshots | Append-only triggers | Verified — `payment_attempts` **discrepancy D-1 pending** |
| §15.3 partitioning | Monthly partitions for audit/location trail | Not implemented — **discrepancy D-2 pending** |
| BR-AUTH-014, BR-ADDR-001, BR-CART-001, BR-MENU-002…005, BR-COUPON-003/004, BR-DEL-014, BR-REVIEW-002, BR-REST-003, BR-ADMIN-001 | Rules with database backstops | Verified (database layer; service-level enforcement comes with each module) |
| FR-DISP-006/007, FR-DISP-013, FR-PAY-004, FR-PAY-008, FR-REFUND-003, FR-CFG-002, FR-AUDIT-002, FR-ADMIN-070 | Database backstops for these requirements | Verified (database layer) |

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
