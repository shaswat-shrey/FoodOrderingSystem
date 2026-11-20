# SRS Section 23 — Acceptance Criteria

> Part of FOS-SRS-001 v0.8.0 (APPROVED 2026-11-20). Criteria are written as verifiable statements (Given/When/Then where useful). A module is accepted when all its P0 criteria pass in automated tests (unit/integration/E2E as indicated: **U**, **I**, **E**) in CI and are demonstrated in staging.

## AC-AUTH — Authentication & sessions

| ID | Criterion | Test level | Traces |
|---|---|---|---|
| AC-AUTH-001 | A guest can register with phone OTP; a user row (ACTIVE, phone verified), a session, and a hashed refresh token exist; the refresh cookie is HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth. | I, E | FR-AUTH-002, 020 |
| AC-AUTH-002 | A user can register with email+password; the password is stored as Argon2id; plaintext never appears in DB or logs (log capture assertion). | I | FR-AUTH-001, NFR-SEC-014 |
| AC-AUTH-003 | Login with wrong password and login with unknown identifier return identical status, body and statistically indistinguishable timing (±20 %). | I | FR-AUTH-003 |
| AC-AUTH-004 | After 5 failed logins the account is locked for 15 min; a correct password during lock still fails; owner receives lock notification. | I | BR-AUTH-004 |
| AC-AUTH-005 | Refresh returns a new access token and a new refresh token; the previous refresh token is ROTATED; exactly one ACTIVE token exists for the session. | I | FR-AUTH-022 |
| AC-AUTH-006 | Presenting a rotated refresh token > 10 s after rotation revokes the session; subsequent refresh with the newest token fails with 401; the user receives a security notification. | I | FR-AUTH-022 |
| AC-AUTH-007 | Two concurrent refreshes with the same token result in one success and one `AUTH_REFRESH_RACE`, and the session remains active. | I | FR-AUTH-022 |
| AC-AUTH-008 | A revoked session cannot refresh; its access token is rejected within 30 s on REST and its sockets disconnect within 5 s. | I | FR-AUTH-005, 021, FR-RT-004 |
| AC-AUTH-009 | Logout-all revokes every session of the user; other devices are forced to log in. | I, E | FR-AUTH-006 |
| AC-AUTH-010 | A user can list sessions and revoke one; revoking another user's session ID returns 404. | I | FR-AUTH-007 |
| AC-AUTH-011 | OTP: expires after 5 min; invalid after 5 wrong attempts; single use; resend within 30 s rejected; OTP value never present in API responses or logs. | U, I | FR-AUTH-010 |
| AC-AUTH-012 | Password reset responds identically for existing and non-existing identifiers; successful reset revokes all sessions. | I | FR-AUTH-011, 012 |
| AC-AUTH-013 | A suspended user cannot log in or refresh; an admin can lift suspension; actions are audit-logged. | I | FR-AUTH-040 |
| AC-AUTH-014 | Account deletion is blocked with an active order; otherwise user becomes DEACTIVATED and is anonymized after the grace period (job test with clock control); orders remain with anonymized references. | I | FR-AUTH-041 |
| AC-AUTH-015 | A token for app A (aud) is rejected by app B's namespace/endpoints that check `aud`. | I | FR-AUTH-020, FR-RT-001 |

## AC-RBAC — Authorization

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-RBAC-001 | An authorization matrix test enumerates every route × role and asserts allow/deny exactly as the permission catalog defines. | I | NFR-SEC-003 |
| AC-RBAC-002 | Customer A requesting customer B's order, address, payment, or tracking returns 404. | I | DC-02 |
| AC-RBAC-003 | A restaurant member scoped to branch X cannot read or act on orders of branch Y of the same restaurant, nor any branch of another restaurant. | I | FR-RSTAFF-002 |
| AC-RBAC-004 | KITCHEN role responses contain no prices, customer names, phones or addresses. | I | FR-RORD-010 |
| AC-RBAC-005 | A partner cannot read deliveries not assigned to them; after release, the previously assigned partner loses access to customer details. | I | BR-DEL-012 |
| AC-RBAC-006 | Removing a member's role takes effect within 30 s (permission version bump) without requiring logout. | I | FR-AUTH-024 |

