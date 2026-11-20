# ADR-001: Modular monolith with a separate worker process

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
The platform has ~30 business domains with heavy transactional coupling (checkout touches cart, pricing, coupons, orders, payments, wallet). The team is small and the pilot load (SRS A-12) fits easily on a few instances. The owner explicitly requires a modular monolith first, with modules extractable later.

## Decision
One deployable API codebase organized into domain modules with enforced boundaries (public `index.ts`, lint/dependency-cruiser rules, no cross-module repository access, no import cycles). Inter-module async communication uses domain events through a transactional outbox (ADR-010). Background work runs in a separate **worker** process type built from the same codebase, scaled independently.

## Alternatives
- **Microservices now:** distributed transactions for checkout, operational overhead, slower iteration — rejected.
- **Unstructured monolith:** fast initially, but domains entangle and extraction becomes impossible — rejected.

## Consequences
+ Single DB transaction for checkout/order/ledger correctness; simple deploys; easy local dev.
+ Clear seams (events + service interfaces) enable later extraction of dispatch/tracking/notifications if measured load requires (NFR-SCALE-007).
− Requires discipline: boundary lint rules in CI from day one.
− One DB is a shared failure domain (mitigated by HA Postgres, backups).
