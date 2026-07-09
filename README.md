# TriServe

**Product:** TriServe
**Developer:** Tristate Systems Ltd

TriServe is a multi-branch Service Centre Management System with an integrated Point of Sale, built for a Samsung Authorized Service Centre in Tanzania. It manages the full device-repair lifecycle — Samsung in-warranty (IW) jobs as well as out-of-warranty (OW) and other-brand repairs — alongside spare-parts inventory, procurement, point-of-sale, warranty claims, and double-entry accounting. The system is architected from day one to grow into a commercial ERP that can be licensed to other service centres.

The single source of truth for the design is [`docs/DESIGN.md`](docs/DESIGN.md).

## Tech stack

- **Backend:** Node.js + TypeScript + NestJS, Prisma ORM, MySQL 8
- **Frontend:** React + TypeScript + Vite + Tailwind + TanStack Query + shadcn/ui
- **Auth:** JWT access + refresh tokens, argon2id password hashing, TOTP 2FA

## Repository layout

npm workspaces monorepo:

```
/api              @triserve/api    — NestJS backend (Prisma + MySQL 8)
/web              @triserve/web    — React + Vite + Tailwind + shadcn/ui frontend
/packages/shared  @triserve/shared — shared TS types/enums used by both
/docs             design docs (DESIGN.md is the source of truth)
docker-compose.yml — local MySQL 8 (utf8mb4) + Adminer
```

Backend modules live under `api/src/modules/` (auth, companies, branches, users, audit, approvals, accounting — skeletons as of Task 0.0), plus `health/` and `prisma/`.

### Conventions

- **IDs:** `CHAR(36)` UUIDs, generated in the app (uuid v4) — never DB auto-increment for public entities.
- **Timestamps:** stored in **UTC** as `DATETIME(3)`; converted to `Africa/Dar_es_Salaam` in the UI only.
- **Money:** `BIGINT` minor units + a `CHAR(3)` currency column — **never floats**.
- **API base path:** `/api/v1` (set as the NestJS global prefix).
- **List endpoints:** every list endpoint supports `?page=&page_size=&q=` and returns `{ data, page, page_size, total }` (see `PaginatedResponse<T>` in `@triserve/shared`).
- **Errors:** every API error returns `{ error: { code, message, details } }` (global exception filter; see `ApiErrorResponse` in `@triserve/shared`).
- **Validation:** global `ValidationPipe` (class-validator + class-transformer) with `whitelist` + `transform`.
- **DB charset:** MySQL 8, InnoDB, `utf8mb4`.

### Package / repo naming

Use `triserve` for package names — `@triserve/api`, `@triserve/web`, `@triserve/shared` — and **TriServe** in user-facing text.

## Getting started

Prerequisites: Node.js >= 20, npm >= 10, Docker.

1. **Install dependencies** (root — installs all workspaces):

   ```sh
   npm install
   ```

2. **Environment:** copy the env examples and adjust if needed:

   ```sh
   cp .env.example .env          # docker compose (MySQL credentials/ports)
   cp api/.env.example api/.env  # API: DATABASE_URL, PORT, JWT secrets
   cp web/.env.example web/.env  # web: VITE_API_BASE_URL (optional)
   ```

3. **Database:** bring up MySQL 8 + Adminer (Adminer at http://localhost:8080):

   ```sh
   docker compose up -d
   ```

4. **Prisma:** generate the client and run migrations (no models yet as of Task 0.0):

   ```sh
   npm run prisma:migrate        # prisma migrate dev (in /api)
   ```

5. **Run both apps** in dev mode:

   ```sh
   npm run dev                   # api on :3000, web on :5173
   ```

   The Vite dev server proxies `/api` to `http://localhost:3000`, and the API answers `GET http://localhost:3000/api/v1/health`.

## npm scripts (root)

| Script | What it does |
| --- | --- |
| `npm run dev` | run api + web concurrently in watch mode |
| `npm run dev:api` / `npm run dev:web` | run one app |
| `npm run build` | build shared → api → web |
| `npm run lint` | lint api (eslint) and web (oxlint) |
| `npm run prisma:migrate` | `prisma migrate dev` in `/api` |
| `npm run prisma:studio` | Prisma Studio for the dev DB |

Per-workspace scripts can be run with `npm run <script> -w @triserve/<pkg>`.
