# ADR-006: Separate order, payment and delivery state machines

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
The suggested single order status list mixes three lifecycles. Partner assignment usually happens *during* preparation, so `DELIVERY_PARTNER_ASSIGNED` cannot be a step between `READY_FOR_PICKUP` and `PICKED_UP` without lying about state. Refund progress can continue after an order is terminal.

## Decision
Three machines linked by the order: order status (customer/restaurant lifecycle), payment status, delivery status (+ assignment offers). Mapping of the suggested states is documented in SRS §10.1. Each machine is a pure transition table in `@fos/shared`, enforced in the owning module's `transition()` with row locks, version checks, history rows and outbox events. Clients never set status directly.

## Alternatives
One combined status enum — simpler to display, but produces invalid combinations and race conditions between restaurant and dispatch updates; rejected.

## Consequences
+ Each lifecycle evolves and is tested independently; no impossible states.
− UI needs a derived "display status" (provided by shared helpers).
