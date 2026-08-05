# TriServe — Service Centre System (SCMS) modules

**Status:** live in production since 2026-08-05.

This document describes the seven modules added from the *Service Center System
Proposal*. It is a **companion to [`DESIGN.md`](DESIGN.md), not a replacement**:
DESIGN.md specifies the original TriServe system (jobs, inventory, POS,
procurement, accounting), and everything in it still holds. The proposal is a
separate, later document that layers process control on top of that base —
intake integrity, a QC gate, closed-loop core exchange, BER/device-swap,
per-role financial ceilings, an OTP handover chain, and async notifications.

Where the two overlap, DESIGN.md defines the entity and this document defines
the additional gate placed in front of it.

## At a glance

| Module | Adds | Base routes |
| --- | --- | --- |
| Intake integrity | Structured symptoms, condition marks, terms acceptance | `/symptom-nodes`, `/condition-zones`, `/jobs/:id/condition`, `/jobs/:id/terms`, `/jobs/:id/intake-readiness` |
| Bench: skills & QC | Skill-based routing, QC checklist gate | `/skills`, `/qc-checklist`, `/jobs/:id/routing`, `/jobs/:id/qc`, `/jobs/:id/qc-approve`, `/jobs/:id/qc-reject` |
| BER & device swap | Beyond-economic-repair certification, swap stock | `/jobs/:id/ber/evaluate`, `/ber/:id/certify`, `/ber/:id/certificate`, `/swap-stock`, `/jobs/:id/swap` |
| Logistics | OTP handover, consignments, CSAT | `/jobs/:id/collection-otp`, `/consignments`, `/csat` |
| Notifications | Async outbox + templates | `/notifications`, `/notifications/drain`, `/notification-templates` |
| SLA | Per-job metrics, breach queue | `/jobs/:id/metrics`, `/sla/queue`, `/reports/sla` |
| Financial ceilings | Per-role approval limits, public quote approval | `/roles/*` limits, `/invoices/*`, `/public/quote` |

All routes sit under the `/api/v1` global prefix and are auth-guarded, except
the two public ones described below.

## Schema

Two additive migrations, both applied to production on 2026-08-05:

- `20260728093505_scms_proposal_modules` — 20 new tables:
  `symptom_nodes`, `condition_zones`, `job_condition_marks`, `user_skills`,
  `job_state_events`, `qc_checklist_items`, `job_qc_checks`, `ber_assessments`,
  `ber_certificate_counters`, `swap_units`, `device_swaps`, `role_limits`,
  `job_collection_otps`, `consignments`, `consignment_jobs`,
  `consignment_scans`, `consignment_counters`, `csat_surveys`,
  `notification_templates`, `notifications`.
- `20260728113433_scms_job_child_cascade` — adds `ON DELETE CASCADE` from a job
  to its new children. It drops and recreates foreign keys, but only on tables
  the migration above created; no pre-existing table or row is touched.

No column was dropped or retyped on any pre-existing table, which is why this
set could be deployed against live data without a maintenance window.

## The modules

### 1. Intake integrity

Stops a job being opened on guesswork. Three parts:

- **Symptom nodes** — a tree of selectable faults, so "screen flickers" is a
  node rather than free text, and reporting can group by it.
- **Condition zones + marks** — named regions of a device (`condition_zones`)
  against which the advisor records pre-existing damage at intake
  (`job_condition_marks`). This is the evidence that settles "it was already
  cracked when I brought it in".
- **Terms acceptance** — `POST /jobs/:id/terms` records the customer accepting
  the repair terms.

`GET /jobs/:id/intake-readiness` reports whether all of the above is present.
The `intake_evidence_complete` workflow guard blocks the job leaving intake
until it is.

**Device identifiers** are validated at intake by
`packages/shared/src/identifiers.ts` — IMEIs must be 15 digits *and* pass a
Luhn check digit (`isValidImei`, `imeiCheckDigit`), other categories match
per-category serial rules (`validateDeviceIdentifier`). Enforced in both
`devices.service.ts` and job intake, so a typo'd IMEI cannot enter the system
from either direction.

### 2. Bench — skills and QC

- **Skills** (`user_skills`, `/skills`) tag a technician with what they are
  competent to work on. `GET /jobs/:id/routing` suggests who should take a job.
  The `engineer_skill_match` guard enforces the match — but only when a
  technician is actually assigned. It is a *matching* rule, not an assignment
  rule, so it allows an unassigned job through; advisors routinely advance a
  job before anyone has picked it up.
