# ADR-013: Branch is the orderable unit; menu at brand level with branch overrides

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
Restaurants may have multiple outlets with different locations, hours, radius and stock, but usually one menu.

## Decision
`restaurants` = brand/legal entity owning the menu; `branches` = orderable outlets with location, radius, hours, status, prep times, min/max order, and per-branch availability/stock overrides. Carts and orders always reference a branch. Per-branch price overrides are deferred to ADV (adds pricing complexity).

## Alternatives
Menu per branch (duplication, painful edits for chains); single-location restaurants only (blocks chains).

## Consequences
+ Chains manage one menu; branches control operations.
− Availability resolution joins brand menu with branch overrides (cached per branch menu version).
