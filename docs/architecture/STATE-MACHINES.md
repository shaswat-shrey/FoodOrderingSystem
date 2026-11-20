# State Machines

> Phase 1 · v0.5.0 (APPROVED 2026-11-20). Normative transition tables live in SRS §10.3 (orders) and §12.1 (deliveries). This document provides diagrams and the remaining machines. Implementation: each machine is a pure, data-driven transition table in `@fos/shared/state-machines` (used by API for enforcement and by frontends for labels/available actions); the API's `transition()` adds locking, guards, side effects.

## 1. Order

```mermaid
stateDiagram-v2
  [*] --> PAYMENT_PENDING: T01 confirm (online)
  [*] --> PLACED: T02 confirm (COD / fully prepaid by wallet)
  PAYMENT_PENDING --> PLACED: T03 payment captured
  PAYMENT_PENDING --> FAILED: T04 payment TTL expired
  PAYMENT_PENDING --> CANCELLED: T05 customer cancels
  PLACED --> ACCEPTED: T06 restaurant accepts
  PLACED --> REJECTED: T07 restaurant rejects
  PLACED --> CANCELLED: T08 customer / timeout / admin
  ACCEPTED --> PREPARING: T09 start (manual or auto)
  ACCEPTED --> CANCELLED: T10 customer(fee) / restaurant / admin / system
  PREPARING --> READY_FOR_PICKUP: T11 mark ready
  PREPARING --> PICKED_UP: T13c handover (records READY too)
  PREPARING --> CANCELLED: T12 customer(fee) / restaurant / admin / system
  READY_FOR_PICKUP --> PICKED_UP: T13 partner pickup
  READY_FOR_PICKUP --> CANCELLED: T14 admin / no-partner deadline
  PICKED_UP --> DELIVERED: T15 OTP / photo / admin
  PICKED_UP --> FAILED: T16 support (unreachable, incident)
  DELIVERED --> [*]
  CANCELLED --> [*]
  REJECTED --> [*]
  FAILED --> [*]
```

Order `refund_status` (derived from refunds): `NONE → PENDING → PARTIAL | FULL` (PENDING while any refund is PROCESSING).

## 2. Delivery

```mermaid
stateDiagram-v2
  [*] --> PENDING: order accepted (D01)
  PENDING --> SEARCHING: dispatch start time (D02)
  SEARCHING --> SEARCHING: round expansion / escalation flag (D11)
  SEARCHING --> ASSIGNED: offer accepted / manual assign (D03)
  ASSIGNED --> AT_RESTAURANT: arrived (D04)
  ASSIGNED --> EN_ROUTE_TO_CUSTOMER: picked up (D05)
  AT_RESTAURANT --> EN_ROUTE_TO_CUSTOMER: picked up (D05)
  ASSIGNED --> SEARCHING: unassign / abandon / reassign (D08)
  AT_RESTAURANT --> SEARCHING: unassign / reassign (D08)
  EN_ROUTE_TO_CUSTOMER --> AT_CUSTOMER: arrived (D06)
  AT_CUSTOMER --> DELIVERED: verified handover (D07)
  EN_ROUTE_TO_CUSTOMER --> DELIVERED: admin override (D07)
  EN_ROUTE_TO_CUSTOMER --> FAILED: D10
  AT_CUSTOMER --> FAILED: D10
  PENDING --> CANCELLED: order cancelled (D09)
  SEARCHING --> CANCELLED: D09
  ASSIGNED --> CANCELLED: D09
  AT_RESTAURANT --> CANCELLED: D09
  DELIVERED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
```

Coupling with order states: `EN_ROUTE_TO_CUSTOMER` ⇔ order `PICKED_UP`; `DELIVERED` ⇔ order `DELIVERED`; delivery `FAILED` ⇔ order `FAILED`; order cancellation ⇒ delivery `CANCELLED`. Pickup is a single transaction that moves both.

## 3. Delivery assignment (offer)

```mermaid
stateDiagram-v2
  [*] --> OFFERED
  OFFERED --> ACCEPTED: partner accepts (locked)
  OFFERED --> REJECTED: partner rejects
  OFFERED --> EXPIRED: 30 s timeout
  OFFERED --> WITHDRAWN: order cancelled / partner went offline / dispatch restarted
  ACCEPTED --> RELEASED: partner unassigns / heartbeat abandonment
  ACCEPTED --> REVOKED: admin reassigns
  ACCEPTED --> [*]: delivery completes (assignment stays ACCEPTED)
  REJECTED --> [*]
  EXPIRED --> [*]
  WITHDRAWN --> [*]
  RELEASED --> [*]
  REVOKED --> [*]
```

## 4. Payment

