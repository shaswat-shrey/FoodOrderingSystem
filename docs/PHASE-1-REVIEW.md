# Phase 1 Review Pack — For Owner Approval

> Date: 2026-11-20 · SRS FOS-SRS-001 v0.1.0 (DRAFT). **Phase 2 does not start until you approve this pack** (or approve with changes).

## 1. What was produced

| Deliverable (master prompt §31) | Where |
|---|---|
| 1 Product vision · 2 Feature breakdown | SRS §2.1–2.3, §3.3 |
| 3–6 Customer / restaurant / delivery / admin requirements | `requirements/FUNCTIONAL-REQUIREMENTS.md` §6–§9 |
| 7 Roles & permissions | SRS §3.4; `architecture/SYSTEM-ARCHITECTURE.md` §7 |
| 8 Business workflows | `requirements/SYSTEM-WORKFLOWS.md` (27 workflows) |
| 9 Order state machine · 10 Delivery state machine | SRS §10.3, §12.1; `architecture/STATE-MACHINES.md` |
| 11 Authentication & session architecture | SRS §5; architecture §6; ADR-003 |
| 12 Security architecture | architecture §9; NFR §16.5 |
| 13 System architecture · 14 Backend modules · 15 Frontend architecture | `architecture/SYSTEM-ARCHITECTURE.md` §2–§4, §12 |
| 16 Entity inventory · 17 Initial ERD | `requirements/DATABASE-REQUIREMENTS.md`; `database/ERD.md` |
| 18 API inventory | `requirements/API-SPECIFICATION.md` (494 planned endpoints) |
| 19 Real-time event inventory | `requirements/REALTIME-REQUIREMENTS.md` |
| 20 Background job inventory | `architecture/EVENTS-AND-JOBS.md` |
| 21 Payment architecture | `architecture/PAYMENT-ARCHITECTURE.md` |
| 22 Delivery assignment algorithm | `architecture/DELIVERY-ASSIGNMENT-ALGORITHM.md` |
| 23 Caching strategy · 24 Search strategy | architecture §10, §11 |
| 25 Testing strategy | `architecture/TESTING-STRATEGY.md` |
| 26 Infrastructure · 27 Directory structure | architecture §13, §14 |
| 28 Roadmap · 29 Task breakdown · 30 Risks | `ROADMAP.md` |
| SRS (28 sections), business rules, NFRs, acceptance criteria, traceability, index | `requirements/` |
| ADRs | `architecture/adr/` (14) |

Size of the requirement set (generated index): 408 functional requirements (252 P0), 104 NFRs, 161 business rules, 96 acceptance criteria, 494 API endpoints, 49 real-time events — 0 duplicate IDs, 0 dangling references.

## 2. Decisions that need your approval

### 2.1 Assumptions (SRS §3.7, those marked "Confirm")
| ID | Assumption |
|---|---|
| A-01 | Launch in one Indian city; INR; English UI first |
| A-02 | Single-branch carts/orders |
| A-03 | Platform delivery fleet only (no restaurant self-delivery in MVP) |
| A-04 | No scheduled orders in MVP |
| A-05 | Razorpay as the first payment gateway |
| A-06 | Leaflet + OSM display; production maps/geocoding provider chosen later |
| A-12 | Pilot capacity profile (500 branches, 20k DAU, 500 online partners, 60 orders/min peak) |
| A-13 | Weekly settlements & payouts; admin-executed bank transfers in MVP |
| A-14 | Customer wallet = closed-loop refund/promo credits only |
| A-15 | Fee/tax/commission values are placeholders, configurable |
| A-16 | No POS integration in MVP |
| A-17 | Partner app is a PWA (must stay foregrounded during deliveries) |
| A-18 | SMS/email providers TBD (DLT-registered SMS) |
| A-19 | Phone number mandatory to order |
| A-20 | Partner sees customer phone during active delivery (masked calling later) |

### 2.2 Unresolved business decisions (SRS §3.10)
OD-01 brand name · OD-02 cancellation policy (proposed: free until acceptance + 60 s; 50 % food value later in ACCEPTED; 100 % food + packaging in PREPARING; none after ready) · OD-03 acceptance timeout (5 min) · OD-04 fee values (platform ₹5, delivery slabs ₹19–49, small-order ₹15 under ₹149, surge ≤ ₹40) · OD-05 commission model (20 % default) · OD-06 tax treatment (needs tax advisor) · OD-07 coupon funding model · OD-08 COD limits (₹1,500; partner cash cap ₹3,000) · OD-09 partner pay (₹25 base + ₹6/km beyond 2 km + wait pay) · OD-10 wallet scope · OD-11 refund destination default · OD-12 hosting target (India region recommended) · OD-13 maps provider · OD-14 product objective targets · OD-15 legal pages & grievance officer · OD-16 photo proof of delivery.

### 2.3 Design decisions worth a conscious "yes"
1. **Order/payment/delivery are three state machines** (ADR-006) instead of one 17-state list — the suggested states are all represented, mapped in SRS §10.1.
2. **Order is created before payment** (PAYMENT_PENDING), which eliminates "paid but no order"; late captures auto-refund.
3. **Branch is the orderable unit**, menu at brand level (ADR-013).
4. **Double-entry ledger** for all money (ADR-011).
5. **Sequential offers** for dispatch (ADR-008).
6. **Prisma schema lives in `packages/db`** rather than root `prisma/`.
7. **SRS split into companion files** with a generated index (rationale in SRS §1.13).

## 3. Critical architectural risks (top 5 of 16 — full list in ROADMAP §3)
1. **Scope** (R-01) — mitigated by MVP/CORE staging and phase gates.
2. **Payment correctness** (R-02) — layered idempotency, precedence, ledger invariants, reconciliation.
3. **Concurrency in orders/dispatch** (R-03) — DB locks + partial unique indexes + concurrency tests.
4. **PWA background GPS** (R-05) — foreground requirement, stale detection; Capacitor upgrade path.
5. **Regulatory/tax uncertainty** (R-08) — configurable engine, legal review list (SRS §20.4).

## 4. MVP vs later releases
- **MVP:** everything needed for one city end-to-end with real money correctness — detailed in SRS §24.2 (P0 = 252 FRs, all MVP, plus P1s required for coherent flows).
- **CORE:** OAuth, promotions engine, granular staff permissions, stock & schedules, combos, incentives, automated payouts, reconciliation UI, complaints/disputes, item reviews, moderation, search suggestions/trending/typo tolerance, web push, notification preferences, reports, feature-flag UI, surge, TOTP MFA, maker-checker.
- **ADV:** batching, ML ETA, chat, masked calling, fraud scoring, per-branch pricing, Hindi.
- **FUT:** native apps, scheduled/group orders, self-delivery, POS, dine-in, grocery, subscriptions, multi-currency.

## 5. How to approve
Reply with one of: **Approve** · **Approve with changes** (list OD answers / edits) · **Revise** (sections to rework). Approved answers to OD-* will be written back into the SRS (v0.2.0) before Phase 2 starts.
