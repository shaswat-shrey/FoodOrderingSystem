# Project Status

_Last updated: 2026-11-20_

## Summary
| Item | Status |
|---|---|
| Current phase | **Phase 1 — Product requirements & architecture: complete, awaiting owner approval** |
| Next phase | Phase 2 — Repository & infrastructure (blocked on approval) |
| SRS version | FOS-SRS-001 v0.1.0 (DRAFT) |
| Application code | None yet (by design) |

## Phases
| Phase | Status |
|---|---|
| 1 Requirements & architecture | ✅ Drafted · ⏳ Awaiting approval |
| 2 Repository & infrastructure | ⛔ Not started (blocked) |
| 3 Database | Not started |
| 4 Auth & security | Not started |
| 5 Core customer backend | Not started |
| 6 Cart, pricing, checkout | Not started |
| 7 Order management | Not started |
| 8 Restaurant application | Not started |
| 9 Delivery application | Not started |
| 10 Real-time | Not started |
| 11 Admin | Not started |
| 12 Frontend integration | Not started |
| 13 Testing & hardening | Not started |
| 14 Finalization | Not started |

## Completed (Phase 1 documents)
- SRS master + companion sections: `docs/requirements/` (Sections 1–28), generated `REQUIREMENTS-INDEX.md`
- Architecture: `docs/architecture/` (system architecture, state machines, events & jobs, dispatch algorithm, payment architecture, testing strategy, 14 ADRs)
- Database: `docs/database/ERD.md`
- Roadmap, task breakdown, risks: `docs/ROADMAP.md`
- Review pack: `docs/PHASE-1-REVIEW.md`
- Tooling: `docs/tools/requirements-index.mjs` (ID index generator & checker)

## Modules
| Module | Status |
|---|---|
| All backend modules (auth … realtime) | Designed (SRS + architecture); not implemented |
| All frontend apps | Designed (page inventories in SRS §17.1); not implemented |

## APIs
- Implemented: **0**
- Planned: **494** (see `docs/requirements/API-SPECIFICATION.md`)

## UI pages
- Implemented: **0**
- Planned: customer 21, restaurant 24, delivery 19, admin 31 (SRS §17.1)

## Database migrations
- None yet. Entity inventory (~125 tables) defined in SRS §15.

## Tests
- None yet. Strategy: `docs/architecture/TESTING-STRATEGY.md`; acceptance criteria: SRS §23.

## Known bugs
- None (no code).

## Known discrepancies (SRS vs implementation)
- None.

## Technical decisions
- ADR-001…014 (Proposed) — see `docs/architecture/adr/README.md`.

## Blockers
- Owner approval of SRS and Phase 1 architecture.
- Owner answers to open decisions OD-01…OD-16 (defaults proposed; can proceed with defaults if approved).
- Legal/tax review items (SRS §20.4) — needed before launch, not before Phase 2.

## Next steps (after approval)
1. Record OD answers in SRS v0.2.0, update revision history.
2. Phase 2 tasks per `docs/ROADMAP.md` §2.

## TODO (meaningful tasks)
- [ ] Owner review & approval of Phase 1 pack
- [ ] Resolve OD-01…OD-16
- [ ] Phase 2: monorepo, Docker Compose, API/worker skeletons, app shells, CI
