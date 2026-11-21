# Jira milestones — FoodOrderSystem

How the project was built, as 28 milestones (Jira **Epics**) and 108 tickets (Jira **Stories**), in build order. All are **Done**. Import file: [`fos-jira-import.csv`](fos-jira-import.csv) (same columns as a standard CSV import: Issue ID, Parent, Issue Type, Summary, Description, Status, Labels; label `foodordersystem`).

## Importing into Jira

1. Jira → **Settings → System → External system import → CSV** (or *Import issues from CSV* in the project).
2. Upload `fos-jira-import.csv` and choose your project.
3. Map the columns: *Issue ID* → Issue ID, *Parent* → Parent (links stories to their epic), *Issue Type*, *Summary*, *Description*, *Status*, *Labels*.
4. If your workflow has no *Done* status mapping, map it to your final status (e.g. *Closed*).

## Milestones at a glance

| # | Milestone | Phase | Tickets |
|---|---|---|---|
| 1 | Discovery & requirements | Phase 1 - Product discovery and the SRS | 4 |
| 2 | Architecture & design | Phase 1 - System architecture, ADRs and core algorithms | 5 |
| 3 | Monorepo & developer tooling | Phase 2 - Repository foundation | 4 |
| 4 | Infrastructure & CI | Phase 2 - Local infrastructure, containers and CI | 4 |
| 5 | Database schema & seed data | Phase 3 - Database | 4 |
| 6 | Authentication & sessions | Phase 4 - Authentication | 4 |
| 7 | Authorization & audit | Phase 4 - Access control and audit | 4 |
| 8 | Location & serviceability | Phase 5 - Geo, zones and delivery coverage | 3 |
| 9 | Catalog, discovery & search | Phase 5 - Core customer backend | 5 |
| 10 | Cart, pricing & coupons | Phase 6 - Cart and pricing engine | 3 |
| 11 | Checkout, payments & wallet | Phase 6 - Checkout and money | 4 |
| 12 | Order lifecycle | Phase 7 - Order management | 4 |
| 13 | Cancellations, refunds & settlement | Phase 7 - Money after the order | 4 |
| 14 | Support & notifications | Phase 7 - Customer support and messaging | 3 |
| 15 | Restaurant onboarding | Phase 8 - Restaurant application | 4 |
| 16 | Restaurant operations | Phase 8 - Running a restaurant | 5 |
| 17 | Delivery partner onboarding & availability | Phase 9 - Partner application and shifts | 3 |
| 18 | Dispatch engine | Phase 9 - Assigning deliveries | 4 |
| 19 | Delivery trip & partner earnings | Phase 9 - Trip stages and pay | 4 |
| 20 | Tracking & reviews | Phase 9 - Customer tracking and ratings | 3 |
| 21 | Real-time platform | Phase 10 - Live updates | 4 |
| 22 | Admin backend | Phase 11 - Administration APIs | 4 |
| 23 | Admin console | Phase 11 - Admin web app | 3 |
| 24 | Customer web app | Phase 12 - Customer interface | 3 |
| 25 | Restaurant & partner app completion | Phase 12 - Remaining merchant and partner screens | 3 |
| 26 | End-to-end & accessibility testing | Phase 13 - Testing | 3 |
| 27 | Hardening | Phase 13 - Security, resilience and performance | 5 |
| 28 | Documentation & release | Phase 14 - Finalization | 5 |

## 1. Discovery & requirements

_Phase 1 - Product discovery and the SRS_

| Ticket | Summary | What was done |
|---|---|---|
| 101 | Stakeholders, roles and scope | Customer, restaurant, delivery partner, admin and support roles; MVP/CORE/ADV scope; open decisions OD-01…OD-16 |
| 102 | Software Requirements Specification (SRS) | FOS-SRS-001: functional requirements, business rules, order/payment/delivery requirements, NFRs, error handling, privacy and retention |
| 103 | API inventory and acceptance criteria | API-SPECIFICATION (≈500 endpoints), acceptance criteria AC-*, requirements index and ID checker |
| 104 | Traceability matrix and SRS change process | Requirement → phase → code → tests matrix; versioned SRS with revision log and discrepancy (D-n) process |

