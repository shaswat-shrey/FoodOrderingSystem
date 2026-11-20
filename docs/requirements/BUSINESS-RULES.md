# SRS Section 18 — Business Rules Catalog

> Part of FOS-SRS-001 v0.4.0 (APPROVED 2026-11-20). Business rules are **policy**: they can change without changing the functional requirement that enforces them. Every numeric value marked ⚙ is a platform setting (`cfg.*`) or effective-dated config editable by authorized admins; values shown are the **defaults approved by the owner on 2026-11-20** (open decisions OD-02…OD-11 resolved with these defaults); values flagged for legal/tax review remain subject to that review. Each rule is testable; the test reference column in the Traceability Matrix maps rules to test cases.

---

## BR-AUTH — Identity & sessions

| ID | Rule |
|---|---|
| BR-AUTH-001 | **Password policy:** 8–128 characters; no composition rules (NIST SP 800-63B); must not appear in a breached-password list (k-anonymity check against a local top-100k list in MVP, HIBP range API optional); must not equal email/phone. Hash: Argon2id, m=19 MiB, t=2, p=1 (re-hash on login when parameters increase). |
| BR-AUTH-002 | A customer must have a verified phone before creating a checkout session; restaurant members and partners must have a verified phone before onboarding submission. |
| BR-AUTH-003 | **OTP policy:** 6 digits; TTL 5 min ⚙; max 5 verification attempts; resend cooldown 30 s; max 5 sends per destination per hour and 10 per IP per hour ⚙; new OTP invalidates prior one for the same destination+purpose. |
| BR-AUTH-004 | **Lockout & throttling:** after 5 consecutive failed logins for an account → 15-min lock ⚙ (doubling up to 24 h on repeat within 24 h); per-IP 20 failures/15 min → IP throttled for 15 min; registration 5/h/IP. Owner notified on lock. |
| BR-AUTH-005 | Max 10 active sessions per user per app ⚙; creating an 11th revokes the least-recently-active. |
| BR-AUTH-006 | **Token lifetimes:** access token 15 min; refresh/session absolute lifetime: customer & partner 30 d, restaurant 30 d, admin 12 h; idle timeout: customer & partner 14 d, restaurant 7 d, admin 1 h ⚙. |
| BR-AUTH-007 | Refresh-token concurrency grace window = 10 s ⚙. Reuse of a rotated token after the grace window revokes the entire session family. |
| BR-AUTH-008 | Email verification links valid 24 h; password reset links/OTP valid 30 min / 5 min; all single-use. |
| BR-AUTH-009 | Password reset and change revoke sessions as specified (reset: all; change: all others). |
| BR-AUTH-010 | **App–role compatibility:** customer app requires CUSTOMER; restaurant app requires an ACTIVE restaurant membership (or an onboarding application in progress — onboarding-only scope); delivery app requires DELIVERY_PARTNER (or partner application in progress — onboarding-only scope); admin app requires SUPPORT_AGENT, ADMIN or SUPER_ADMIN. |
| BR-AUTH-011 | Account deletion grace period 30 days ⚙ before irreversible anonymization. |
| BR-AUTH-012 | Suspended users cannot authenticate; suspension end date, if set, lifts automatically (JOB-USER-002). |
| BR-AUTH-013 | Deletion is blocked while the user has non-terminal orders, an active delivery, an unsettled positive/negative balance, open disputes, or sole ownership of an active restaurant. |
| BR-AUTH-014 | One account per phone number and per email (case-insensitive) among non-anonymized accounts. |
| BR-AUTH-015 | Registration conflicts are reported generically ("An account with these details may already exist — try signing in") without revealing which identifier matched. |
| BR-AUTH-016 | Credential changes (password reset) revoke all sessions; phone/email changes revoke all other sessions. |
| BR-AUTH-017 | Step-up re-authentication validity: 5 minutes ⚙. |
| BR-AUTH-018 | Admin-app accounts require MFA (TOTP) from CORE; until then email OTP second factor. |
| BR-AUTH-019 | Cookie-authenticated endpoints (`/auth/refresh`, `/auth/logout`) require `Origin` ∈ app allowlist and `X-Client-App` header; cookies are `SameSite=Strict`. |
| BR-AUTH-020 | Users must accept the current terms and privacy policy at registration; publishing a *material* new version requires re-acceptance at next sign-in before other actions. |

