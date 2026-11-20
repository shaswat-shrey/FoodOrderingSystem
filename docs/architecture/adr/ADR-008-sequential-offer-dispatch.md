# ADR-008: Sequential single-partner offers with locking

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
Dispatch must never double-assign, should be fair, explainable and fast enough. Details: `docs/architecture/DELIVERY-ASSIGNMENT-ALGORITHM.md`.

## Decision
Rank eligible partners (Redis GEOSEARCH + filters + weighted score) and offer to one partner at a time with a 30 s server-side timeout; expand radius over 3 rounds; escalate to ops; cancel at a deadline. Acceptance uses a Redis lock (contention reduction) plus DB row locks and partial unique indexes (correctness guarantee).

## Alternatives
- Broadcast to N partners, first accept wins — faster but unfair and noisy; may revisit for escalation (top-2).
- Global optimization (batch assignment every few seconds, Hungarian algorithm) — better efficiency at high density; ADV candidate once volume justifies.

## Consequences
+ Exactly-once by construction; clean acceptance metrics; simple to test.
− Worst-case assignment latency higher than broadcast; tuned via timeout, rounds and pre-dispatch timing.
