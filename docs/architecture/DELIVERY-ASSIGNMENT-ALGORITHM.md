# Delivery Assignment (Dispatch) Algorithm Design

> Phase 1 · v0.3.0 (APPROVED 2026-11-20). Requirements: SRS §12 (FR-DISP-*), BR-DEL-*. Decision: ADR-008.

## 1. Goals (in priority order)
1. **Correctness:** never two partners on one delivery; never offer to ineligible partners; never lose a delivery (always SEARCHING, ASSIGNED, or terminal).
2. **Customer promise:** partner arrives at the restaurant close to the ready time.
3. **Partner fairness:** spread work; don't starve idle partners.
4. **Efficiency:** minimize partner dead-miles.
5. **Explainability:** every offer stores why the partner was chosen.

## 2. Why sequential single offers (not broadcast)
Broadcasting an offer to many partners ("first to tap wins") creates disappointment, rewards fast tappers over nearby partners, and hides real acceptance signals. Sequential offers to the best-ranked partner (30 s each) give clean acceptance metrics and simple conflict handling. Cost: worst-case latency (5 offers × 30 s per round). Mitigations: short timeout, skip partners with poor recent acceptance, and the option (CORE) to offer to the top-2 simultaneously in escalation (still exactly-once via locking).

## 3. Timing

```
dispatch_starts_at = max(accepted_at, ready_by − est_travel_to_restaurant − lead_buffer)
  est_travel_to_restaurant = zone median pickup travel (default 8 min) — refined with live supply density (CORE)
  lead_buffer = 5 min ⚙
if prep_minutes ≤ 15 → dispatch immediately
```

## 4. Candidate generation

```
for round r in [1..3]:
  radius = [3 km, 5 km, 8 km][r]
  ids = GEOSEARCH partners:zone:{zoneId} FROMLONLAT branch.lng branch.lat BYRADIUS radius km ASC COUNT 50 WITHDIST
  candidates = ids filtered by:
     state == ONLINE_IDLE (Redis partner:{id}:state)
     loc.age ≤ 60 s and loc.accuracy ≤ 100 m
     account ACTIVE (cached; DB-confirmed at acceptance)
     vehicle compatible (bicycle/e-bike: pickup ≤ 3 km and drop ≤ 4 km)
     if order COD: cash_in_hand + cod_amount ≤ cash_cap
     partner ∉ exclusions(delivery)           # rejected / expired / released
     no open offer (SET NX offer-lock:partner:{id})
```

## 5. Ranking

Score in [0, 1], higher is better; weights ⚙ (`cfg.dispatch.weights`), defaults:

| Feature | Definition | Normalization | Weight |
|---|---|---|---|
| Pickup ETA | `dist_to_branch / vehicle_speed` (routing ETA when available) | `1 − min(eta / 20 min, 1)` | 0.50 |
| Ready alignment | `|eta − time_until_ready|` (arriving too early wastes partner time) | `1 − min(gap / 15 min, 1)` | 0.15 |
| Idle time | minutes since last delivery completed | `min(idle / 30 min, 1)` | 0.15 |
| Acceptance rate (30 d) | from partner_stats | rate | 0.10 |
| Rating | Bayesian avg | `(rating − 3) / 2` clamped | 0.05 |
| Load balance | deliveries today | `1 − min(today / 25, 1)` | 0.05 |

Hard gates (not weighted): eligibility filters. Tie-breaker: shorter distance, then partner ID (deterministic tests).
Score breakdown is stored in `delivery_assignments.score_breakdown`.

## 6. Offer loop (per delivery, single-flight)

```
acquire Redis lock dispatch:{deliveryId} (TTL 10 s, renewed)  # one dispatcher at a time per delivery
loop:
  if delivery not SEARCHING → stop
  if offers_in_round ≥ 5 or candidates exhausted → next round (or escalate after round 3)
  partner = next ranked candidate (re-check eligibility live)
  in DB tx: insert delivery_assignments(OFFERED, expires_at = now + 30 s); outbox OfferCreated
  set Redis partner state OFFERED; schedule JOB-DISP-002 at expires_at (jobId offer-timeout:{assignmentId})
  return  # loop resumes on response or timeout event
```

## 7. Acceptance (exactly-once)

```
POST /partner/offers/{id}/accept
  lock = SET lock:delivery:{deliveryId} <token> NX PX 5000   (fail → 409 retry-able)
  BEGIN
    SELECT * FROM deliveries WHERE id = $1 FOR UPDATE
    SELECT * FROM delivery_assignments WHERE id = $2 FOR UPDATE
    assert delivery.status = 'SEARCHING' and delivery.partner_id IS NULL
    assert assignment.status = 'OFFERED' and assignment.partner_id = me and now() < assignment.expires_at
    assert partner ACTIVE and no other active delivery (partial unique index backs this)
    UPDATE delivery_assignments SET status='ACCEPTED', responded_at=now()
    UPDATE deliveries SET status='ASSIGNED', partner_id=me, assigned_at=now(), version=version+1
    INSERT delivery_status_history …; INSERT outbox PartnerAssigned
  COMMIT
  set partner state ON_DELIVERY; remove offer-timeout job; release lock (compare token)
```
Even if the Redis lock fails (outage), the DB row locks + partial unique indexes guarantee correctness; the Redis lock only reduces contention.

## 8. Failure handling

| Case | Handling |
|---|---|
| Reject | assignment REJECTED, partner excluded, acceptance stats updated, next candidate immediately |
| Timeout | JOB-DISP-002: if still OFFERED → EXPIRED, partner `consecutive_missed_offers++` (3 → auto-offline), next candidate |
| Partner goes offline with open offer | WITHDRAWN, next candidate |
| Order cancelled during search | All OFFERED → WITHDRAWN, delivery CANCELLED, partner states restored |
| No candidates after round 3 | `escalated = true`, EVT-ADM-004 alert, retry every 60 s at max radius (expired partners re-eligible after 5 min), customer delay notification at ready + 10 min, cancellation at deadline (BR-DEL-003) |
| Assigned partner heartbeat lost | 3 min: ping + ops alert; 5 min: RELEASED, partner flagged, delivery back to SEARCHING with priority (rank boost in candidate scoring of other deliveries is not needed — delivery jumps the dispatcher queue) |
| Partner unassigns (before pickup) | RELEASED, re-dispatch with priority, penalty counters |
| Manual assignment | Admin picks from `/deliveries/{id}/candidates` (same eligibility, ranked); creates ACCEPTED assignment with `manual=true`; partner must acknowledge within 60 s |
| Redis outage | Dispatch paused (deliveries stay SEARCHING); admin manual assignment uses DB `last_location`; JOB-ORD-007 & JOB-DISP-002 resume loops on recovery |

## 9. ETA computation

```
eta_customer = remaining_prep + max(0, partner_to_restaurant − remaining_prep)  # whichever is later
             + handover_buffer (3 min)
             + restaurant_to_customer_travel
             + drop_buffer (3 min)
```
Before assignment, `partner_to_restaurant` = zone median; after assignment, live route ETA. Displayed as a range (±5 min, rounded to 5).

## 10. Metrics to tune the algorithm

Time to assign (dispatchable → ASSIGNED), offers per assignment, acceptance rate by distance band, partner wait at restaurant, food wait (ready → pickup), delivered within ETA %, partner idle time distribution, escalation rate per zone/hour.

## 11. Future (ADV)
Batching (second order on same route), predictive dispatch using demand forecasts, ML ETA, zone rebalancing nudges (heatmaps/incentives), routing matrix API for multi-candidate ETA.