## BR-ADDR / BR-GEO — Addresses & serviceability

| ID | Rule |
|---|---|
| BR-ADDR-001 | Max 20 saved addresses per customer; at most one HOME and one WORK label. |
| BR-ADDR-002 | Every address must have map coordinates (pin); text alone is insufficient. |
| BR-GEO-001 | **Serviceable** = (a) location inside an ACTIVE zone, (b) branch in the same zone (or zone pair explicitly linked ⚙), (c) straight-line distance ≤ branch delivery radius, (d) road distance ≤ radius × 1.4 when a routing provider is available, (e) branch accepting orders (BR-REST-001). Discovery uses (a)–(c) + (e); checkout uses all. |
| BR-GEO-002 | Branch delivery radius 0.5–15 km; zone may cap it lower ⚙ (default 7 km). |
| BR-GEO-003 | Distance used for fees and partner pay = road distance from routing provider; fallback = haversine × 1.3 ⚙ road factor. |

## BR-REST — Restaurants & branches

| ID | Rule |
|---|---|
| BR-REST-001 | A branch **accepts orders** only if: restaurant APPROVED and ACTIVE; branch ACTIVE; current time within an operating slot and not in a holiday closure; not manually closed; not paused; FSSAI not expired (BR-REST-011); zone ACTIVE. |
| BR-REST-002 | Pause durations: 15, 30, 45, 60 min or "until I resume" (max 4 h ⚙, then auto-resume with notification). |
| BR-REST-003 | Max 3 operating slots per weekday; slots may cross midnight; slots on the same day must not overlap. |
| BR-REST-004 | **Last-order cutoff:** new orders are not accepted after `slot closing time − default prep time` (min 15 min before close). |
| BR-REST-005 | Required onboarding documents: FSSAI license (mandatory), PAN (mandatory), bank proof (mandatory), GST certificate (mandatory if GSTIN provided; restaurants without GSTIN must sign a declaration — legal review). |
| BR-REST-006 | **Go-live checklist:** approved, ≥ 1 active category with ≥ 3 available items, operating hours set, verified bank account, logo uploaded. |
| BR-REST-007 | Rejected applicants may re-apply after 30 days ⚙ unless admin allows earlier. |
| BR-REST-008 | Max 5 resubmissions per application before mandatory admin call. |
| BR-REST-009 | 3 consecutive acceptance timeouts ⚙ → branch auto-paused for 30 min ⚙ with SMS to owner/manager. |
| BR-REST-010 | FSSAI license number must be displayed on the restaurant page and invoices. |
| BR-REST-011 | Expired FSSAI → branch auto-paused until renewed document is verified. |
| BR-REST-012 | Changes to legal name, PAN, GSTIN, FSSAI, or bank details require admin verification; payouts are held while a bank change is pending. |
| BR-REST-013 | New branches require admin approval before accepting orders. |
| BR-REST-014 | Restaurants with rejection rate > 10 % or acceptance-timeout rate > 5 % over 7 days ⚙ are flagged for account-manager review (no automatic penalty in MVP). |
| BR-REST-015 | Restaurant-initiated cancellation after acceptance: customer fully refunded; restaurant bears the refund cost for food value and may incur a penalty fee ⚙ (default ₹0 in MVP, configurable). |

## BR-MENU — Menu

