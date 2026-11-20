# Domain Events, Notification Matrix & Background Job Inventory

> Phase 1 · v0.7.0 (APPROVED 2026-11-20). Real-time (socket) events are specified in SRS §13.5; this document covers internal domain events, the notification matrix, and BullMQ jobs.

## 1. Domain events (outbox)

| Event | Producer | Consumers (module → reaction) |
|---|---|---|
| `UserRegistered` | auth | notifications (welcome), analytics |
| `SessionRevoked` | auth | realtime (disconnect), notifications (security alert if reuse) |
| `RestaurantSubmitted` / `RestaurantApproved` / `RestaurantRejected` | restaurants | notifications, realtime (admin badge), iam (grant role on approval) |
| `BranchStatusChanged` | restaurants | realtime, discovery cache invalidation |
| `MenuChanged` | menu | cache invalidation (menu version), search index refresh (generated columns — none needed), realtime |
| `OrderCreated` | orders | notifications, analytics |
| `OrderPlaced` | orders | realtime (restaurant), notifications, jobs (acceptance timeout), analytics |
| `OrderAccepted` | orders | dispatch (create delivery & schedule), notifications, realtime, jobs |
| `OrderPreparing` / `OrderReady` | orders | realtime, notifications, dispatch (priority bump on ready) |
| `OrderPickedUp` | orders | tracking (ETA), notifications, realtime |
| `OrderDelivered` | orders | earnings, settlements (ledger), reviews (prompt job), analytics, notifications |
| `OrderCancelled` / `OrderRejected` / `OrderFailed` | orders | refunds, coupons (release), menu (stock restore), dispatch (withdraw), earnings (compensation), notifications, realtime |
| `PaymentCaptured` / `PaymentFailed` / `PaymentExpired` | payments | orders (transition), notifications, analytics |
| `RefundSucceeded` / `RefundFailed` | refunds | orders (refund_status), notifications, wallet fallback |
| `DeliveryCreated` / `DeliverySearching` / `DeliveryEscalated` | dispatch | jobs, ops alerts |
| `OfferCreated` / `OfferExpired` / `OfferWithdrawn` | dispatch | realtime (partner), notifications (push), jobs |
| `PartnerAssigned` / `PartnerUnassigned` | dispatch | realtime (customer, restaurant), notifications, tracking |
| `DeliveryStageChanged` | deliveries | realtime, notifications, tracking |
| `PartnerAvailabilityChanged` | delivery-partners | dispatch (candidate pool), realtime (admin) |
| `ReviewPublished` | reviews | rating aggregation job, notifications (low rating to restaurant) |
| `TicketCreated` / `TicketUpdated` | support | notifications, realtime (admin queue) |
| `SettingChanged` / `FlagChanged` | config | cache invalidation pub/sub |

## 2. Notification matrix (MVP)

Channels: **IA** in-app, **WS** socket, **PU** web push, **SMS**, **EM** email. ✔ = sent, ◐ = fallback only (when push unavailable / not subscribed).

| Event | Recipient | IA | WS | PU | SMS | EM | Transactional |
|---|---|---|---|---|---|---|---|
| OTP | User | — | — | — | ✔ | (email OTP admins) | Yes |
| Registration welcome | Customer | ✔ | — | — | — | ✔ (if email) | No |
| Email verification / password reset | User | — | — | — | (reset OTP) | ✔ | Yes |
| Security alert (new device, reuse detected, password changed, lock) | User | ✔ | — | ✔ | ✔ (reuse/lock) | ✔ | Yes |
| Restaurant approved / rejected / changes requested | Owner | ✔ | ✔ | ✔ | ✔ | ✔ | Yes |
| New order | Restaurant members | ✔ | ✔ | ✔ | ◐ reminder at 2 min | — | Yes |
| Order accepted / preparing / ready | Customer | ✔ | ✔ | ✔ (accepted, ready optional) | — | — | Yes |
| Order rejected / cancelled | Customer | ✔ | ✔ | ✔ | ✔ | ✔ | Yes |
| Order cancelled | Restaurant / partner | ✔ | ✔ | ✔ | — | — | Yes |
| Partner assigned | Customer, restaurant | ✔ | ✔ | ✔ | — | — | Yes |
| Partner arriving at restaurant | Restaurant | — | ✔ | ✔ | — | — | Yes |
| Order picked up / out for delivery | Customer | ✔ | ✔ | ✔ | ◐ | — | Yes |
| Partner arrived | Customer | ✔ | ✔ | ✔ | ◐ | — | Yes |
| Delivered | Customer | ✔ | ✔ | ✔ | — | ✔ (receipt) | Yes |
| Payment success / failure | Customer | ✔ | ✔ | ✔ (failure) | — | ✔ (success receipt) | Yes |
| Refund initiated / succeeded | Customer | ✔ | ✔ | ✔ | ✔ (succeeded) | ✔ | Yes |
| Delivery offer | Partner | — | ✔ | ✔ | — | — | Yes |
| Offer expired / withdrawn | Partner | — | ✔ | — | — | — | Yes |
| Payout paid | Restaurant / partner | ✔ | — | ✔ | ✔ | ✔ | Yes |
| Document expiring | Owner / partner | ✔ | — | ✔ | ✔ | ✔ | Yes |
| Low rating received | Restaurant | ✔ | ✔ | — | — | — | No |
| Support response | Requester | ✔ | ✔ | ✔ | — | ✔ | Yes |
| Promotional offer | Customer (opted in) | ✔ | — | ✔ | ✔ | ✔ | No |
| Review prompt | Customer | ✔ | — | ✔ | — | — | No |