## 2. Architecture & design

_Phase 1 - System architecture, ADRs and core algorithms_

| Ticket | Summary | What was done |
|---|---|---|
| 105 | System architecture and ADRs | Modular monolith, outbox relay, ledger, sessions, realtime; ADR-001…ADR-011 |
| 106 | Database design and ERD | Entity catalog, ERD, schema notes, money as integer paise, UUID v7 ids |
| 107 | State machines | Order (T01–T16), delivery (D01–D10), payment and refund state machines |
| 108 | Dispatch algorithm design | Sequential single offers, rounds 3/5/8 km, ranking weights, exactly-once acceptance, escalation |
| 109 | Roadmap and testing strategy | 14-phase roadmap with exit criteria; test pyramid, critical suites, quality gates |

## 3. Monorepo & developer tooling

_Phase 2 - Repository foundation_

| Ticket | Summary | What was done |
|---|---|---|
| 110 | pnpm + Turborepo monorepo | apps/{api,worker,customer-web,restaurant-web,delivery-web,admin-web}, packages/{shared,types,validation,ui,api-client,auth-web,db,config} |
| 111 | TypeScript, ESLint, Prettier | Strict TS, module boundary lint rules (cross-module imports through index.ts), formatting gate |
| 112 | Shared packages | Error codes and messages, permissions, zod validation, design-system UI kit, typed API client |
| 113 | App shells for the four web apps | React + Vite + Tailwind shells with routing, 404/error pages and platform status |

## 4. Infrastructure & CI

_Phase 2 - Local infrastructure, containers and CI_

| Ticket | Summary | What was done |
|---|---|---|
| 114 | Docker Compose stack | Postgres + PostGIS, Redis, SeaweedFS (S3), Mailpit; production Dockerfiles for API and worker |
| 115 | No-Docker local setup | Project-local PostgreSQL 18 + PostGIS on 5433 and Redis on 6390/6391 scripts |
| 116 | API platform foundation | Express app, structured logging, config validation, health/readiness, Redis clients, graceful shutdown |
| 117 | GitHub Actions CI | Lint, typecheck, tests with coverage, migration drift check, build, SRS ID check, Docker images, E2E |

## 5. Database schema & seed data

_Phase 3 - Database_

| Ticket | Summary | What was done |
|---|---|---|
| 118 | Prisma schema for all domains | ≈140 tables across identity, catalog, orders, payments, ledger, delivery, engagement, platform |
| 119 | Constraints, triggers and immutability | Partial uniques, CHECKs, append-only history/ledger, effective-dated configs, overlap guards |
| 120 | Migrations and drift check | Ordered migrations; CI check that migrations equal the schema |
| 121 | Deterministic seed data | Zones, restaurants with menus, partners, customers, staff and admin accounts, coupons, fee schedules |

## 6. Authentication & sessions

_Phase 4 - Authentication_

| Ticket | Summary | What was done |
|---|---|---|
| 122 | Registration, OTP and password sign-in | Phone OTP, password login, email verification, password reset, breached-password check |
| 123 | Sessions and refresh-token rotation | Short access tokens, HttpOnly refresh cookie, rotation with reuse detection, logout everywhere |
| 124 | Admin MFA and re-authentication | Emailed second factor for admins; re-auth for sensitive actions (BR-AUTH-017) |
| 125 | Shared auth web package | Sign-in, sign-up, verify, recovery and security pages reused by all four apps |

## 7. Authorization & audit

_Phase 4 - Access control and audit_