| ID | Rule |
|---|---|
| BR-MENU-001 | Every item and every customization option must have exactly one dietary marker (VEG, NON_VEG, EGG). An item marked VEG cannot have NON_VEG/EGG options attached (validation error). Pure-veg restaurants may only have VEG items. |
| BR-MENU-002 | Item price ₹1–₹1,00,000 (100–10,000,000 paise); prices in whole paise. |
| BR-MENU-003 | Customization group: 0 ≤ min ≤ max, max ≥ 1, max ≤ number of options; required ⇔ min ≥ 1. |
| BR-MENU-004 | If an item has variants, exactly one is default, and the variant price replaces the base price. |
| BR-MENU-005 | Discounted price must be lower than the price it discounts and ≥ ₹1. |
| BR-MENU-006 | Stock-tracked items decrement at order creation; stock is restored if the order is cancelled/rejected/failed **before** PREPARING; reaching 0 marks out of stock. |
| BR-MENU-007 | An item is orderable only if: not deleted, category active, not marked unavailable for the branch (or `unavailable_until` passed), within its schedule (CORE), stock > 0 when tracked, and the branch accepts orders. |
| BR-MENU-008 | A category can be deleted only when empty or with a target category for its items. |
| BR-MENU-009 | Combo components must belong to the same restaurant and be non-combo items. |

## BR-CART — Cart

| ID | Rule |
|---|---|
| BR-CART-001 | A cart contains items from exactly one branch. Adding from another branch requires the customer to explicitly discard the existing cart. |
| BR-CART-002 | Carts expire after 7 days of inactivity ⚙. |
| BR-CART-003 | Max 30 distinct lines, 50 total units, 20 units per line. |
| BR-CART-004 | Line identity = (item, variant, sorted option set, instructions); identical lines merge. |
| BR-CART-005 | Carts are revalidated on every read; invalid lines are flagged, never silently dropped or repriced. |
| BR-CART-006 | Cart and line instructions ≤ 250 characters, plain text (HTML stripped). |

## BR-PRICE — Pricing, fees, taxes

| ID | Rule |
|---|---|
| BR-PRICE-001 | **Order of computation:** (1) line prices with variant & options; (2) item-level discounts; (3) items subtotal; (4) automatic promotion; (5) coupon; (6) packaging; (7) delivery fee (then free-delivery benefits); (8) surge; (9) small-order fee; (10) platform fee; (11) taxes per component on post-discount bases; (12) tip; (13) wallet application; (14) payable. |
| BR-PRICE-002 | **Rounding:** all intermediate values are integer paise; percentage amounts computed as `floor(base × bps / 10000 + 0.5)` (half-up) once per component; taxes computed per component (not per line) to avoid accumulation error; no rounding to rupees except COD display. |
| BR-PRICE-003 | **Delivery fee slabs ⚙ (per zone):** 0–2 km ₹19, 2–4 km ₹29, 4–6 km ₹39, 6–8 km ₹49, > 8 km ₹49 + ₹8/km. |
| BR-PRICE-004 | **Small-order fee ⚙:** ₹15 when items subtotal after discounts < ₹149. |
| BR-PRICE-005 | **Platform fee ⚙:** ₹5 per order. |
| BR-PRICE-006 | **Packaging fee:** set by restaurant per item or per order, capped by admin ⚙ (₹10 per item, ₹50 per order). |
| BR-PRICE-007 | **Surge ⚙:** zone-level flat fee ≤ ₹40, time-boxed (max 3 h per activation), displayed to customers before checkout with reason (rain, high demand). |
| BR-PRICE-008 | **Tip:** ₹0–₹500, whole rupees; 100 % passed to the delivery partner; not subject to commission; not included in discount computations; refundable only if the order is cancelled before delivery. |
| BR-PRICE-009 | **Taxes ⚙ (legal/tax review required):** GST on restaurant food & packaging per tax rule (placeholder 5 %, collected by platform as e-commerce operator where applicable); GST on delivery, platform and small-order fees (placeholder 18 %). Tax lines show code, rate and base. |
| BR-PRICE-010 | Branch minimum order amount: ₹0–₹500 ⚙; applied to items subtotal after item discounts, before coupons. |
| BR-PRICE-011 | Maximum order amount: ₹10,000 platform cap ⚙ (branch may set lower); COD cap per BR-PAY-002. |
| BR-PRICE-012 | Free-delivery benefits (coupon or promotion) waive the base delivery fee only — not surge or small-order fees. |

## BR-COUPON / BR-PROMO — Discounts

