# Architecture Decision Records

Format: Context → Decision → Alternatives considered → Consequences. Status values: Proposed, Accepted, Superseded. All ADRs below are **Proposed** until the owner approves Phase 1.

| ADR | Title | Status |
|---|---|---|
| [ADR-001](ADR-001-modular-monolith.md) | Modular monolith with a separate worker process | Proposed |
| [ADR-002](ADR-002-rbac-with-restaurant-memberships.md) | RBAC: platform roles + restaurant-scoped memberships + resource policies | Proposed |
| [ADR-003](ADR-003-token-and-session-model.md) | Short-lived JWT access tokens + rotating hashed refresh tokens in HttpOnly cookies | Proposed |
| [ADR-004](ADR-004-postgresql-only.md) | PostgreSQL as the only database (no MongoDB) | Proposed |
| [ADR-005](ADR-005-postgis-with-prisma.md) | PostGIS geography with Prisma via Unsupported types and raw SQL repositories | Proposed |
| [ADR-006](ADR-006-separate-state-machines.md) | Separate order, payment and delivery state machines | Proposed |
| [ADR-007](ADR-007-integer-money.md) | Money as integer minor units | Proposed |
| [ADR-008](ADR-008-sequential-offer-dispatch.md) | Sequential single-partner offers with locking for dispatch | Proposed |
| [ADR-009](ADR-009-postgres-search.md) | PostgreSQL full-text + trigram search before Elasticsearch | Proposed |
| [ADR-010](ADR-010-transactional-outbox.md) | Transactional outbox for domain events, jobs and real-time | Proposed |
| [ADR-011](ADR-011-double-entry-ledger.md) | Double-entry ledger for all money movement | Proposed |
| [ADR-012](ADR-012-monorepo-and-frontend-state.md) | pnpm + Turborepo monorepo; Zustand for client state | Proposed |
| [ADR-013](ADR-013-branch-as-orderable-unit.md) | Branch is the orderable unit; menu at brand level with branch overrides | Proposed |
| [ADR-014](ADR-014-delivery-pwa.md) | Delivery partner app as an installable PWA first | Proposed |