## 3. Background job inventory (BullMQ)

Queues: `notifications`, `orders`, `dispatch`, `payments`, `refunds`, `tracking`, `payouts`, `analytics`, `maintenance`, `files`, `reports`. Job IDs are deterministic (e.g., `order-accept-timeout:{orderId}`) so duplicates are ignored and jobs can be removed when the state changes.

| ID | Job | Queue | Trigger | Schedule / delay | Idempotency & guard | Retry | On permanent failure |
|---|---|---|---|---|---|---|---|
| JOB-NOTIF-001 | Send notification (per channel) | notifications | Domain events | Immediate | `notification_deliveries` unique (event, user, channel) | 5×, exp. from 10 s | Mark FAILED, fallback channel |
| JOB-NOTIF-002 | Deferred promotional sends (quiet hours) | notifications | Broadcast / deferral | Scheduled | Unique per (campaign, user) | 3× | Drop + log |
| JOB-NOTIF-003 | Review prompt | notifications | OrderDelivered | +30 min | Once per order | 3× | Drop |
| JOB-AUTH-001 | Session & token cleanup | maintenance | Repeatable | Hourly | Set-based delete | 3× | Alert |
| JOB-AUTH-002 | OTP / verification token purge | maintenance | Repeatable | Daily | Set-based | 3× | Alert |
| JOB-USER-001 | Anonymize deleted accounts | maintenance | Deletion request | +30 d | Checks status still DEACTIVATED | 5× | Alert (privacy SLA) |
| JOB-USER-002 | Lift timed suspensions | maintenance | Repeatable | Every 5 min | Status check | 3× | Alert |
| JOB-ORD-001 | Payment TTL expiry | orders | T01 | +15 min | Re-check status & version; provider status query | 5× | Alert ops |
| JOB-ORD-002 | Acceptance reminder & timeout | orders | T02/T03 | +2 min reminder, +5 min timeout | Status still PLACED | 5× | Alert ops |
| JOB-ORD-003 | Auto-preparing | orders | T06 | +1 min | Status ACCEPTED | 3× | Ignore |
| JOB-ORD-004 | Preparation delay alert | orders | T09 | readyBy + 15 min | Status PREPARING | 3× | Ignore |
| JOB-ORD-005 | Pickup delay alerts & no-partner deadline | orders | T11 | +10/+20/+30 min | Status READY & delivery state | 5× | Alert ops |
| JOB-ORD-006 | Delivery overdue alert | orders | T13 | max(2×ETA, 45 min) | Status PICKED_UP | 3× | Ignore |
| JOB-ORD-007 | Stuck-order sweeper (self-healing timers) | orders | Repeatable | Every 5 min | Recreates missing deterministic jobs | 3× | Alert |
| JOB-DISP-001 | Start dispatch | dispatch | OrderAccepted | At dispatch_starts_at | Delivery PENDING | 5× | Alert ops |
| JOB-DISP-002 | Offer timeout / next candidate / round advance / escalation loop | dispatch | Offer created; escalation | +30 s per offer; every 60 s escalated | Offer still OFFERED; delivery SEARCHING | 5× | Alert ops |
| JOB-DISP-003 | Partner heartbeat watchdog (assigned) | dispatch | Repeatable | Every 30 s | Uses last location timestamps | 3× | Alert |
| JOB-DISP-004 | Auto-offline idle partners | dispatch | Repeatable | Every 60 s | Redis state check | 3× | Ignore |
| JOB-TRK-001 | Persist sampled locations (batch insert) | tracking | Location buffer | Every 30 s | Batch keyed by window | 3× | Drop batch + metric |
| JOB-TRK-002 | ETA recompute (routing provider) | tracking | Stage change / 60 s during transit | Throttled | Latest-wins | 2× | Fallback heuristic |
| JOB-PAY-001 | Process webhook event | payments | Webhook received | Immediate | Event row processing_status; per-payment lock | 8× exp. | Alert + DLQ |
| JOB-PAY-002 | Verify payment with provider | payments | Client verify fallback / TTL | Immediate | Precedence rules | 5× | Alert |
| JOB-PAY-003 | Daily reconciliation | payments | Repeatable | 02:00 IST | Run per (provider, date) unique | 3× | Alert finance |
| JOB-PAY-004 | Resolve stuck payments | payments | Repeatable | Hourly | Status filter | 3× | Alert |
| JOB-REFUND-001 | Submit refund to provider | refunds | Refund APPROVED | Immediate; backoff to 24 h | Refund status & provider ref | 5× over 24 h | Wallet fallback / ops |
| JOB-REFUND-002 | Poll refund status | refunds | Repeatable | Every 30 min (≤ 7 d) | Status PROCESSING | — | Alert at 7 d |
| JOB-WALLET-001 | Expire promotional credits | maintenance | Repeatable | Daily | Lot remaining > 0 & expired | 3× | Alert |
| JOB-LEDGER-001 | Ledger integrity check | maintenance | Repeatable | Nightly | Read-only | 2× | P1 incident alert |
| JOB-EARN-001 | Compute delivery earnings | payouts | OrderDelivered | Immediate | UQ(delivery_id) | 5× | Alert |
| JOB-EARN-002 | Incentive evaluation & credit (CORE) | payouts | Repeatable | Period end | UQ(program, partner, period) | 3× | Alert |
| JOB-PAYOUT-001 | Weekly payout batch generation | payouts | Repeatable | Mon 00:30 IST | UQ(type, period) | 3× | Alert finance |
| JOB-PAYOUT-002 | Payout provider submission & status (CORE) | payouts | Batch approved | Immediate | Line status | 5× | Alert |
| JOB-REST-001 | Auto-resume paused branches | maintenance | Pause | At paused_until | Status check | 3× | Ignore |
| JOB-REST-002 | Restaurant inactivity monitor (open but no activity / missed orders) | maintenance | Repeatable | Every 10 min | Read-only + alert dedupe | 3× | — |
| JOB-REST-003 | Document expiry reminders & auto-pause | maintenance | Repeatable | Daily 09:00 IST | Dedupe per (doc, threshold) | 3× | Alert |
| JOB-MENU-001 | Restore item availability at `until` | maintenance | Availability toggle | At until | Row still unavailable with same until | 3× | Ignore |
| JOB-CART-001 | Expire inactive carts | maintenance | Repeatable | Hourly | Set-based | 3× | — |
| JOB-CHK-001 | Expire checkout sessions | maintenance | Repeatable | Every 5 min | Set-based | 3× | — |
| JOB-REV-001 | Rating aggregation | analytics | ReviewPublished | Debounced 60 s per branch | Recompute from source | 3× | — |
| JOB-ANL-001 | Hourly analytics roll-up | analytics | Repeatable | Hourly + daily | Upsert by period | 3× | Alert |
| JOB-SRCH-001 | Trending searches aggregation & autocomplete refresh | analytics | Repeatable | Hourly / 10 min | Upsert | 3× | — |
| JOB-FILE-001 | Image derivatives & EXIF strip | files | Upload | Immediate | Per file ID | 3× | Mark failed |
| JOB-FILE-002 | Orphan file cleanup | files | Repeatable | Daily | Status UPLOADED & age > 24 h | 3× | — |
| JOB-RPT-001 | Report export generation | reports | Request | Immediate | Per export ID | 3× | Mark failed + notify |
| JOB-RET-001 | Retention purge (locations, logs tables, notifications, proofs) | maintenance | Repeatable | Daily 03:00 IST | Batched DELETE (partition drop once DB-SCALE-001 applies) | 3× | Alert privacy owner |
| JOB-OUTBOX-001 | Outbox relay health & stale event alert | maintenance | Repeatable | Every minute | Read-only | — | Alert |

## 4. Queue configuration principles

- Separate Redis (noeviction, AOF) for queues; queue names prefixed by environment.
- Per-queue concurrency tuned (dispatch: low latency, concurrency 20; notifications: 50; analytics: 2).
- `removeOnComplete` with age limits; failed jobs retained 14 days for inspection; dead-letter visible in admin (`API-ADM-202/203`).
- All processors log `jobId`, attempt, duration, outcome; metrics exported per queue (depth, age of oldest waiting job, failure rate).
- Repeatable jobs are registered idempotently at worker boot; only one scheduler instance via BullMQ's built-in job schedulers.
