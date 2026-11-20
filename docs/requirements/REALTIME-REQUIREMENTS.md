# SRS Section 13 — Real-Time Requirements

> Part of FOS-SRS-001 v0.4.1 (APPROVED 2026-11-20). Architecture: `docs/architecture/SYSTEM-ARCHITECTURE.md` §8, ADR-010.

## 13.1 Principles

1. **REST is authoritative; sockets are notifications.** Every real-time event corresponds to state already committed in PostgreSQL. Clients must be able to reconstruct state from REST at any time (reconnect, missed events).
2. **Server-authorized rooms only.** Clients never choose arbitrary room names; they request subscription to a *resource* (`order`, `branch`, `delivery`) and the server decides which room to join after authorization.
3. **Events are emitted after commit** via the transactional outbox relay (never inside a DB transaction).
4. **At-least-once, idempotent consumers.** Each event carries `eventId` (UUIDv7) and `version` (aggregate version); clients drop events with a version ≤ the last applied version for that aggregate.

## 13.2 Connection, namespaces and authentication

| ID | Requirement | Pri | Rel |
|---|---|---|---|
| FR-RT-001 | The server shall expose Socket.IO v4 namespaces per app: `/customer`, `/restaurant`, `/delivery`, `/admin`. A connection to a namespace requires an access token whose `aud` matches the namespace's app. | P0 | MVP |
| FR-RT-002 | The access token shall be sent in the handshake `auth.token` field (never in the query string, to keep it out of logs). The server shall validate signature, expiry, session status and token version (FR-AUTH-021) before accepting; failure → `connect_error` with code `AUTH_TOKEN_INVALID` / `AUTH_SESSION_REVOKED`. | P0 | MVP |
| FR-RT-003 | On access-token refresh the client shall send `auth:refresh {token}`; the server re-validates and extends the connection's authorization expiry. Connections whose token expires without refresh for > 60 s are disconnected with reason `TOKEN_EXPIRED`. | P0 | MVP |
| FR-RT-004 | On session revocation, logout, suspension, or permission version change, the server shall disconnect (or re-evaluate rooms of) affected sockets within 5 s using a Redis pub/sub control channel (`rt:control`) so all API instances act. | P0 | MVP |
| FR-RT-005 | Each socket joins its personal room `user:{userId}` automatically (and `partner:{partnerId}` for delivery, `staff:{userId}` for restaurant). | P0 | MVP |
| FR-RT-006 | Transport: WebSocket preferred, HTTP long-polling fallback allowed for customer/admin; Redis adapter for multi-instance fan-out; sticky sessions required only if polling is enabled (load balancer config documented). | P0 | MVP |
| FR-RT-007 | Connection limits: max 5 concurrent sockets per session; max connection attempts 20/min per IP. | P1 | MVP |

## 13.3 Room management & authorization

| Room | Who may join | Authorization check (server-side) | Joined via |
|---|---|---|---|
| `user:{userId}` | That user | sub = userId | automatic |
| `order:{orderId}` | Order's customer; restaurant members of the order's branch with `order:read`; assigned partner (current); admins/support with `order:read:any` | DB lookup (cached 60 s) of order customer/branch/assigned partner; re-checked on assignment changes | `subscribe {type:"order", id}` |
| `branch:{branchId}:orders` | Restaurant members with `order:read` scoped to branch | membership + branch scope | `subscribe {type:"branch-orders", id}` |
| `branch:{branchId}:kds` | Members with `kds:view` scoped to branch | membership + branch scope | `subscribe {type:"branch-kds", id}` |
| `branch:{branchId}:status` | Members of branch | membership | automatic on restaurant connect for scoped branches |
| `partner:{partnerId}` | That partner | sub owns partner profile | automatic |
| `delivery:{deliveryId}` | Assigned partner (current) only | delivery.assigned_partner_id = partner | automatic on assignment; removed on release |
| `admin:ops` | Admin/support with `ops:monitor` | permission | `subscribe {type:"ops"}` |
| `admin:zone:{zoneId}` | Admin with `ops:monitor` (zone scope if configured) | permission (+ zone scope) | `subscribe {type:"zone", id}` |

