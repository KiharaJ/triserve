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

## Inventory migration importer (Task 2.10, DESIGN.md §10 / §4.4b)

Load the real parts catalogue + opening stock from the spreadsheets. Export
each sheet to CSV, then (from `/api`):

```sh
npm run import:inventory -- --parts parts.csv --stock stock.csv --dry   # preview
npm run import:inventory -- --parts parts.csv --stock stock.csv         # apply
```

`--dry` parses, validates and reports without writing. The import is idempotent
and non-destructive (parts/suppliers upserted; opening stock set only when an
inventory row is first created, so re-running never resets moved stock; each
opening RECEIPT ledger row written once). The full CSV column format is
documented at the top of `api/scripts/import-inventory.ts`; see
`api/scripts/sample-parts.csv` / `sample-stock.csv` for a worked example. Money
is entered in whole units (USD dollars, TZS shillings) and stored as minor
units. Target a different tenant with `--company "<name>"`.

## Object storage / attachments (Task 1.4, DESIGN.md §4.12)

Attachments (signature capture, before/after repair photos, …) are stored in
object storage — never in the DB — via `StorageService`
(`api/src/modules/storage/storage.types.ts`), which has two interchangeable
drivers selected by `STORAGE_DRIVER` in `api/.env`:

| `STORAGE_DRIVER` | Backing store | When to use |
| --- | --- | --- |
| `local` (default) | Filesystem, under `STORAGE_LOCAL_DIR` (default `api/.storage`, gitignored) | No Docker/MinIO available (this repo's default dev setup) |
| `s3` | Real S3-compatible bucket (MinIO in `docker-compose.yml`'s optional `minio` service, or real AWS S3/any S3-interop store) | Docker available, or a staging/prod environment |

Both drivers implement the exact same interface (`putObject` /
`getPresignedGetUrl` / `deleteObject`) — **switching drivers is a one-line
env change with zero code changes** anywhere else in the app.

- **local driver:** "presigned" GET URLs are an HMAC-signed, expiring app
  route (`GET /attachments/file/:token`, signed with `STORAGE_URL_SECRET`)
  that streams the file with the right content-type. The token carries the
  storage key + mime + expiry, tamper-proofed with HMAC-SHA256 — the client
  never sees the on-disk path or any credential, same safety property as a
  real presigned URL, just without needing a bucket.
- **s3 driver:** real presigned GET URLs straight from the bucket (via
  `@aws-sdk/s3-request-presigner`) — the API never proxies file bytes.

To run against real MinIO instead: uncomment the `minio` service in
`docker-compose.yml`, create the bucket once (see the comment above it), and
set in `api/.env`:

```sh
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_BUCKET=triserve-attachments
STORAGE_ACCESS_KEY=minioadmin
STORAGE_SECRET_KEY=minioadmin
STORAGE_REGION=us-east-1
STORAGE_FORCE_PATH_STYLE=true
```

See `api/.env.example` for the full list of `STORAGE_*` variables (upload
size cap, presigned URL TTL, etc.) — the mime allowlist (PNG/JPEG/WEBP
images, PDF, MP4) is fixed per DESIGN.md §4.12.
