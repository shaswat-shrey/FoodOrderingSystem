# ADR-011: Double-entry ledger for all money movement

- **Status:** Proposed · **Date:** 2026-11-20

## Context
Money flows between customers, the gateway, restaurants, partners, tax authorities and the platform, including refunds, partial refunds, COD cash, wallet credits, commissions and payouts. Balances must be auditable and reconcilable.

## Decision
Immutable `ledger_transactions` with `ledger_entries` that sum to zero, over typed `ledger_accounts` per owner. Cached balances updated in the same transaction under row lock; wallet balance non-negative. Domain tables (payments, refunds, payouts) keep operational state; the ledger is the financial source of truth. Nightly integrity checks; daily provider reconciliation.

## Alternatives
Single-entry "wallet_transactions" + balance columns — simpler, but errors are undetectable and reconciliation is guesswork.

## Consequences
+ Every rupee traceable; invariants are machine-checkable; settlements/payouts derive from balances.
− More upfront design; chart of accounts and tax treatment need finance review (OD-05/06).
