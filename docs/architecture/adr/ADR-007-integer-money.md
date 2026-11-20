# ADR-007: Money as integer minor units

- **Status:** Proposed · **Date:** 2026-11-20

## Context
JavaScript floats cannot represent decimal currency exactly; financial totals must reconcile to the paisa.

## Decision
Store and compute all money as integer paise (`bigint` columns, safe-integer numbers in TS) with an explicit currency on aggregates. Percentages are basis points. One shared rounding function (half-up, once per component). Formatting only at presentation edges. No floating point in pricing, ledger, refunds or payouts (lint rule bans arithmetic on `*Amount` floats in domain code via helper-only access).

## Alternatives
`decimal.js` / `Prisma.Decimal` — correct but slower and easy to misuse across boundaries; integer minor units are simpler and match provider APIs (Razorpay uses paise).

## Consequences
+ Exact arithmetic; trivial reconciliation with provider amounts.
− Must convert at UI boundaries; multi-currency with 3-decimal currencies needs per-currency exponent (data model already stores currency).
