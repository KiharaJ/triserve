# TriServe

**Product:** TriServe
**Developer:** Tristate Systems Ltd

TriServe is a multi-branch Service Centre Management System with an integrated Point of Sale, built for a Samsung Authorized Service Centre in Tanzania. It manages the full device-repair lifecycle — Samsung in-warranty (IW) jobs as well as out-of-warranty (OW) and other-brand repairs — alongside spare-parts inventory, procurement, point-of-sale, warranty claims, and double-entry accounting. The system is architected from day one to grow into a commercial ERP that can be licensed to other service centres.

The single source of truth for the design is [`docs/DESIGN.md`](docs/DESIGN.md).

[`docs/SCMS.md`](docs/SCMS.md) documents the seven Service Centre System
modules layered on top of it — intake integrity, skill routing and a QC gate,
BER/device-swap, OTP handover and consignments, an async notification outbox,
SLA metrics, and per-role financial ceilings. It is a companion to DESIGN.md,
not a replacement.

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

Backend modules live under `api/src/modules/`, plus `health/` and `prisma/`:

- **Core:** `auth`, `companies`, `branches`, `users`, `roles`, `audit`,
  `approvals`, `accounting`, `config-tables`, `storage`, `attachments`
- **Operations:** `jobs`, `workflow`, `customers`, `devices`, `models`,
  `dashboard`
- **Stock & trade:** `inventory`, `procurement`, `suppliers`, `products`, `pos`,
  `warranty`
- **Service Centre System** (see [`docs/SCMS.md`](docs/SCMS.md)): `intake`,
  `bench`, `ber`, `logistics`, `notifications`, `sla`

The in-app **`/guide`** page is the staff-facing version of the same thing — one
flow per role, each step linking to the screen that performs it. Its content
lives in `web/src/pages/guide/flows.ts` as data, so a flow can be corrected
without touching the page. Keep it in step with the process; it is what new
staff are pointed at.

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

4. **Prisma:** generate the client and run migrations:

   ```sh
   npm run prisma:migrate        # prisma migrate dev (in /api)
   npx prisma db seed -w @triserve/api   # built-in roles, workflow, config tables
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

## Tests and the test database

`npm test -w @triserve/api` runs against a **separate database**
(`triserve_test` by default, override with `TEST_DATABASE_URL`) — never your
development one.

This is not a nicety. The integration suites are real end-to-end tests: they
create companies, jobs and claims over HTTP and delete them again in
`afterAll`. Pointed at a development database, a teardown that fails part-way
leaves debris that breaks the *next* run, and an over-broad delete filter takes
real rows with it. They previously ran against the dev DB and cost us the
imported customer/device/job history.

How it is enforced:

- `test/jest-env.ts` (`setupFiles`) pins `DATABASE_URL` before any spec is
  imported — each spec builds its own `PrismaClient` at module scope, so this
  has to happen first. It is set explicitly, not with `??`, so the `.env` value
  cannot win.
- `test/jest-global-setup.ts` creates the database if missing, then runs
  `prisma migrate deploy` and the seed. It **refuses to run** unless the
  database name contains `test`.

If you add a spec, do not reintroduce a `?? 'mysql://…/triserve'` fallback.

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

## Deployment

Two hosts, both deploying from `main` — **pushing to `main` deploys to
production.** There is no staging environment and no CI gate in front of it, so
run `npm run build:full` and `npm test -w @triserve/api` before you push.

| Part | Host | Config | URL |
| --- | --- | --- | --- |
| API | Render | `render.yaml` | `https://triserve-api.onrender.com` |
| Web | Vercel | `vercel.json` | `https://triserve-web.vercel.app` |
| Database | Self-hosted MySQL 8 | — | separate host, not managed by either |

**Migrations run on API start.** Render's `startCommand` is
`prisma migrate deploy && node api/dist/main.js`, so a deploy applies any
pending migration to the production database before the new code serves
traffic. Two consequences worth knowing:

- A migration that fails takes the API down with it — the process never reaches
  `main.js`. Check `_prisma_migrations` before assuming the code is at fault.
- There is no automatic backup. Take one before deploying anything that alters
  an existing table:

  ```sh
  mysqldump -h <host> -u <user> -p --single-transaction --routines --triggers \
    --events --databases triserve > triserve-prod-$(date +%Y%m%d-%H%M%S).sql
  ```

  Keep dumps **outside the repo** — they contain full customer records.

**Environment.** Secrets are set in the Render dashboard, not in `render.yaml`
(`sync: false` entries). `CORS_ORIGIN` must list the Vercel URL, and on the web
side `VITE_API_BASE_URL` must be set in Vercel to the Render API's `/api/v1` —
it is baked in at build time, and without it the app falls back to a relative
`/api/v1` that does not exist on the Vercel domain.

**Known gap:** `STORAGE_DRIVER` is `local` in `render.yaml`, and Render's disks
are ephemeral — intake photos, condition evidence and handover signatures are
lost on every redeploy. This wants `s3` (see the section above) before the
intake and BER evidence trails are relied on.