| ID | Requirement | Pri | Rel |
|---|---|---|---|
| FR-RT-010 | The server shall reject subscription requests for resources the user is not authorized for with ack `{ok:false, code:"FORBIDDEN"}` and shall not reveal whether the resource exists (same response for not-found). Repeated forbidden subscriptions (> 20/min) disconnect the socket and log a security event. | P0 | MVP |
| FR-RT-011 | When authorization changes (partner released from delivery, member removed from branch, order completed + 30 min), the server shall remove the socket(s) from the room (`socketsLeave`) across instances. | P0 | MVP |
| FR-RT-012 | Client→server events are limited to: `subscribe`, `unsubscribe`, `auth:refresh`, `partner:location`, `partner:heartbeat`, `offer:ack` (offer displayed), `ping`. All business mutations (accept order, accept offer, mark picked up…) go through REST to keep validation, idempotency and audit in one place. | P0 | MVP |
| FR-RT-013 | Every client→server event payload shall be validated with Zod; invalid payloads are acknowledged with `VALIDATION_ERROR` and counted toward rate limits. | P0 | MVP |
| FR-RT-014 | Per-socket rate limits: `partner:location` ≤ 1 per 2 s (excess dropped silently, counted); `subscribe` ≤ 30/min; other events ≤ 60/min. | P0 | MVP |

## 13.4 Event naming & envelope

- Name format: `<domain>.<event>` in lower snake case, past tense for facts (`order.status_changed`, `delivery.partner_assigned`), imperative only for commands (`offer.withdraw` is not used — use `offer.withdrawn`).
- Envelope (server→client):

```json
{
  "eventId": "0193b0b6-…",
  "event": "order.status_changed",
  "occurredAt": "2026-11-20T13:45:12.345Z",
  "aggregate": { "type": "order", "id": "…", "version": 7 },
  "data": { }
}
```

- Payloads contain only data the room's audience is permitted to see; different audiences receive different projections of the same domain event (e.g., the restaurant's `order.new` excludes customer phone; the customer's partner info excludes partner phone until assigned).

## 13.5 Event specification

### Customer events

| Event ID | Event name | Source | Destination | Payload (data) | Authorization | Trigger | Expected client behavior |
|---|---|---|---|---|---|---|---|
| EVT-ORD-001 | `order.created` | orders | `user:{customerId}` | orderId, number, status, payable | owner | T01/T02 | Navigate to payment / confirmation |
| EVT-ORD-002 | `order.status_changed` | orders | `order:{id}` (customer projection), `user:{customerId}` | from, to, at, displayStatus, eta {min,max}, reason? | room auth | Any order transition | Update timeline & banner; invalidate order query |
| EVT-ORD-003 | `order.cancelled` | orders | `order:{id}`, `user:{customerId}` | reason, initiator, refund {amount, destination, status} | room auth | T05/T08/T10/T12/T14 | Show cancellation sheet |
| EVT-ORD-004 | `order.eta_updated` | tracking | `order:{id}` | eta {min,max}, reason (PREP_DELAY, TRAFFIC, REASSIGNED) | room auth | ETA Δ ≥ 2 min | Update ETA |
| EVT-PAY-001 | `payment.status_changed` | payments | `user:{customerId}` | paymentId, orderId, status | owner | Payment status change | Proceed / show failure & retry |
| EVT-REF-001 | `refund.status_changed` | refunds | `user:{customerId}` | refundId, orderId, amount, status | owner | Refund status change | Update refund chip |
| EVT-DLV-001 | `delivery.partner_assigned` | dispatch | `order:{id}` | partner {firstName, photoUrl, vehicleType, rating}, etaToRestaurant | room auth | D03 | Show partner card; show delivery code |
| EVT-DLV-002 | `delivery.status_changed` | deliveries | `order:{id}` | status (AT_RESTAURANT, EN_ROUTE…, AT_CUSTOMER), at | room auth | D04–D07 | Update stage |
| EVT-DLV-003 | `delivery.partner_unassigned` | dispatch | `order:{id}` | reason (REASSIGNING) | room auth | D08 | Show "Finding a new partner" |
| EVT-TRK-001 | `tracking.location` | tracking | `order:{id}` | lat, lng, heading, accuracy, recordedAt (server), stale:false | room auth; only between D03 and D07 | Partner update (throttled 3 s) | Animate marker; update "updated Xs ago" |
| EVT-TRK-002 | `tracking.eta` | tracking | `order:{id}` | etaMinutes, distanceRemainingKm | room auth | Recompute | Update ETA text |
| EVT-TRK-003 | `tracking.stale` | tracking | `order:{id}` | lastSeenAt | room auth | No update 60 s | Show "Location updating…" |
| EVT-NTF-001 | `notification.created` | notifications | `user:{id}` | id, title, body, category, deepLink | owner | In-app notification created | Increment badge; toast if relevant |

### Restaurant events