- **QC checklist** (`qc_checklist_items`, `job_qc_checks`) is a configurable
  list a job must pass before it can be handed back. `qc-approve` /
  `qc-reject` close it out, and the `qc_checklist_passed` and
  `qc_failure_logged` guards mean a job cannot skip the gate or fail it
  silently.
- `PATCH /jobs/:id/work` records what was actually done; the
  `repair_work_declared` guard requires it before completion.

### 3. BER and device swap

When a repair costs more than the device is worth, it is certified
**beyond economic repair** rather than quietly abandoned:

`POST /jobs/:id/ber/evaluate` produces a `ber_assessments` row → a manager
certifies or rejects it → `POST /ber/:id/outcome` records what the customer
chose. `GET /ber/:id/certificate` issues a numbered certificate, with numbers
allocated from `ber_certificate_counters` so they are gapless and auditable.

**Device swap** (`swap_units`, `device_swaps`) is the other outcome: a unit
from swap stock is issued against the job. The `ber_not_blocking` guard stops a
job with an open BER assessment being completed as a normal repair.

### 4. Logistics — handover, consignments, CSAT

- **Collection OTP** — at handover the system issues a one-time PIN
  (`job_collection_otps`) delivered through the notification outbox; the
  counter verifies it before releasing the device. The
  `collection_otp_verified` guard makes this mandatory, so a device cannot be
  handed to whoever turns up with a job number.
- **Consignments** — the chain-of-custody record for moving devices between
  branches: create, add/remove jobs, dispatch, scan in transit, arrive, cancel.
  Totes are addressable by label (`/consignments/by-tote/:label`) so a scan can
  find the consignment without knowing its id.
- **CSAT** — a post-repair satisfaction survey, answered by the customer on a
  public page.

### 5. Notifications

An **outbox**: application code writes a `notifications` row rather than
calling an SMS or email provider inline, and delivery is drained separately
(`POST /notifications/drain`, with `/notifications/:id/retry` for failures).
The job flow therefore never blocks on, or fails because of, a third-party
gateway. Message bodies come from editable `notification_templates`.

### 6. SLA

`GET /jobs/:id/metrics` derives per-job timings from `job_state_events` (the
append-only record of every state change). `/sla/queue` lists what is breaching
or close to it, and `/reports/sla` aggregates.

### 7. Financial ceilings

`role_limits` gives each role a monetary ceiling; `role-limits.service.ts`
enforces it, so an advisor can approve a small quote but a large one escalates.

An **8th built-in role, `FLOOR_SUPERVISOR`**, was added
(`packages/shared/src/permissions.ts`) — the proposal's role matrix needs a
rung between technician and Centre Manager.

## Workflow guards

Guards are how all of the above is enforced at the state machine rather than in
each screen. Two changes in `workflow/guards/registry.ts`:

- `guard_code` accepts a **comma-separated list**; every guard must pass.
- Guards return `{ ok, reason }` instead of a bare boolean, so a refusal can
  explain itself.

Registered guards: `ow_quote_approved`, `intake_evidence_complete`,
`engineer_skill_match`, `repair_work_declared`, `qc_checklist_passed`,
`qc_failure_logged`, `core_returns_complete`, `ber_not_blocking`,
`collection_otp_verified`.

`allowed_next_transitions` **keeps** guard-blocked edges in its response and
attaches `blocked_reason` / `blocked_guard`; only *permission* failures are
dropped. The UI renders those edges disabled with a `held` badge and the
guard's reason as the tooltip. Hiding them would waste the point of having
guards that explain themselves — the user needs to see the move exists and why
they cannot make it.

## Public (unauthenticated) pages

Two pages are served outside `RequireAuth` / `AppShell` in `web/src/App.tsx`:

| Route | Page | API |
| --- | --- | --- |
| `/quote/:token` | Customer approves/declines an OW quote | `/public/quote` |
| `/csat/:token` | Post-repair satisfaction survey | `/public/csat` |

Both use `web/src/lib/public-api.ts`, a bare axios instance — deliberately
**not** the shared `api` client, whose interceptors would attach a staff bearer
token and whose 401 handler would sign a logged-in employee out of their own
session while they looked at a customer page.

These paths must stay in sync with the links the API mints
(`PUBLIC_BASE_URL` + `/quote/{token}` / `/csat/{token}`).

## Screens

Job detail gained four tabs — `intake`, `qc`, `core-exchange`, `ber` (the BER
tab is gated on `job.ber.evaluate|certify`) — plus a handover tab for OTP issue
and verification. New top-level screens: `/consignments`, `/swap-stock`,
`/skills`, `/comms`.