## AC-DISC — Location & discovery

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-DISC-001 | Customer can select a location by detection, search, or map pin; the pin coordinates are used for discovery. | E | FR-LOC-001..004 |
| AC-DISC-002 | Given branches inside and outside radius/zone, only serviceable ones are returned (fixture with known coordinates). | I | FR-DISC-001, BR-GEO-001 |
| AC-DISC-003 | Closed/paused branches appear only in the trailing "closed" group with `opensAt`, or not at all when `openNow=true`. | I | FR-DISC-001 |
| AC-DISC-004 | Each filter and sort option produces correct results on fixtures; pagination returns stable, non-duplicated results across pages. | I | FR-DISC-002..004 |
| AC-DISC-005 | Veg-only mode hides NON_VEG and EGG items everywhere (discovery, menu, search). | I, E | FR-DISC-008 |
| AC-DISC-006 | Discovery p95 ≤ 500 ms with 500 branches seeded under normal load test. | Perf | NFR-PERF-003 |
| AC-DISC-007 | Search "biriyani" returns "Biryani" items (typo tolerance) (CORE). | I | FR-SRCH-003 |

## AC-MENU — Menus

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-MENU-001 | Restaurant can create categories, items with variants and customization groups; customer menu reflects changes within 5 s. | I, E | FR-MENU-001..007, FR-MENUC-008 |
| AC-MENU-002 | Attaching a NON_VEG option to a VEG item is rejected. | U | BR-MENU-001 |
| AC-MENU-003 | Marking an item out of stock makes it non-addable and flags it in existing carts; auto-restore at `until` time. | I | FR-MENU-008 |
| AC-MENU-004 | Changing an item price does not change any existing order's stored prices or invoice. | I | DB §15.6 |

## AC-CART — Cart

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-CART-001 | Adding an item from a different branch returns `CART_BRANCH_CONFLICT`; with `replaceCart=true` the old cart is cleared atomically. | I, E | BR-CART-001 |
| AC-CART-002 | Customization min/max/required rules are enforced with per-group error details. | U, I | FR-CART-001 |
| AC-CART-003 | Identical configurations merge; different option sets create separate lines. | U | BR-CART-004 |
| AC-CART-004 | Cart persists across devices for the same user and expires after 7 days inactivity. | I | FR-CART-012 |

## AC-PRICE — Pricing & coupons

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-PRICE-001 | Pricing engine produces expected breakdowns for ≥ 40 table-driven scenarios (fees, slabs, small-order fee, coupons of each type, caps, promotions, stacking, taxes, tips, wallet) with exact paise values. | U | FR-PRICE-001, BR-PRICE-* |
| AC-PRICE-002 | Property test: total = Σ components; no component negative except discounts; discounts never exceed eligible base; result deterministic. | U | FR-PRICE-001 |
| AC-PRICE-003 | Any client-supplied price/total field is rejected by validation. | I | FR-PRICE-002 |
| AC-PRICE-004 | Coupon usage limit under 50 concurrent order attempts never exceeds the limit. | I | FR-COUP-004 |
| AC-PRICE-005 | Coupon expiring between quote and confirmation causes `COUPON_EXPIRED` and no order. | I | FR-COUP-005 |

