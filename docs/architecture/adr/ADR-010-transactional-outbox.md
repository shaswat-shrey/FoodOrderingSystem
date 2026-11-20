# ADR-010: Transactional outbox for events, jobs and real-time

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
State changes must reliably trigger notifications, jobs and socket events. Emitting directly after commit can lose events on crash; emitting inside the transaction can announce changes that roll back.

## Decision
Write `outbox_events` in the same transaction as the state change. A leader-elected relay (in the worker process; one leader via a Redis lock — amended v0.7.0, D-11) publishes in sequence order to the domain event bus (Redis pub/sub / in-process), BullMQ queues and the Socket.IO fan-out, then marks rows published. Consumers are idempotent by event ID. Clients treat socket events as hints and re-fetch authoritative REST state on reconnect.

## Alternatives
Direct emit after commit (simple, lossy); Kafka/CDC with Debezium (robust, heavy for MVP) — the outbox table is compatible with a later CDC migration.

## Consequences
+ No lost or phantom events; ordering per aggregate; extraction-ready.
− Small added latency (relay poll interval ~100–250 ms, or LISTEN/NOTIFY to wake the relay); outbox table needs pruning.