| ID | Rule |
|---|---|
| BR-COUPON-001 | At most one coupon per order. |
| BR-COUPON-002 | Eligibility: active window, scope (zone/restaurant/branch), user segment, payment method restriction, minimum subtotal (after item discounts and promotion), per-user and global limits. |
| BR-COUPON-003 | Usage limits count RESERVED + REDEEMED redemptions. |
| BR-COUPON-004 | Percentage coupons must have a max discount cap; the discount never exceeds the eligible subtotal; free-delivery coupons follow BR-PRICE-012. |
| BR-COUPON-005 | A coupon stacks with an automatic promotion only if the coupon is `stackable`; otherwise the system applies whichever gives the customer the larger discount and explains it. At most one automatic promotion applies per order (the best one). |
| BR-COUPON-006 | Redemption lifecycle: RESERVED at order creation → REDEEMED at T02/T03 → RELEASED on T04/T05 and on cancellation/rejection before acceptance (the coupon becomes usable again if still valid). After acceptance, a cancelled order's coupon is RELEASED only if fault ≠ CUSTOMER. |
| BR-COUPON-007 | "New user" = customer with zero DELIVERED orders and no previous redemption of a new-user coupon (also checked by phone number & device fingerprint heuristics — CORE). |
| BR-COUPON-008 | Validity is evaluated at checkout-session creation **and** at order confirmation; expiry in between fails confirmation. |
| BR-COUPON-009 | Coupon discount terms are immutable once any redemption exists; changes require a new coupon. |
| BR-PROMO-001 | Restaurant promotions with > 50 % discount or with no cap require admin approval. |

## BR-ORDER — Orders & cancellations

| ID | Rule |
|---|---|
| BR-ORDER-001 | Checkout session TTL 10 min ⚙; order confirmation requires an OPEN, unexpired session. |
| BR-ORDER-002 | Order creation requires `Idempotency-Key`; idempotency records retained 24 h. |
| BR-ORDER-003 | PAYMENT_PENDING TTL 15 min ⚙; then FAILED (`PAYMENT_EXPIRED`). |
| BR-ORDER-004 | Restaurant acceptance timeout 5 min ⚙ with reminders at 2 min (push + SMS) and 4 min (sound escalation); timeout → CANCELLED (fault RESTAURANT). |
| BR-ORDER-005 | Prep time per order 5–90 min; restaurant may extend once by ≤ 20 min. |
| BR-ORDER-006 | Address changes after placement only via support, before pickup, ≤ 500 m from the original pin, still serviceable; no fee recalculation. |
| BR-ORDER-010 | **Customer cancellation before acceptance** (PAYMENT_PENDING, PLACED): free, full refund. |
| BR-ORDER-011 | **Customer cancellation in ACCEPTED** ⚙: allowed within 60 s of acceptance free of charge; after 60 s, fee = 50 % of food value (items subtotal after discounts), refund the rest. |
| BR-ORDER-012 | **Customer cancellation in PREPARING** ⚙: allowed with fee = 100 % of food value + packaging (customer refunded delivery fee, platform fee, tip). |
| BR-ORDER-013 | **No customer self-cancellation** in READY_FOR_PICKUP, PICKED_UP — support may cancel/fail with fault attribution. |
| BR-ORDER-014 | Restaurant rejection requires a reason code; ITEM_UNAVAILABLE requires the item IDs. |
| BR-ORDER-015 | Restaurant cancellation after acceptance requires OWNER/MANAGER, a reason, and confirmation; full refund to customer (BR-REST-015). |
| BR-ORDER-016 | Admin/system cancellations must specify fault; refunds and compensations follow BR-REFUND-001. |
| BR-ORDER-017 | Order content (items, branch, payment method) is immutable after creation. |
| BR-ORDER-018 | Reorder uses current menu, current prices and current availability. |
| BR-ORDER-019 | Invoices are issued only for DELIVERED orders; numbering sequential per issuer series per financial year (April–March); legal review for e-commerce operator invoicing obligations. |
| BR-ORDER-020 | **Customer unreachable:** partner waits 10 min ⚙ at the drop location with ≥ 2 logged call attempts; then support marks FAILED (CUSTOMER_UNREACHABLE): prepaid → no refund (except tip refunded); COD → customer COD strike +1. |
| BR-ORDER-021 | Orders cancelled for restaurant/platform fault may grant the customer an apology coupon ⚙ (default off). |
| BR-ORDER-022 | (CORE) Delivery later than ETA max + 15 min ⚙ due to platform/partner fault grants a wallet credit of 10 % of food value (max ₹50) ⚙. |

