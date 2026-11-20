# ADR-009: PostgreSQL full-text + trigram search

- **Status:** Proposed · **Date:** 2026-11-20

## Context
Search over restaurants and dishes within serviceable branches for one city: tens of thousands of documents.

## Decision
Generated weighted `tsvector` columns (`simple` + `unaccent`), GIN indexes, `pg_trgm` for typo tolerance and prefix autocomplete, ranking combining text rank, similarity, rating and distance; curated synonyms (CORE). Revisit when the triggers in SYSTEM-ARCHITECTURE §11 fire.

## Alternatives
Elasticsearch/OpenSearch/Meilisearch — better relevance tooling, but adds a cluster, sync pipeline and consistency lag; not justified at pilot scale (owner rule).

## Consequences
+ No sync pipeline; transactional consistency; one less system.
− Fewer relevance features; Indian-language stemming limited (transliterated names handled via trigram + synonyms).