## AC-ORDER — Checkout & orders

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-ORDER-001 | Customer can place a valid COD order; order PLACED, restaurant receives `order.new` in < 2 s. | E | FR-CHK-002, EVT-REST-001 |
| AC-ORDER-002 | Server recomputes pricing; a stale `expectedPayable` yields `PRICE_CHANGED` and no order. | I | FR-CHK-002 |
| AC-ORDER-003 | Order is created only if all validations pass (each validation has a negative test: closed branch, unavailable item, not serviceable, below minimum, COD ineligible, insufficient wallet). | I | FR-ORDER-001 |
| AC-ORDER-004 | 10 concurrent confirm requests with the same idempotency key create exactly one order and all receive the same order ID. | I | FR-ORDER-002 |
| AC-ORDER-005 | Every transition in the table T01–T16 is tested; every non-listed transition returns `ORDER_INVALID_TRANSITION` (generated exhaustive test over the state×event matrix). | U | §10.3 |
| AC-ORDER-006 | No API accepts an arbitrary `status` value from clients (schema review + test). | I | §10.3 |
| AC-ORDER-007 | Order history snapshots render correctly after the item is deleted and prices change. | I | DB §15.6 |
| AC-ORDER-008 | Cancellation preview equals the actual fee/refund applied; stale quote rejected. | I | FR-ORDER-020 |
| AC-ORDER-009 | Acceptance timeout cancels the order, refunds, and the 3rd consecutive timeout auto-pauses the branch (clock-controlled job tests). | I | BR-ORDER-004, BR-REST-009 |
| AC-ORDER-010 | Stuck-order sweeper re-creates missing timers after Redis flush. | I | JOB-ORD-007 |

## AC-PAY — Payments & refunds

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-PAY-001 | Online payment flow with MockProvider succeeds end-to-end; order moves to PLACED only after server verification. | E | FR-PAY-003 |
| AC-PAY-002 | A forged client callback (bad signature) does not mark payment success. | I | FR-PAY-003 |
| AC-PAY-003 | Webhook with invalid signature → 401, nothing stored as valid; duplicate valid webhook processed once. | I | FR-PAY-004 |
| AC-PAY-004 | Out-of-order webhooks (failed after captured) never downgrade a captured payment. | U, I | FR-PAY-009 |
| AC-PAY-005 | Late capture after order expiry triggers an automatic full refund. | I | BR-PAY-005 |
| AC-PAY-006 | Refund sum can never exceed captured amount, including under concurrent refund requests. | I | FR-REFUND-003 |
| AC-PAY-007 | Every financial operation produces balanced ledger transactions; nightly integrity check passes on the test dataset. | I | FR-RECON-003 |
| AC-PAY-008 | Partial refund for 1 of 3 items computes item value + proportional tax/packaging and reaches SUCCEEDED via webhook. | I | FR-REFUND-003 |

## AC-REST — Restaurant operations

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-REST-001 | Restaurant onboarding → admin approval → go-live checklist → branch opens → appears in discovery. | E | WF-05, WF-06 |
| AC-REST-002 | Restaurant receives orders in real time with audible alert; falls back to 15 s polling when socket disconnected. | E | FR-RORD-001, FR-RT-022 |
| AC-REST-003 | Accept/reject/preparing/ready transitions work; invalid transitions are prevented; concurrent accept yields one success. | I, E | FR-RORD-002..006, E24 |
| AC-REST-004 | Pause/close makes the branch non-orderable immediately; auto-resume at expiry. | I | FR-REST-014, 015 |
| AC-REST-005 | Dashboard numbers equal sums computed directly from orders for a seeded dataset. | I | FR-RANL-001 |

## AC-DEL — Delivery

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-DEL-001 | Partner can go online only when eligible; each blocker returns its reason. | I | FR-DP-010 |
| AC-DEL-002 | Offers go only to eligible partners (offline, paused, stale-location, over-cash-cap, excluded partners never receive offers). | I | BR-DEL-001 |
| AC-DEL-003 | Two partners accepting the same delivery concurrently (simulated by forcing two offers) → exactly one assignment. | I | FR-DISP-006 |
| AC-DEL-004 | Rejected/expired partner never receives the same delivery again (non-escalated). | I | FR-DISP-008 |
| AC-DEL-005 | With no eligible partners, the delivery escalates, ops alert fires, and the order is cancelled + refunded at the deadline. | I | FR-DISP-009/010 |
| AC-DEL-006 | Pickup requires READY_FOR_PICKUP or restaurant handover; delivery completion requires valid OTP (or photo for contactless prepaid). | I | BR-DEL-008/009 |
| AC-DEL-007 | Customer tracking receives location updates at ≤ 3 s intervals during delivery and none before assignment/after completion. | I, E | FR-TRK-006, BR-DEL-012 |
| AC-DEL-008 | Earnings computed per pay plan for fixture trips; tips credited 100 %. | U | BR-EARN-001/002 |
| AC-DEL-009 | Partner heartbeat loss during an assigned delivery → ops alert at 3 min, auto-reassignment at 5 min. | I | FR-DISP-014 |

