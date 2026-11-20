# ADR-012: pnpm + Turborepo monorepo; Zustand for client state

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
Four frontends and two backend processes share types, validation schemas, money logic, state machine definitions and UI components.

## Decision
- One repository with pnpm workspaces and Turborepo task pipelines/caching. Apps in `apps/`, shared code in `packages/` (`ui`, `api-client`, `validation`, `types`, `shared`, `config`, `db`).
- Shared Zod schemas are the single source for request validation (API), form validation (frontends) and OpenAPI generation.
- Client state: **Zustand** (small, hook-based stores for auth token, location, UI state); server state: TanStack Query. Redux Toolkit not used — the server-state library removes most of what Redux would hold, and Zustand keeps stores small and local.

## Alternatives
Polyrepo (version drift of shared schemas); Nx (heavier); Redux Toolkit (more boilerplate without benefit here).

## Consequences
+ Atomic changes across API and clients; one lint/test toolchain.
− CI must use Turborepo caching/affected builds to stay fast.
