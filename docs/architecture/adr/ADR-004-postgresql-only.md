# ADR-004: PostgreSQL as the only database

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
The owner permits MongoDB only with a clear justification. Candidate "document-like" data: menus (nested customizations), webhook payloads, audit diffs, notification payloads, location trails.

## Decision
Use PostgreSQL for everything: relational tables for menus (they need constraints, joins, and price integrity), JSONB for genuinely schemaless payloads (webhooks, audit diffs), partitioned tables for high-volume append-only data (locations, audit). Redis covers ephemeral/live data. No MongoDB.

## Alternatives
MongoDB for menus/locations — would split transactions (order snapshots vs menu), duplicate infrastructure, and offers nothing PostGIS + JSONB + partitioning cannot do at our scale.

## Consequences
+ One transactional store, one backup story, joins across domains, PostGIS.
− Location trail volume must be managed (sampling, partitioning, 90-day retention).