| Event ID | Event name | Source | Destination | Payload | Authorization | Trigger | Expected behavior |
|---|---|---|---|---|---|---|---|
| EVT-REST-001 | `order.new` | orders | `branch:{id}:orders`, `branch:{id}:kds` (KDS projection without prices) | order summary: id, number, items, instructions, placedAt, acceptBy, payment type, restaurant earnings | branch scope | T02/T03 | Add to New queue; loop sound until acted |
| EVT-REST-002 | `order.updated` | orders | `branch:{id}:orders`, `branch:{id}:kds` | id, status, version, readyBy | branch scope | Any transition | Move card |
| EVT-REST-003 | `order.cancelled` | orders | `branch:{id}:orders`, `branch:{id}:kds` | id, reason, initiator, stopPreparation:true | branch scope | Cancellation | Alert sound + banner "Stop preparing" |
| EVT-REST-004 | `order.accept_reminder` | orders | `branch:{id}:orders` | id, secondsLeft | branch scope | 2-min reminder | Escalate alert |
| EVT-REST-005 | `delivery.partner_assigned` | dispatch | `branch:{id}:orders` | orderId, partner {firstName, photo, vehicle}, etaToRestaurant | branch scope | D03 | Show partner ETA |
| EVT-REST-006 | `delivery.partner_arrived` | deliveries | `branch:{id}:orders` | orderId, partner firstName, pickupCode? | branch scope | D04 | Highlight order |
| EVT-REST-007 | `delivery.picked_up` | deliveries | `branch:{id}:orders`, `branch:{id}:kds` | orderId, at | branch scope | T13 | Move to Picked up |
| EVT-REST-008 | `branch.status_changed` | restaurants | `branch:{id}:status` | isAcceptingOrders, reason, pausedUntil | branch scope | Open/close/pause/auto-pause/suspension | Update status chip |
| EVT-REST-009 | `dashboard.metrics_updated` | analytics | `branch:{id}:orders` | today counts, revenue | branch scope; throttled 30 s | Order transitions | Refresh tiles |
| EVT-REST-010 | `menu.item_availability_changed` | menu | `branch:{id}:orders` | itemId, available, until | branch scope | Auto-restore/stock-out | Refresh menu list |

### Delivery partner events

| Event ID | Event name | Source | Destination | Payload | Authorization | Trigger | Expected behavior |
|---|---|---|---|---|---|---|---|
| EVT-DP-001 | `offer.created` | dispatch | `partner:{id}` | offerId, deliveryId, expiresAt (server time), restaurant {name, area, distanceKm}, dropArea, dropDistanceKm, estimatedEarnings, paymentType, codAmount? | self | FR-DISP-004 | Full-screen card + countdown + sound; client sends `offer:ack` |
| EVT-DP-002 | `offer.expired` | dispatch | `partner:{id}` | offerId | self | Timeout | Close card "Missed" |
| EVT-DP-003 | `offer.withdrawn` | dispatch | `partner:{id}` | offerId, reason (ORDER_CANCELLED, PARTNER_OFFLINE, REASSIGNED) | self | Cancellation/etc. | Close card |
| EVT-DP-004 | `assignment.confirmed` | dispatch | `partner:{id}` | deliveryId, full pickup details | self | D03 | Navigate to active delivery |
| EVT-DP-005 | `assignment.revoked` | dispatch | `partner:{id}`, `delivery:{id}` | deliveryId, reason | self | D08 by admin/system | Return to idle; show reason |
| EVT-DP-006 | `assignment.manual` | dispatch | `partner:{id}` | deliveryId, details, ackBy | self | FR-DISP-011 | Must acknowledge |
| EVT-DP-010 | `order.ready` | orders | `delivery:{id}` | orderId, readyAt | assigned | T11 | Update stage hint |
| EVT-DP-011 | `order.cancelled` | orders | `delivery:{id}` | orderId, reason, compensation | assigned | Cancellation | Stop & return to idle |
| EVT-DP-012 | `order.prep_delayed` | orders | `delivery:{id}` | newReadyBy | assigned | FR-RORD-005 | Update wait time |
| EVT-DP-013 | `delivery.instructions_updated` | orders | `delivery:{id}` | instructions, contactPhone | assigned; only post-assignment | FR-ORDER-031 | Show update |
| EVT-DP-014 | `partner.status_changed` | delivery-partners | `partner:{id}` | state, reason (AUTO_OFFLINE_INACTIVE, CASH_CAP, ADMIN) | self | State change | Update toggle |
| EVT-DP-015 | `earnings.updated` | earnings | `partner:{id}` | today total, last delivery breakdown | self | Delivery completion/adjustment | Refresh earnings |

### Admin events