```mermaid
stateDiagram-v2
  [*] --> CREATED
  CREATED --> PENDING: provider order created
  PENDING --> AUTHORIZED: authorized (transient with auto-capture)
  PENDING --> CAPTURED: captured
  AUTHORIZED --> CAPTURED: captured
  PENDING --> FAILED: attempts exhausted / terminal failure
  PENDING --> EXPIRED: order payment TTL
  CREATED --> CANCELLED: order cancelled before initiation
  PENDING --> CANCELLED: customer abandons
  AUTHORIZED --> FAILED: auto-void
  CAPTURED --> PARTIALLY_REFUNDED: partial refund succeeded
  PARTIALLY_REFUNDED --> PARTIALLY_REFUNDED: further partial refund
  CAPTURED --> REFUNDED: full refund succeeded
  PARTIALLY_REFUNDED --> REFUNDED: remaining refunded
```
Individual attempts are recorded on `payment_attempts` (status progresses CREATED → AUTHORIZED → CAPTURED/FAILED; provider ID and amount are immutable); the payment remains `PENDING` while retries are allowed. Precedence rule (FR-PAY-009) prevents regressions from out-of-order events.

COD payment: `PENDING → COLLECTED` (partner confirms cash) or `PENDING → CANCELLED` (order did not complete).

## 5. Refund

```mermaid
stateDiagram-v2
  [*] --> REQUESTED: needs approval (above limit)
  [*] --> APPROVED: auto-approved by policy
  REQUESTED --> APPROVED: approver (≠ requester)
  REQUESTED --> CANCELLED: rejected
  APPROVED --> SUCCEEDED: destination WALLET (immediate ledger credit)
  APPROVED --> PROCESSING: submitted to provider
  PROCESSING --> SUCCEEDED: webhook / poll
  PROCESSING --> FAILED: provider failure after retries
  FAILED --> PROCESSING: manual retry
  FAILED --> SUCCEEDED: fallback to wallet credit
```

## 6. Restaurant onboarding & status

Onboarding: `DRAFT → SUBMITTED → UNDER_REVIEW → (CHANGES_REQUESTED → SUBMITTED)* → APPROVED | REJECTED` (diagram in SRS WF-06).
Restaurant status (after approval): `ACTIVE ⇄ SUSPENDED → DEACTIVATED`.
Branch status: `PENDING_APPROVAL → ACTIVE ⇄ SUSPENDED → DEACTIVATED`; orthogonal operational state computed from hours, holidays, manual close, pause (BR-REST-001).

## 7. Delivery partner

Onboarding: same shape as restaurant onboarding.
Account status: `ACTIVE ⇄ SUSPENDED → DEACTIVATED`.
Availability (live, Redis-authoritative):

```mermaid
stateDiagram-v2
  [*] --> OFFLINE
  OFFLINE --> ONLINE_IDLE: go online (eligibility checks)
  ONLINE_IDLE --> OFFERED: offer created
  OFFERED --> ONLINE_IDLE: rejected / expired / withdrawn
  OFFERED --> ON_DELIVERY: accepted
  ON_DELIVERY --> ONLINE_IDLE: delivered / released
  ON_DELIVERY --> OFFLINE: delivered with pending offline request
  ONLINE_IDLE --> PAUSED: break (CORE)
  PAUSED --> ONLINE_IDLE: resume / auto
  ONLINE_IDLE --> OFFLINE: go offline / auto-offline / suspended
  PAUSED --> OFFLINE: go offline
```

## 8. User account

`PENDING_VERIFICATION → ACTIVE ⇄ SUSPENDED`; `ACTIVE → DEACTIVATED (deletion grace) → ACTIVE (reactivate) | ANONYMIZED (terminal)`.

## 9. Session & refresh token

Session: `ACTIVE → REVOKED | EXPIRED`. Refresh token: `ACTIVE → ROTATED | REVOKED`; `ROTATED` token presented after grace ⇒ session `REVOKED (REFRESH_REUSE)`.

## 10. Support ticket

`OPEN → PENDING_CUSTOMER ⇄ PENDING_INTERNAL → RESOLVED → CLOSED`; `RESOLVED → OPEN` (reopen ≤ 7 d).

## 11. Checkout session & cart

Checkout session: `OPEN → CONFIRMED | EXPIRED`. Cart: `ACTIVE → CONVERTED | EXPIRED | ABANDONED (replaced)`.

## 12. Coupon redemption

`RESERVED → REDEEMED | RELEASED`; `REDEEMED → RELEASED` only per BR-COUPON-006 (cancellation before acceptance or non-customer fault).

## 13. Payout

Batch: `DRAFT → APPROVED → PROCESSING → PAID | PARTIALLY_FAILED`. Line: `PENDING → PAID | FAILED → PENDING (retry)`.
