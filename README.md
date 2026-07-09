# TriServe

**Product:** TriServe
**Developer:** Tristate Systems Ltd

TriServe is a multi-branch Service Centre Management System with an integrated Point of Sale, built for a Samsung Authorized Service Centre in Tanzania. It manages the full device-repair lifecycle — Samsung in-warranty (IW) jobs as well as out-of-warranty (OW) and other-brand repairs — alongside spare-parts inventory, procurement, point-of-sale, warranty claims, and double-entry accounting. The system is architected from day one to grow into a commercial ERP that can be licensed to other service centres.

The single source of truth for the design is [`docs/DESIGN.md`](docs/DESIGN.md).

## Tech stack

- **Backend:** Node.js + TypeScript + NestJS, Prisma ORM, MySQL 8
- **Frontend:** React + TypeScript + Vite + Tailwind + TanStack Query + shadcn/ui
- **Auth:** JWT access + refresh tokens, argon2id password hashing, TOTP 2FA

### Conventions

- IDs: `CHAR(36)` UUIDs, app-generated (uuid v4)
- Timestamps: `DATETIME(3)` stored in UTC, displayed in `Africa/Dar_es_Salaam`
- Money: `BIGINT` minor units + `CHAR(3)` currency code — never floats
- API base path: `/api/v1`
- Every list endpoint supports `?page=&page_size=&q=` and returns `{ data, page, page_size, total }`

### Package / repo naming

Use `triserve` for package names — `@triserve/api`, `@triserve/web`, `@triserve/shared` — and **TriServe** in user-facing text.

## Getting started

> **Note:** The monorepo is not scaffolded yet. The commands below describe the intended flow and become live after **Task 0.0** scaffolds the monorepo.

1. `docker compose up` — brings up MySQL 8 + adminer
2. Run Prisma migrations
3. Run the seed script
4. Start both apps in dev mode: `api` and `web`