## BR-PAY — Payments

| ID | Rule |
|---|---|
| BR-PAY-001 | Enabled payment methods per zone ⚙; online methods via the configured provider. |
| BR-PAY-002 | **COD eligibility ⚙:** order payable ≤ ₹1,500; customer not COD-blocked (≥ 2 COD refusals/failed deliveries in 90 days → blocked); customer has ≥ 0 delivered orders (no restriction for new users in MVP — risk accepted; revisit); restaurant has COD enabled; zone allows COD. |
| BR-PAY-003 | Payment success is determined only by server-side verification with the provider (signature + API fetch or verified webhook) — never by client assertion. |
| BR-PAY-004 | Each provider webhook event is processed at most once (dedupe on event ID). |
| BR-PAY-005 | Captures received for terminal (FAILED/CANCELLED) or unknown orders are refunded in full automatically. |
| BR-PAY-006 | Max 5 payment attempts per order. |
| BR-PAY-007 | Wallet credits are applied before online payment when the customer opts in; wallet cannot be combined with COD in MVP. |

## BR-REFUND — Refunds

| ID | Rule |
|---|---|
| BR-REFUND-001 | **Refund matrix:** <br>• Rejected / acceptance timeout / restaurant-cancelled / platform-cancelled (no partner, zone suspension) → 100 % of amount paid (incl. tip). <br>• Customer-cancelled → amount paid − cancellation fee (BR-ORDER-010..012); tip always refunded. <br>• Payment expired with late capture → 100 %. <br>• Delivery failed: customer unreachable → 0 % (tip refunded); partner/platform fault (accident, lost order) → 100 %. <br>• Post-delivery item issue → value of affected items (+ proportional taxes & packaging), approved per BR-REFUND-006. |
| BR-REFUND-002 | Total refunds ≤ amount captured (online) + wallet applied for the order. |
| BR-REFUND-003 | Default destination = original method; wallet credit if customer chooses (instant) or provider refund fails permanently after retries. COD orders: wallet credit. |
| BR-REFUND-004 | Support agents may refund up to ₹500 per order ⚙ without approval; above requires admin approval. |
| BR-REFUND-005 | Customer-facing refund SLA statement: "5–7 business days to original method; instant to wallet". |
| BR-REFUND-006 | **Auto-approval (CORE):** item-issue refund requests ≤ ₹250 ⚙ from customers with < 3 approved issue refunds in 90 days and account age ≥ 30 days are auto-approved to wallet; others go to support. |
| BR-REFUND-007 | Cost attribution: restaurant-fault refunds are recovered from restaurant settlement; partner-fault refunds are not auto-deducted from partner earnings (requires dispute review); platform-fault refunds are platform expense. |

## BR-COMM / BR-SETTLE — Commission & settlement

| ID | Rule |
|---|---|
| BR-COMM-001 | Commission = rate ⚙ (default 20 %) × (items subtotal + packaging − restaurant-funded discounts). Rate snapshot stored on order at creation. |
| BR-COMM-002 | Commission is earned only on DELIVERED orders, and on customer-cancelled orders where the restaurant receives a cancellation fee (commission applies to the fee). |
| BR-COMM-003 | Restaurant net payable per order = food value + packaging − restaurant-funded discounts − commission − GST on commission (as applicable) − taxes withheld per law (TCS/TDS — legal review) ± adjustments. |
| BR-SETTLE-001 | Settlement period Monday 00:00 – Sunday 23:59 IST; payout initiated by Wednesday ⚙. |

## BR-DEL — Delivery & dispatch