| Event ID | Event name | Source | Destination | Payload | Authorization | Trigger | Expected behavior |
|---|---|---|---|---|---|---|---|
| EVT-ADM-001 | `ops.order_activity` | orders | `admin:ops`, `admin:zone:{id}` | orderId, number, zone, status, at | `ops:monitor` | Transitions (sampled/throttled 1 s batch) | Live feed |
| EVT-ADM-002 | `ops.approval_requested` | restaurants/partners | `admin:ops` | type, id, name | `restaurant:approve` / `partner:approve` | Submission | Badge counter |
| EVT-ADM-003 | `ops.partner_activity` | delivery-partners | `admin:zone:{id}` | online count, positions (batched 10 s) | `ops:monitor` | Periodic | Map refresh |
| EVT-ADM-004 | `ops.alert` | any | `admin:ops` | alertId, severity, type (NO_PARTNER, ORDER_STUCK, STALE_PARTNER, RESTAURANT_MISSED_ORDERS, PAYMENT_MISMATCH, QUEUE_BACKLOG, PROVIDER_DOWN), refs | `ops:monitor` | Alert rule | Alert list with sound for critical |
| EVT-ADM-005 | `ops.pickup_delayed` | orders | `admin:ops` | orderId, minutesLate | `ops:monitor` | JOB-ORD-005 | Alert |
| EVT-ADM-006 | `ops.partner_stale` | tracking | `admin:ops` | partnerId, deliveryId, lastSeenAt | `ops:monitor` | 5 min stale | Alert |
| EVT-ADM-007 | `support.ticket_updated` | support | `admin:ops` (support queue) | ticketId, status, priority, assignee | `support:read` | Ticket change | Refresh queue |
| EVT-ADM-008 | `restaurant.activity` | restaurants | `admin:zone:{id}` | branchId, isAcceptingOrders | `ops:monitor` | Branch status change | Update map/list |

### Client → server events

| Event ID | Event | Namespace | Payload | Authorization | Server behavior |
|---|---|---|---|---|---|
| EVT-C-001 | `subscribe` | all | `{type, id}` | per §13.3 | Join room or ack FORBIDDEN |
| EVT-C-002 | `unsubscribe` | all | `{type, id}` | — | Leave room |
| EVT-C-003 | `auth:refresh` | all | `{token}` | valid token for same user & session | Extend auth |
| EVT-C-004 | `partner:location` | `/delivery` | `{lat, lng, accuracy, heading?, speed?, recordedAt, batteryPct?, buffered?}` | partner ONLINE | Validate (FR-TRK-003), store, fan-out throttled |
| EVT-C-005 | `partner:heartbeat` | `/delivery` | `{state, appVisible}` | partner | Update liveness |
| EVT-C-006 | `offer:ack` | `/delivery` | `{offerId}` | offer belongs to partner | Record `displayedAt` (diagnostics) |

## 13.6 Reliability requirements

| ID | Requirement | Pri | Rel |
|---|---|---|---|
| FR-RT-020 | **Reconnection.** Clients shall reconnect with exponential backoff (1 s → 30 s max, jitter), re-send subscriptions, and refetch authoritative snapshots for subscribed resources (TanStack Query invalidation). | P0 | MVP |
| FR-RT-021 | **Disconnection on server side.** On socket disconnect the server shall clean up room memberships; for partners, a disconnect does not by itself change availability — liveness is based on location/heartbeat timeouts (FR-DP-014). | P0 | MVP |
| FR-RT-022 | **Event retries.** Server→client delivery is best-effort (no per-client queue). Critical events whose loss is user-impacting are also delivered through another channel: new restaurant orders (push + polling fallback every 15 s on the order queue while the socket is disconnected), partner offers (push), customer status (push/SMS per template). | P0 | MVP |
| FR-RT-023 | **Stale data.** Each event carries `aggregate.version`; clients ignore older versions; snapshots fetched after reconnect replace local state. | P0 | MVP |
| FR-RT-024 | **Ordering.** Events for the same aggregate are emitted in commit order by the outbox relay (ordered by outbox sequence per aggregate); cross-aggregate ordering is not guaranteed. | P0 | MVP |
| FR-RT-025 | **Duplicate events.** Clients deduplicate by `eventId` (LRU of last 500). | P1 | MVP |
| FR-RT-026 | **Unauthorized subscriptions** are rejected per FR-RT-010 and logged with user, resource, IP. | P0 | MVP |
| FR-RT-027 | **Observability.** The gateway shall emit metrics: connected sockets per namespace, joins/sec, events emitted/sec by name, emit latency (commit→emit), auth failures, rate-limit drops. | P1 | MVP |
| FR-RT-028 | **Latency.** Commit-to-client latency for order/delivery events p95 ≤ 1 s; location fan-out p95 ≤ 2 s under normal load (NFR-PERF-008). | P1 | MVP |