| Ticket | Summary | What was done |
|---|---|---|
| 126 | Roles and permissions (IAM) | Platform roles and restaurant roles with permission grants, cached resolution, permission versions |
| 127 | App scopes and route guards | Per-app audiences, onboarding scope, authorize middleware, 404 vs 403 semantics |
| 128 | Audit logging | Audit records for every sensitive action with HIGH-sensitivity stream and reasons |
| 129 | Rate limiting and idempotency | Redis rate limits per IP/identifier/user; Idempotency-Key replay for money-moving requests |

## 8. Location & serviceability

_Phase 5 - Geo, zones and delivery coverage_

| Ticket | Summary | What was done |
|---|---|---|
| 130 | Geocoding and address validation | Geocoder adapter with cache, pin-vs-address distance warning, India bounds |
| 131 | Zones and serviceability | PostGIS zone polygons, branch radius, road-distance estimates, serviceability reasons |
| 132 | Customer addresses | Address book with default, validation and serviceability per branch |

## 9. Catalog, discovery & search

_Phase 5 - Core customer backend_

| Ticket | Summary | What was done |
|---|---|---|
| 133 | Restaurant and branch pages | Status with reasons (hours, pause, holiday), FSSAI, ETA, delivery fee, Bayesian rating |
| 134 | Menu reads | Categories, dishes, variants, option groups, availability, menu versions and caching |
| 135 | Discovery feed | Restaurant list for a location with filters (veg, offers, open now, rating) and sorting |
| 136 | Search | Restaurant and dish search with trigram matching and history |
| 137 | Favourites and profile | Favourite restaurants/dishes, customer profile and food preferences |

## 10. Cart, pricing & coupons

_Phase 6 - Cart and pricing engine_

| Ticket | Summary | What was done |
|---|---|---|
| 138 | Cart service | Single-branch cart, line customisations, quantity limits, price-change detection |
| 139 | Pricing engine | Fee schedules and slabs, packaging, surge, taxes per component, rounding rules (BR-PRICE) |
| 140 | Coupons and offers | Coupon rules (percent cap, minimum order, limits, targeting), redemption reservations |

## 11. Checkout, payments & wallet

_Phase 6 - Checkout and money_

| Ticket | Summary | What was done |
|---|---|---|
| 141 | Checkout sessions | Quote, payment method eligibility (COD caps), tip, expected payable, session expiry |
| 142 | Payments and provider adapter | Razorpay adapter + mock provider, signature verification, webhooks, retries, stuck-payment resolution |
| 143 | Double-entry ledger | Balanced postings, account balances, nightly integrity check |
| 144 | Customer wallet | Credits with expiry lots, holds, debits and transaction history |

## 12. Order lifecycle

_Phase 7 - Order management_

| Ticket | Summary | What was done |
|---|---|---|
| 145 | Order creation | Order from a confirmed checkout with snapshots, order number, delivery OTP |
| 146 | Order state machine | Table-driven transitions with actors, version checks, history and outbox events |
| 147 | Order timers | Payment window, acceptance timeout, auto-preparing, delay reminders via BullMQ |
| 148 | Order reads | Active orders, history, details and timeline for customers |

## 13. Cancellations, refunds & settlement

_Phase 7 - Money after the order_

| Ticket | Summary | What was done |
|---|---|---|
| 149 | Cancellation policy | Fee preview by stage and fault, free window, quote staleness |
| 150 | Refunds | Refunds to source or wallet, retries, refund status tracking |
| 151 | Settlement and invoices | Restaurant/platform split on delivery, invoices for delivered orders |
| 152 | Order issues | Report a problem with items/quantities, linked support ticket |

## 14. Support & notifications

_Phase 7 - Customer support and messaging_

| Ticket | Summary | What was done |
|---|---|---|
| 153 | Support tickets | Tickets with categories, messages, deadlines and statuses |
| 154 | Notification system | Templates, in-app inbox, preferences, SMS/email/push channels with dev sinks |
| 155 | Transactional outbox relay | Outbox events published by the worker with leader lock, retries and stale alerts |

## 15. Restaurant onboarding

