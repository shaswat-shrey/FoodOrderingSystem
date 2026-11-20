# ADR-005: PostGIS with Prisma

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
Serviceability, nearby discovery, zones and dispatch need geospatial queries and GiST indexes. Prisma does not support PostGIS types natively.

## Decision
Declare spatial columns as `Unsupported("geography(Point,4326)")` / `geography(Polygon,4326)` in the Prisma schema; create GiST indexes and spatial constraints in migration SQL; read/write them only in dedicated repository methods using `$queryRaw` tagged templates (parameterized). Geography (meters, spherical) rather than geometry for correctness without projection management. Live partner positions use Redis GEO for speed; PostGIS for persistence and admin queries.

## Alternatives
- Lat/lng float columns + haversine in SQL — no index support for radius queries at scale; rejected.
- Drizzle/Kysely instead of Prisma — better raw SQL ergonomics, but Prisma is mandated and fine with a repository pattern.

## Consequences
+ Accurate, indexed spatial queries (`ST_DWithin`, `ST_Contains`).
− Spatial fields are invisible to Prisma Client; repository tests must cover them; migrations need hand-written SQL.