| ID | Rule |
|---|---|
| BR-DEL-001 | **Partner eligibility for an offer:** approved & ACTIVE; ONLINE_IDLE; location fresh ≤ 60 s, accuracy ≤ 100 m; inside branch's zone; vehicle compatible with trip distance (BR-DEL-017); COD: cash-in-hand + COD amount ≤ cap; not excluded for this delivery; no open offer; active deliveries < max (MVP 1). |
| BR-DEL-002 | Offer timeout 30 s ⚙ (server-authoritative). |
| BR-DEL-003 | Dispatch rounds 3 km / 5 km / 8 km ⚙, ≤ 5 offers per round; escalation after round 3; re-search every 60 s; no-partner cancellation at readyAt + 30 min ⚙ (or accepted + 45 min if never ready); ops may extend once by 15 min. |
| BR-DEL-004 | A partner who rejected, ignored, or was released from a delivery is not offered it again (expired-offer partners eligible after 5 min cooldown only when escalated). |
| BR-DEL-005 | Acceptance rate (30 d) = accepted / (accepted + rejected + expired); displayed to partner; used in ranking. |
| BR-DEL-006 | Auto-offline: 3 consecutive expired offers; no location/heartbeat for 5 min while ONLINE_IDLE; outside all zones > 10 min. Offline requests during an active delivery take effect after completion. |
| BR-DEL-007 | Dispatch timing per FR-DISP-001 (lead buffer 5 min ⚙). |
| BR-DEL-008 | **Geofences ⚙:** arrival at restaurant ≤ 200 m; arrival at customer ≤ 150 m; outside → allowed with confirmation, flagged for review. Pickup requires order READY_FOR_PICKUP or restaurant handover confirmation; pickup-code verification when `cfg.pickup.verifyCode` is on. |
| BR-DEL-009 | **Delivery proof:** OTP (4 digits, 5 attempts) for all orders; contactless prepaid orders use photo proof instead; COD orders always require OTP and cash confirmation; admin override requires evidence note. |
| BR-DEL-010 | **COD cash:** partner cash-in-hand cap ₹3,000 ⚙; above cap → no COD offers; remittance within 48 h ⚙ or deducted from next payout; partner must collect exact payable (no partial). |
| BR-DEL-011 | Location update cadence: ON_DELIVERY 5 s (moved > 10 m) / 15 s heartbeat; ONLINE_IDLE 30 s; none when OFFLINE. |
| BR-DEL-012 | **Location privacy:** customers see partner location only from assignment to delivery completion; restaurants see partner ETA/distance only (no live map) for their orders; partner trails visible to admins with `partner:location` (access logged). |
| BR-DEL-013 | Partner unassign after accept (before pickup): counted as a cancellation; > 3 per week ⚙ → review; abandonment (heartbeat loss) → flagged. |
| BR-DEL-014 | One delivery per order; one active delivery per partner (MVP). |
| BR-DEL-015 | Spoofing indicators (implied speed > 150 km/h, mock-location flag where detectable, repeated identical coordinates while "moving") flag the partner for review; no automatic suspension in MVP. |
| BR-DEL-016 | Partners must be ≥ 18 years old; motorized vehicles require a valid driving license and RC; insurance required for motorized vehicles. |
| BR-DEL-017 | Bicycles/e-bikes: offered only trips with pickup distance ≤ 3 km and drop distance ≤ 4 km ⚙. |

## BR-EARN — Partner earnings & payouts

| ID | Rule |
|---|---|
| BR-EARN-001 | **Per-delivery pay ⚙:** base ₹25 + ₹6/km for road distance (pickup → drop) beyond 2 km + ₹1/min waiting at restaurant beyond 10 min (cap ₹30) + zone surge/rain bonus ₹10–₹30. |
| BR-EARN-002 | Tips are passed 100 % to the partner and shown separately. |
| BR-EARN-003 | Incentive programs define eligibility windows, targets, rewards; credited at period end only if partner's completion rate ≥ 90 % and no fraud flags. |
| BR-EARN-004 | Partner payouts weekly (Monday–Sunday) ⚙; same calendar as restaurants. |
| BR-EARN-005 | Minimum payout ₹100 ⚙; smaller balances roll over. |
| BR-EARN-006 | Payout amount = earnings − unremitted cash-in-hand − approved deductions; if negative, the balance carries over and partner is notified. |
| BR-EARN-007 | **Compensation on cancellation:** if an order is cancelled after the partner accepted and the cancellation is not partner fault: partner receives base pay + distance travelled toward restaurant pay ⚙ (min ₹15). If cancelled after pickup (not partner fault): full trip pay. |

