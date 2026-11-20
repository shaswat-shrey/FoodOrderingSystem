# ADR-002: RBAC with platform roles, restaurant-scoped memberships and resource policies

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
Authorization must cover platform staff, customers, partners, and restaurant staff whose rights depend on *which restaurant and branch* they belong to. Roles alone cannot express "manager of branch X only". The owner requires RBAC + permission-based + resource-level checks.

## Decision
- Platform roles in `user_roles` (CUSTOMER, DELIVERY_PARTNER, SUPPORT_AGENT, ADMIN, SUPER_ADMIN, RESTAURANT_OWNER marker).
- Restaurant roles as `restaurant_members` (OWNER, MANAGER, ORDER_MANAGER, KITCHEN, STAFF) with optional branch scope; permissions namespaced `rest.*`.
- Every route declares a permission and a resource policy; decision = permission ∧ policy. Permissions resolved server-side and cached by `permissionVersion`; JWT carries roles only as UI hints.
- Customer-owned resources return 404 for non-owners.

## Alternatives
- Roles in JWT as the source of truth — stale after changes, can't express scope; rejected.
- Full ABAC/policy engine (OPA/Casbin) — powerful but heavy for current needs; revisit if policies multiply.

## Consequences
+ Precise, testable authorization (generated authorization matrix tests).
+ Same policy helpers for REST and sockets.
− Extra DB/cache lookups per request (mitigated by versioned cache).