_Phase 8 - Restaurant application_

| Ticket | Summary | What was done |
|---|---|---|
| 156 | File uploads | Purpose rules, magic-byte typing, EXIF stripping, WebP derivatives, signed private links, orphan cleanup |
| 157 | Restaurant application | Business details with PAN/GSTIN/FSSAI/IFSC validation, first outlet, hours, bank, documents, checklist, submit |
| 158 | Field-level encryption | AES-256-GCM with rotatable keys for PAN, bank numbers and change requests |
| 159 | Profile and change requests | Profile edits, legal/tax/bank change requests after re-auth |

## 16. Restaurant operations

_Phase 8 - Running a restaurant_

| Ticket | Summary | What was done |
|---|---|---|
| 160 | Outlet management | Hours, holidays, open/close, pause, prep time and rush, delivery settings, go-live checklist |
| 161 | Menu management | Categories, dishes, photos, variants, option groups, availability, If-Match versions |
| 162 | Order queue and kitchen display | Accept with prep time, reject, preparing, ready, prep extension, KDS without prices |
| 163 | Staff and roles | Invitations, roles and outlet scope, suspend/remove with immediate effect |
| 164 | Restaurant analytics | Dashboard, sales, top dishes, categories and operations metrics |

## 17. Delivery partner onboarding & availability

_Phase 9 - Partner application and shifts_

| Ticket | Summary | What was done |
|---|---|---|
| 165 | Partner application | Details, Aadhaar last 4 only, vehicles, documents, age check, bank, review decisions |
| 166 | Online / offline and presence | Online with a fresh location fix and blockers, breaks, Redis presence and zone GEO sets |
| 167 | Location ingestion | Batched fixes with spoofing checks, sampled trail, auto-offline rules |

## 18. Dispatch engine

_Phase 9 - Assigning deliveries_

| Ticket | Summary | What was done |
|---|---|---|
| 168 | Candidate search and ranking | Rounds 3/5/8 km, eligibility filters, bicycle limits, COD cash cap, ranking score breakdown |
| 169 | Sequential offers | 30 s offers, reject/expire/withdraw, missed-offer counting |
| 170 | Exactly-once acceptance | Redis lock plus row locks and one-active-delivery index |
| 171 | Escalation and no-partner deadline | Ops alerts, 60 s retries, platform-fault cancellation with full refund |

## 19. Delivery trip & partner earnings

_Phase 9 - Trip stages and pay_

| Ticket | Summary | What was done |
|---|---|---|
| 172 | Trip stages with geofences | Arrived at restaurant/customer with geofence confirmation, pickup only when ready |
| 173 | Handover and proof of delivery | Restaurant pickup-code handover, OTP (5 tries) or photo proof, COD collection |
| 174 | Partner earnings and payouts view | Trip pay, tips, cancellation compensation, summaries, cash in hand, payout estimate, bank change |
| 175 | Unassign and heartbeat release | Give-back before pickup, silent-partner release, re-dispatch |

## 20. Tracking & reviews

_Phase 9 - Customer tracking and ratings_

| Ticket | Summary | What was done |
|---|---|---|
| 176 | Order tracking | Snapshot and poll: partner card, live location with privacy window, ETA, delivery code |
| 177 | Reviews and ratings | Restaurant and partner ratings within 7 days, moderation, edit/delete windows |
| 178 | Restaurant review responses | One response per review, reports, aggregate recomputation |

## 21. Real-time platform

_Phase 10 - Live updates_

| Ticket | Summary | What was done |
|---|---|---|
| 179 | Socket gateway and room policy | Namespaces per app, server-side room authorization, rate limits, revocation |
| 180 | Event projections per audience | Outbox events turned into customer, restaurant, partner and admin pushes |
| 181 | Live tracking fan-out | Throttled location pushes, ETA recompute, stale-location alerts |
| 182 | Client realtime library | Reconnect with backoff, resubscribe, de-duplication; apps refresh from pushes with polling fallback |