## BR-REVIEW — Reviews

| ID | Rule |
|---|---|
| BR-REVIEW-001 | Only the ordering customer may review, only after DELIVERED, within 7 days ⚙. |
| BR-REVIEW-002 | One review per order per target (restaurant, partner, each item). |
| BR-REVIEW-003 | Reviews editable within 48 h; deletable any time (soft). |
| BR-REVIEW-004 | Text is moderated: profanity filter on submit (masking), PII patterns (phone numbers) removed; reported reviews hidden after 3 independent reports pending moderation ⚙. |
| BR-REVIEW-005 | One public restaurant response per review; editable 24 h. |
| BR-REVIEW-006 | Partner ratings: partners see averages and tag counts only, never customer identity or per-order rating. |
| BR-REVIEW-007 | Restaurant rating displayed = Bayesian average with prior mean 4.0 and weight 10 ⚙; "New" badge until 10 ratings. |

## BR-WALLET — Customer wallet

| ID | Rule |
|---|---|
| BR-WALLET-001 | Closed-loop: credits usable only for orders on the platform; no top-ups, no withdrawals, no P2P transfer (OD-10; legal review re: RBI PPI). |
| BR-WALLET-002 | Refund credits never expire ⚙ (or 1 year — legal review); promotional/goodwill credits expire per grant (default 30 days). |
| BR-WALLET-003 | Consumption order: earliest-expiring lots first. |
| BR-WALLET-004 | Wallet adjustments by admins > ₹500 require maker-checker (CORE). |

## BR-NOTIF — Notifications

| ID | Rule |
|---|---|
| BR-NOTIF-001 | Transactional notifications (OTP, order status, payment, refund, security alerts, delivery offers) cannot be disabled; users may disable channels for promotional and recommendation categories only. |
| BR-NOTIF-002 | Promotional push/SMS: max 1 per day per user ⚙, never 22:00–08:00 local time; email max 3/week. |
| BR-NOTIF-003 | SMS used only for OTP, critical order events (restaurant reminder, order cancelled, out for delivery when push unavailable) to control cost. |

## BR-SUP — Support

| ID | Rule |
|---|---|
| BR-SUP-001 | Ticket SLA ⚙: first response — URGENT (active order) 5 min, HIGH 1 h, NORMAL 24 h; resolution targets 1 h / 24 h / 72 h. |
| BR-SUP-002 | Post-delivery issue reports accepted within 48 h ⚙ of delivery. |
| BR-SUP-003 | Resolved tickets can be reopened within 7 days; then closed permanently. |
| BR-SUP-004 | Max 5 customer-created tickets per day ⚙. |

## BR-ADMIN — Administrative controls

| ID | Rule |
|---|---|
| BR-ADMIN-001 | Admins cannot modify their own roles, approve their own maker-checker requests, or refund their own orders. |
| BR-ADMIN-002 | **Mandatory audit:** all admin mutations; all authentication security events (login success/failure summary, lockouts, reuse detection, MFA changes); role/permission changes; PII reveals; document views; config changes; financial operations (refunds, adjustments, payouts, commission, fees, taxes); order overrides; partner location trail views; data exports. |
| BR-ADMIN-003 | Maker-checker (CORE) applies to: fee/tax/commission/pay-plan changes, wallet/earning adjustments > ₹500/₹1,000, refunds above approval limit, payout batch approval. |
| BR-ADMIN-004 | Super admin role may be granted only by another super admin; at least 2 super admins must exist; the last super admin cannot be removed. |

## BR-FILE — Files

| ID | Rule |
|---|---|
| BR-FILE-001 | Allowed types/sizes: images (JPEG, PNG, WebP) ≤ 5 MB for avatars/food/logos/covers/proofs (≤ 10 MB covers); documents (PDF, JPEG, PNG) ≤ 10 MB; support attachments ≤ 5 MB, max 3 per message. SVG not accepted (XSS risk). |
