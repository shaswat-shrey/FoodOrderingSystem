# FoodOrderSystem — Online Food Ordering & Delivery Platform

A production-oriented food delivery ecosystem: customer, restaurant (incl. kitchen display), delivery-partner and admin applications on a shared Node.js/TypeScript modular-monolith backend (Express, Socket.IO, PostgreSQL + PostGIS, Prisma, Redis, BullMQ).

> **Status:** Phase 1 (requirements & architecture) approved on 2026-11-20; Phase 2 (repository & infrastructure) in progress — see [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Start here
- **Review pack:** [docs/PHASE-1-REVIEW.md](docs/PHASE-1-REVIEW.md) — summary, assumptions and decisions needing approval
- **SRS (source of truth):** [docs/requirements/SRS-Online-Food-Ordering-and-Delivery-Platform.md](docs/requirements/SRS-Online-Food-Ordering-and-Delivery-Platform.md)
- **Architecture:** [docs/architecture/SYSTEM-ARCHITECTURE.md](docs/architecture/SYSTEM-ARCHITECTURE.md) · [ADRs](docs/architecture/adr/README.md)
- **Roadmap & risks:** [docs/ROADMAP.md](docs/ROADMAP.md)

## Documentation layout
```
docs/
  requirements/   SRS sections, business rules, NFRs, API spec, acceptance criteria, traceability, index
  architecture/   system architecture, state machines, events & jobs, dispatch, payments, testing, ADRs
  database/       ERD
  tools/          requirements-index.mjs (generates the index, checks IDs)
```

Regenerate / check the requirements index after editing any SRS file:
```bash
node docs/tools/requirements-index.mjs
```
```bash
node docs/tools/requirements-index.mjs --check
```

Setup instructions, demo accounts and deployment docs arrive with Phases 2 and 14.