## AC-RT — Real-time

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-RT-001 | Socket connection without valid token is refused; with token for another app is refused. | I | FR-RT-001/002 |
| AC-RT-002 | Subscribing to another customer's order returns FORBIDDEN and emits nothing to that socket. | I | FR-RT-010 |
| AC-RT-003 | Events arrive in commit order per aggregate; duplicate events are ignored by the client store. | U, I | FR-RT-023..025 |
| AC-RT-004 | After reconnect, client state matches REST snapshot. | E | FR-RT-020 |

## AC-ADMIN — Administration

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-ADMIN-001 | Every admin mutation creates an audit entry with reason where required; audit rows cannot be updated/deleted by the app DB role. | I | FR-AUDIT-001/002 |
| AC-ADMIN-002 | Admin order cancellation with fault attribution produces the refund dictated by BR-REFUND-001. | I | FR-ADMIN-041 |
| AC-ADMIN-003 | Support agent refund above limit creates a pending approval instead of executing. | I | FR-REFUND-008 |
| AC-ADMIN-004 | Fee/tax config changes are effective-dated; orders keep the config version they were priced with. | I | FR-CFG-002 |
| AC-ADMIN-005 | PII is masked in admin views until revealed with reason; reveal is audited. | I, E | FR-ADMIN-010 |

## AC-NFR — Cross-cutting

| ID | Criterion | Level | Traces |
|---|---|---|---|
| AC-NFR-001 | Load test at peak profile meets NFR-PERF-001..009 targets in staging. | Perf | NFR-PERF |
| AC-NFR-002 | axe-core: zero serious/critical violations on key pages of each app. | E | NFR-ACCESS-007 |
| AC-NFR-003 | Logs contain no passwords, tokens, OTPs, or full phone numbers (automated log scan in integration suite). | I | NFR-SEC-014 |
| AC-NFR-004 | Redis outage simulation: login/refresh continue (DB fallback), orders can be placed, dispatch pauses with alert, recovery drains outbox. | I (chaos) | NFR-AVAIL-004 |
| AC-NFR-005 | Restore drill recovers DB to a point in time within RTO with ledger invariants intact. | Ops | NFR-BACKUP-005 |

## End-to-end acceptance scenarios (from master prompt §23)

| ID | Scenario | Steps |
|---|---|---|
| AC-E2E-001 | **Customer happy path** | Register → login → set location → discover → open restaurant → customize & add → cart → coupon → checkout → pay (mock UPI) → restaurant accepts → preparing → partner assigned → ready → pickup → live tracking → OTP delivery → review. |
| AC-E2E-002 | **Restaurant flow** | Login → receive order (sound) → accept → preparing → ready → handover to partner → completed in history & dashboard. |
| AC-E2E-003 | **Delivery flow** | Login → go online → receive offer → accept → arrive restaurant → pick up → arrive customer → OTP → delivered → earnings updated. |
| AC-E2E-004 | **Failure: payment failure & retry** | Payment fails → retry succeeds → order placed once. |
| AC-E2E-005 | **Failure: restaurant rejects** | Rejection → customer notified → refund created. |
| AC-E2E-006 | **Failure: partner rejects then another accepts** | Rejection → next partner offered → assignment. |
| AC-E2E-007 | **Failure: customer cancels with fee** | Cancel during ACCEPTED after 60 s → fee preview → partial refund. |
| AC-E2E-008 | **Failure: no partner** | All partners offline → escalation → cancellation at deadline → refund. |
| AC-E2E-009 | **Security: session theft** | Refresh token replay → session revoked on all tabs. |