## 22. Admin backend

_Phase 11 - Administration APIs_

| Ticket | Summary | What was done |
|---|---|---|
| 183 | Accounts administration | Users, restaurant and partner approvals, suspensions, change requests, documents |
| 184 | Operations administration | Dashboard, alerts, orders 360 and interventions, dispatch board, manual assignment |
| 185 | Finance administration | Payments sync, refunds with support limits and approval, payout batches with maker ≠ checker |
| 186 | Configuration and governance | Coupons, zones, settings history, pricing plans, support desk, moderation, roles, audit search, failed jobs |

## 23. Admin console

_Phase 11 - Admin web app_

| Ticket | Summary | What was done |
|---|---|---|
| 187 | Dashboard and live ops feed | Today's tiles, alerts, live activity over sockets |
| 188 | Approvals, accounts and orders screens | Restaurants, partners, users, orders 360, dispatch board |
| 189 | Finance and configuration screens | Payments, refunds, payouts, coupons, zones, settings, pricing, support desk, moderation, roles, audit, jobs |

## 24. Customer web app

_Phase 12 - Customer interface_

| Ticket | Summary | What was done |
|---|---|---|
| 190 | Ordering journey | Location, discovery, search, restaurant menu with customisation, cart, coupons |
| 191 | Checkout, payment and live tracking | Checkout, dev payment step, live tracking, cancellation |
| 192 | Account area | Orders history, reorder, issues, ratings, addresses, profile, wallet, favourites, notifications, help |

## 25. Restaurant & partner app completion

_Phase 12 - Remaining merchant and partner screens_

| Ticket | Summary | What was done |
|---|---|---|
| 193 | Restaurant dish editor and menu tools | Full dish editor, option groups, category management |
| 194 | Restaurant handover, analytics, reviews, payouts | Order drawer with pickup code, analytics charts, reviews, payouts, profile |
| 195 | Partner app screens | Application, shift with offers, trip stages, earnings, trips, bank, profile, live notices |

## 26. End-to-end & accessibility testing

_Phase 13 - Testing_

| Ticket | Summary | What was done |
|---|---|---|
| 196 | Full-stack E2E journey | One order across customer, restaurant and partner browsers (AC-E2E-001…003) |
| 197 | Failure-scenario E2E | Payment retry, restaurant rejects, partner rejects, cancellation fee, no partner, session theft (AC-E2E-004…009) |
| 198 | Accessibility checks | axe-core on key pages of all four apps, desktop and mobile (AC-NFR-002) |

## 27. Hardening

_Phase 13 - Security, resilience and performance_

| Ticket | Summary | What was done |
|---|---|---|
| 199 | Security hardening | Authorization matrix over all routes, security headers, CORS, log scan for secrets, dependency audit |
| 200 | Resilience | Redis outage handling: DB fallbacks, in-memory limits, dispatch pause, outbox drain (AC-NFR-004) |
| 201 | Coverage and quality gates | Coverage thresholds in CI; CI fixes so integration tests really run |
| 202 | Load test scripts | k6 scripts for discovery, menu, checkout, location ingestion and socket fan-out |
| 203 | Bug fixes from testing | Refresh race, partner handover push, socket limits behind proxies, UI confirmations, contrast |

## 28. Documentation & release

_Phase 14 - Finalization_

| Ticket | Summary | What was done |
|---|---|---|
| 204 | README and setup guides | Quick start (Docker and no-Docker), environment variables guide |
| 205 | Deployment guide | Images, migrations, Nginx with security headers, scaling, backups, go-live checklist |
| 206 | Generated API documentation | OpenAPI 3.1 generated from mounted routes and zod schemas |
| 207 | UML diagrams | Use case, component, deployment, class, state, sequence and activity diagrams |
| 208 | Demo guide, limitations and roadmap | Demo accounts and walkthrough, known limitations, CORE/ADV roadmap |
