# TriServe — Service Centre Management System + POS — Design Specification

**Product name:** **TriServe**
**Developed by:** Tristate Systems Ltd
**Version:** 2.0 (draft for review) — MySQL; procurement (PO→GRN→payables); ERP extensions from design review: double-entry accounting, CRM 360, device history, attachments, configurable workflow, generic approvals, stock-status buckets, serial tracking, notifications engine, knowledge base, multi-company, security hardening, full BI/reporting, Samsung-integration abstraction, AI features
**Prepared for:** Multi-branch Samsung Authorized Service Centre (ASC), Tanzania
**Intended use:** Hand this document to Claude Code as the build brief. Review, edit, and cut it into tasks per the phased roadmap at the end.

---

## 1. Context & Goals

### 1.1 What this business does
A multi-branch **Samsung Authorized Service Centre (ASC)** operating in Tanzania. Branches seen in current data: **Dar es Salaam (HQ), Kariakoo, Arusha, Mlimani, Dodoma**. The business:

- Repairs Samsung devices under **In-Warranty (IW)** — Samsung reimburses labour/parts, tracked by **Claim No.**, valued in **USD**.
- Repairs devices **Out-of-Warranty (OW)** — customer pays cash, quoted/collected in **TZS**. This is the **POS** side.
- Also services **other brands** and sells **products, parts and accessories** over the counter.
- Handles multiple product categories: **HHP** (handheld/phones), **CE** (consumer electronics/TV), **AC** (air conditioning), **REF** (refrigeration).
- Holds a **spare-parts inventory** keyed on Samsung part numbers (e.g. `GH82-33385A`), with bin locations, per-branch stock, receipts and consumption.

### 1.2 Problems with the current spreadsheet workflow
Observed directly in the uploaded files:

- **Schema drift**: column names and layouts change month to month (`CASH NOV` vs `CASH JANUARY 2026` vs merged/`Unnamed` headers in later months). No enforced structure.
- **No link between a repair and the parts it consumed** — the sales report lists "A06 LCD" as free text; inventory tracks `GH82-…` part numbers separately. Reconciliation is manual.
- **Manual weekly stock grids** (wk1…wk5, per-day columns) that must be summed by hand; error-prone, no live stock balance.
- **Dual currency handled ad hoc** — USD for IW claims, TZS for OW cash, mixed in the same columns.
- **No cross-branch consolidation** — each branch keeps its own file; HQ can't see a live group picture.
- **Free-text everything** — model names, faults, engineer initials (AH, AM, FM, TH, NR, BL…), payment status. No validation, no reporting integrity.
- **No audit trail** — who changed what, when, is invisible.

### 1.3 Goals of the new system
1. One **cloud** system, all branches live (reliable internet assumed; see §12 on graceful degradation).
2. A single **job/repair lifecycle** from intake → diagnosis → parts → repair → dispatch → payment/claim.
3. **Integrated POS** for OW repairs, product sales, and accessory/parts sales.
4. **Live multi-branch inventory** with automatic stock deduction when parts are consumed on a job.
5. **Warranty claim tracking** with USD valuation and Samsung claim reconciliation.
6. **Dual currency** (TZS base for cash, USD for warranty) handled as a first-class concept.
7. **Role-based access** and full **audit logging**.
8. Reporting that reproduces (and improves on) the existing daily IW/OW summaries, per branch and consolidated.
9. A clean **data import** path from the existing spreadsheets.
10. Architected to grow into a **commercial ERP** — double-entry accounting, configurable workflow, multi-company, CRM, BI and AI — without a rebuild (see §12b).

---

## 2. Core Domain Model (plain-language)

The system revolves around a **Job** (a device brought in for service). Everything hangs off it:

- A **Customer** brings in a **Device** → a **Job** (job card) is opened.
- The Job records **fault reported**, **warranty status**, **assigned engineer**, and a lifecycle **status**.
- During repair, **Parts** are consumed from **Inventory** (creating stock movements) and **Labour/Services** are added.
- The Job resolves as **IW** (a **Warranty Claim** to Samsung, USD) and/or **OW** (an **Invoice** paid via **POS**, TZS).
- Separately, a walk-in can buy a **Product/Accessory** straight through **POS** with no Job.
- On the **inbound** side, spares are ordered from a **Supplier** via a **Purchase Order**; when the delivery arrives a **Goods Received Note** posts it into **Inventory** (and optionally a **Supplier Bill** tracks what's owed). So stock goes **up** from purchasing and **down** from repairs/sales — every movement traceable to its cause.
- Everything is scoped to a **Branch** and attributed to a **User**.

---

## 3. Roles & Permissions

| Role | Scope | Key permissions |
|---|---|---|
| **Super Admin** | Group (all branches) | Everything; user mgmt; price lists; part catalogue; settings; FX rates. |
| **Branch Manager** | One branch | View/manage all jobs, POS, inventory, staff, branch reports; acts as the **approver** for the generic approvals framework (E8): discounts, price overrides, refunds, stock adjustments/transfers, POs, warranty cancellations, invoice voids, job reopens. |
| **Service Advisor / Front Desk** | One branch | Create customers, open job cards, capture photos/signature, take deposits, run POS, dispatch, print receipts. |
| **Technician / Engineer** | One branch | See assigned jobs, add tech report, reserve/consume parts, mark repair done; **performance is tracked (E5)**: diagnosis/repair time, first-time-fix, repeat rate, warranty-rejection rate, jobs completed, revenue generated. |
| **Storekeeper / Inventory** | One branch | Receive stock (GRN), raise/track purchase orders, transfer between branches, cycle-count, adjust (with reason). Large POs may need Manager approval. |
| **Warranty Clerk** | Branch or group | Manage warranty claims, submit/reconcile with Samsung, track USD reimbursements. |
| **Accountant / Auditor** | Group (read-mostly) | All financial reports, audit log, exports; no operational edits. |

Permissions enforced server-side per endpoint, not just hidden in UI. Branch-scoped users cannot read another branch's data unless granted group scope.

---

## 4. Data Model / Database Schema

> Target: **MySQL 8.0+** (InnoDB engine, `utf8mb4`). All tables have `id`, `created_at`, `updated_at`, `created_by`, `updated_by`. Soft-delete via `deleted_at` where destructive deletes are undesirable (customers, parts, jobs). Money stored as integer minor units (cents/senti) **plus** an explicit currency code — never floats.
>
> **MySQL conventions used below** (where the tables say "uuid" / "timestamptz" / "numeric", read them as the MySQL equivalents):
> - **Primary keys / FKs:** `CHAR(36)` UUID **or** `BIGINT UNSIGNED AUTO_INCREMENT` — pick one convention and keep it consistent. UUIDs are recommended here so records can be created offline/at any branch without key collisions (relevant if offline mode is ever added). Store as `CHAR(36)`, or `BINARY(16)` with `UUID_TO_BIN()` if you want them compact.
> - **Timestamps:** `DATETIME(3)` (or `TIMESTAMP`) in UTC — MySQL has no `timestamptz`; store UTC and convert to East Africa Time in the app layer.
> - **Enums:** either native MySQL `ENUM(...)` **or** a `VARCHAR` + `CHECK` constraint (MySQL 8.0.16+ enforces CHECK). Native `ENUM` is simplest; a lookup table is better if values change often.
> - **Money:** `BIGINT` minor units + `CHAR(3)` currency code. (Where a table says `numeric`, use `DECIMAL(18,4)` only for rates/costs, never for stored transaction totals.)
> - **JSON columns** (audit before/after): MySQL native `JSON` type.
> - **Text:** `VARCHAR(n)` for bounded fields, `TEXT` for notes. Use `utf8mb4` so IMEIs, names and Swahili text are safe.
> - **Concurrency:** InnoDB row locking (`SELECT … FOR UPDATE`) for the stock-decrement and payment paths — see §11.

### 4.1 Reference / org

**companies** (multi-company / multi-tenant support — see ERP extension E9)
| column | type | notes |
|---|---|---|
| id | PK | |
| name | varchar | "Samsung ASC Group", could later host LG/Hisense/Tecno service arms or wholly separate businesses |
| legal_name, tin/vrn | varchar | tax identifiers (TRA TIN/VRN in TZ) |
| base_currency | char(3) | `TZS` |
| logo_url, address, phone | varchar | for receipts/reports |
| active | bool | |

> Every operational table below carries a `company_id` (directly or via `branch_id → branches.company_id`). At launch there is one company; the column exists from day one so multi-company is a config change, not a rebuild. All queries and permissions are company-scoped first, branch-scoped second.

**branches**
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| company_id | FK→companies | |
| code | text unique (per company) | e.g. `DAR`, `KRK`, `ARU`, `MLM`, `DOD` |
| name | text | "Dar es Salaam ASC" |
| is_hq | bool | |
| address, phone, tz_region | text | |
| active | bool | |

**users**
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| full_name | text | |
| initials | text | maps legacy engineer codes (AH, AM, FM, TH…) |
| email / phone | text | login identity |
| password_hash | text | |
| role | enum | see §3 |
| home_branch_id | uuid FK→branches | |
| scope | enum(`branch`,`group`) | |
| active | bool | |

**fx_rates**
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| base_ccy | text | `TZS` |
| quote_ccy | text | `USD` |
| rate | numeric(18,6) | 1 USD = X TZS |
| effective_date | date | |
| Purpose: convert USD warranty values ↔ TZS for consolidated reporting. Rate chosen by `effective_date`. |

### 4.2 Customers & devices

**customers** (CRM — see ERP extension E2)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| company_id | FK | |
| name | text | |
| phone | text indexed | primary lookup key |
| alt_phone, email | text | |
| location | text | e.g. "Mbezi Beach", "Ubungo" |
| dealer_name | text nullable | some jobs come via dealers |
| is_dealer | bool | |
| preferred_branch_id | FK→branches | |
| preferred_language | enum(`EN`,`SW`) | drives SMS/notification language |
| rating | tinyint nullable | 1–5, internal customer rating/flag |
| notes | text | |

> **Customer 360 (E2):** the customer record itself stays lean; the rich profile — devices owned, full repair history, purchases, warranty history, communication/SMS log, outstanding balance, lifetime spend, last visit — is **assembled by the API** from related tables (jobs, invoices, payments, notifications, warranty_claims), not duplicated as columns. One `GET /customers/{id}/profile` endpoint returns the whole 360 view. Outstanding balance and lifetime spend are computed, never stored, so they can't drift.

**devices** (device history — see ERP extension E3)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| company_id | FK | |
| customer_id | uuid FK | current owner (ownership can change; history preserved) |
| brand | text | `Samsung` default; supports others |
| model | text | free-ish but linked to `models` lookup when possible |
| category | enum(`HHP`,`CE`,`AC`,`REF`,`OTHER`) | |
| imei_serial | text indexed unique-ish | IMEI or S/N; nullable (some CE/AC lack it) |
| color | text | |

> **Device history (E3):** because every `job`, `warranty_claim` and `job_parts` row references `device_id`, the device becomes a timeline. `GET /devices/{id}/history` returns every repair, part replaced, warranty claim and software action in order — so an engineer immediately sees "this mainboard has already been replaced twice." No separate storage needed; it's a view over existing FKs. Key the device on IMEI/serial so it persists across owners.

**models** (lookup, seeded from data + Samsung catalogue)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| model_code | text | `A05`, `A06`, `S23 Ultra`, `Z Fold 7`, `UA40M5000`… |
| category | enum | |
| brand | text | |
| Normalises the messy free-text model column. |

### 4.3 Jobs (the heart)

**jobs**
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| job_no | text unique | human-friendly, branch-prefixed (e.g. `DAR-2026-004512`) |
| so_number | text | Samsung SO / job card number (`4.29260291E9` → store as clean string) |
| branch_id | uuid FK | |
| customer_id | uuid FK | |
| device_id | uuid FK | |
| booked_by | uuid FK→users | front desk |
| assigned_engineer_id | uuid FK→users | |
| warranty_status | enum(`IW`,`OW`,`GOODWILL`,`UNKNOWN`) | legacy Y/N → IW/OW |
| fault_reported | text | "NOT TOUCHING", "NOT CHARGING"… (link to `fault_codes` lookup) |
| tech_report | text | "LCD REPLACED", "SUB PBA", "FRP UNLOCK"… |
| status | enum | see §5 lifecycle |
| received_at | timestamptz | |
| ready_at | timestamptz | |
| dispatched_at | timestamptz | |
| dispatched_by | uuid FK→users | |
| received_by_customer | text | name of collector/agent |
| waybill_no | text | for dispatched/returned units |
| claim_id | uuid FK→warranty_claims | nullable |
| invoice_id | uuid FK→invoices | nullable (OW) |
| notes | text | |

**fault_codes**, **repair_actions** — small lookups to normalise the free-text fault/repair columns (FRP, Check-up, LCD Replaced, Sub PBA, Software, Tap Glue, Battery, etc.). Each optionally carries a **default labour price** and **default service type** (e.g. "FRP unlock = 15,000–20,000 TZS", "Check-up = 20,000–50,000 TZS by model").

### 4.4 Parts / inventory

**parts** (group catalogue — one row per part number)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| company_id | FK | |
| part_number | text unique | `GH82-33385A` |
| description | text | "S928B LCD OLED" |
| category | enum(`HHP`,`CE`,`AC`,`REF`) | |
| unit_cost_usd | numeric | landed cost (USD) — from inventory "Unit Price" |
| default_sell_price_tzs | numeric | OW sell price |
| compatible_models | text[] / join | which models it fits |
| is_serialized | bool | if true, tracked unit-by-unit in `part_units` (E11) |
| preferred_supplier_id | FK→suppliers nullable | drives suggested-reorder grouping |
| active | bool | |

**inventory** (stock **per branch per part**) — see stock-status model (E10)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| branch_id | uuid FK | |
| part_id | uuid FK | |
| bin_location | text | `A3`, `B1`, `D2`… (from LOC column) |
| qty_on_hand | int | total physically present; derived from movements |
| qty_reserved | int | allocated to open jobs but not yet consumed |
| qty_in_transit_in | int | on an inbound transfer not yet received |
| qty_damaged | int | present but not sellable/usable |
| reorder_level | int | triggers low-stock alert |
| unique(branch_id, part_id) | | |

> **Available stock (E10)** = `qty_on_hand − qty_reserved − qty_damaged`. This is the number screens and reorder logic use. Example from the review: 20 LCDs on hand, 5 reserved to jobs, 1 damaged → **14 available** (parts in transit sit on the *destination* branch's `qty_in_transit_in` until the GRN/transfer-in posts). Reserving a part when it's added to a job (before repair) prevents two engineers promising the same last unit.

**stock_movements** (append-only ledger — the source of truth for the quantity buckets)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| branch_id, part_id | uuid FK | |
| movement_type | enum(`RECEIPT`,`CONSUMPTION`,`TRANSFER_OUT`,`TRANSFER_IN`,`ADJUSTMENT`,`SALE`,`RETURN`,`SUPPLIER_RETURN`,`RESERVE`,`UNRESERVE`,`DAMAGE`) | |
| qty | int | signed (+in / −out) |
| ref_type | enum(`JOB`,`GRN`,`TRANSFER`,`POS_SALE`,`COUNT`,`ADJUSTMENT`) | `GRN` links a receipt to its goods-received note (and through it to the PO/supplier) |
| ref_id | uuid | the job/GRN/transfer/sale that caused it |
| unit_cost | bigint | cost at time of movement, minor units (for valuation) |
| cost_currency | char(3) | `USD` for Samsung parts, `TZS` for local buys |
| reason | text | required for ADJUSTMENT/DAMAGE |
| moved_by | uuid FK→users | |
| moved_at | timestamptz | |

**part_units** (optional serial/batch tracking — see E11; enable per part via `parts.is_serialized`)
| column | type | notes |
|---|---|---|
| id | PK | |
| part_id | FK→parts | |
| serial_no / batch_no | varchar | Samsung part serial or batch lot |
| branch_id | FK | current location |
| supplier_id, grn_id | FK | provenance (who supplied, which delivery) |
| status | enum(`IN_STOCK`,`RESERVED`,`INSTALLED`,`RETURNED`,`DAMAGED`) | |
| installed_on_job_id | FK→jobs nullable | which repair it went into |
| removed_from_job_id | FK→jobs nullable | for pulled/faulty parts |
| warranty_expiry | date nullable | part-level warranty |
| Purpose: recall handling, "which exact unit failed", supplier-quality traceability. High-value parts (LCDs, PBAs) are the candidates; cheap consumables (tape/glue) stay quantity-only. |

> **Key rule:** `inventory.qty_on_hand` is recomputed from `stock_movements`. Consuming a part on a job writes a `CONSUMPTION` row and decrements stock atomically. This replaces the entire manual weekly grid.

**stock_transfers** (header for inter-branch moves; `transfer_no`, `from_branch_id`, `to_branch_id`, `status`, `dispatched_at`, `received_at`) with **stock_transfer_lines** (`part_id`, `qty`). A transfer writes `TRANSFER_OUT` at source on dispatch and `TRANSFER_IN` at destination on receipt.

### 4.4b Procurement / stock buying (ordering spares)

This is the inbound side: **you order spares from a supplier (Samsung parts distributor or other vendor), the order arrives, you receive it into stock, and you track what you owe and what you've paid.** Full audit trail from "we ordered it" to "it's on the shelf and paid for."

Flow: **Purchase Requisition (optional) → Purchase Order → Goods Received Note → (Supplier Invoice / Bill → Payment)**.

**suppliers**
| column | type | notes |
|---|---|---|
| id | PK | |
| name | varchar | "Samsung Parts Distributor", local vendors |
| contact_person, phone, email | varchar | |
| address | varchar | |
| default_currency | char(3) | often `USD` for Samsung parts, `TZS` for local |
| lead_time_days | int | expected delivery time — feeds reorder suggestions |
| payment_terms | varchar | e.g. "30 days", "prepaid" |
| active | bool | |

> **Supplier performance (E9-proc):** computed from PO/GRN history — average delivery days (expected vs actual GRN date), late-delivery count, wrong/rejected-qty rate (from `grn_lines.qty_rejected`), price history per part, and an overall ranking. Surfaced on the supplier profile and used to pick the preferred supplier for suggested reorders. The fuller procurement chain adds an optional front end: **Supplier Quotation → Purchase Requisition → PO → Approval → GRN → Supplier Invoice → Payment**, where quotations let you compare vendor prices before raising a PO.

**purchase_orders** (the order you send to a supplier)
| column | type | notes |
|---|---|---|
| id | PK | |
| po_no | varchar unique | branch/group-prefixed, e.g. `PO-DAR-2026-0007` |
| supplier_id | FK→suppliers | |
| branch_id | FK→branches | branch the stock is destined for (or a central store) |
| status | enum(`DRAFT`,`SUBMITTED`,`APPROVED`,`ORDERED`,`PARTIALLY_RECEIVED`,`RECEIVED`,`CANCELLED`) | |
| currency | char(3) | |
| order_date | date | |
| expected_date | date | order_date + supplier lead time |
| subtotal, tax, shipping, total | bigint minor units | |
| ordered_by | FK→users | |
| approved_by | FK→users | nullable; approval gate for large orders |
| notes | text | |

**purchase_order_lines**
| column | type | notes |
|---|---|---|
| id | PK | |
| po_id | FK→purchase_orders | |
| part_id | FK→parts | |
| qty_ordered | int | |
| qty_received | int | running total, updated by each GRN |
| unit_cost | bigint minor units | agreed buying price |
| currency | char(3) | |
| line_status | enum(`PENDING`,`PARTIAL`,`RECEIVED`,`CANCELLED`) | |

**goods_received_notes** (GRN — records an actual delivery against a PO)
| column | type | notes |
|---|---|---|
| id | PK | |
| grn_no | varchar unique | |
| po_id | FK→purchase_orders | a PO can have several GRNs (partial deliveries) |
| branch_id | FK→branches | where stock physically landed |
| received_date | date | |
| received_by | FK→users | storekeeper |
| supplier_delivery_ref | varchar | supplier's delivery note / waybill |
| notes | text | |

**grn_lines**
| column | type | notes |
|---|---|---|
| id | PK | |
| grn_id | FK→goods_received_notes | |
| po_line_id | FK→purchase_order_lines | |
| part_id | FK→parts | |
| qty_received | int | this delivery only |
| qty_rejected | int | damaged/wrong parts sent back |
| unit_cost | bigint minor units | actual landed cost (may differ from PO) |
| bin_location | varchar | where it was shelved |

> **Key rule:** posting a GRN is what actually moves stock. Each `grn_line` writes a `RECEIPT` row into `stock_movements` (`ref_type = 'GRN'`, `ref_id = grn_id`, `unit_cost` from the GRN), increments `inventory.qty_on_hand`, and bumps `purchase_order_lines.qty_received`. When all lines are fully received the PO flips to `RECEIVED` (or `PARTIALLY_RECEIVED`). This gives you the complete chain: **which supplier, which PO, when it arrived, at what cost, into which bin.**

**supplier_bills** + **supplier_payments** (optional, Phase 2/6 — the "what we owe" side)
| supplier_bills | id, bill_no, supplier_id, po_id, currency, total, status(`UNPAID`,`PARTIAL`,`PAID`), due_date |
| supplier_payments | id, bill_id, method, amount, currency, paid_at, reference |
| Lets you track outstanding payables to the Samsung distributor and local vendors — mirror of the customer-payment side. |

**Reorder support:** because `stock_movements` gives live `qty_on_hand` and `parts`/`inventory` carry a `reorder_level`, the system can generate a **suggested purchase order** — list every part at or below reorder level for a branch, grouped by preferred supplier, with suggested order quantities. Storekeeper reviews → converts to a real PO in one click.

### 4.5 Job lines (what was done / used on a job)

**job_parts**
| column | type | notes |
|---|---|---|
| id | uuid PK | job_id FK | part_id FK | qty | unit_sell_price | currency | is_warranty (bool) |
| Consuming here fires a `stock_movements` CONSUMPTION. |

**job_services** (labour / service lines)
| column | type | notes |
|---|---|---|
| id | uuid PK | job_id FK | repair_action_id FK | description | qty | unit_price | currency | is_warranty |
| Captures FEM/LEM/SEM labour codes and check-up/FRP fees. |

> **FEM/LEM/SEM** in the sales reports are Samsung **warranty labour-rate codes**. Model them as an attribute on `job_services` (`labour_code` enum) so IW claims carry the right rate.

### 4.6 POS & payments

**invoices** (OW sale — repair payment, product sale, or parts/accessory sale)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| invoice_no | text unique | branch-prefixed |
| branch_id | uuid FK | |
| customer_id | uuid FK nullable | walk-in allowed |
| job_id | uuid FK nullable | set when it's a repair payment |
| type | enum(`REPAIR_OW`,`PRODUCT_SALE`,`PARTS_SALE`,`ACCESSORY`) | |
| currency | text | usually `TZS` |
| subtotal, discount, tax, total | numeric | |
| status | enum(`DRAFT`,`PARTIAL`,`PAID`,`VOID`,`REFUNDED`) | |
| sold_by | uuid FK→users | |

**invoice_lines** — line items (part/product/service, qty, price). Product sales draw from a **products** table (finished goods/accessories, separate from repair `parts` but can share the movement ledger).

**payments**
| column | type | notes |
|---|---|---|
| id | uuid PK | invoice_id FK | |
| method | enum(`CASH`,`MPESA`,`TIGOPESA`,`AIRTEL`,`CARD`,`BANK`) | mobile money is essential in TZ |
| amount | numeric | |
| currency | text | |
| paid_at | timestamptz | |
| reference | text | M-Pesa txn code etc. |
| Supports **deposit + balance** (the DEPOSIT/BALANCE/TOTAL PAID pattern) via multiple payment rows against one invoice. |

### 4.7 Warranty claims

**warranty_claims**
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| claim_no | text | Samsung claim number (`691010338615`) |
| branch_id, job_id | uuid FK | |
| labour_code | enum(FEM/LEM/SEM) | |
| claim_amount_usd | numeric | the IW value |
| status | enum(`DRAFT`,`SUBMITTED`,`APPROVED`,`REJECTED`,`PAID`) | |
| submitted_at, paid_at | timestamptz | |
| reimbursed_amount_usd | numeric | reconciliation vs claimed |

### 4.8 Audit
**audit_log** — append-only: `actor_user_id`, `company_id`, `branch_id`, `entity_type`, `entity_id`, `action`, `before_json`, `after_json`, `at`. Written by a DB trigger or app middleware on every mutation.

### 4.9 Accounting ledger (double-entry — see ERP extension E1)

This is the biggest addition from the review, and the one most painful to bolt on later, so the tables exist from the start even if the posting rules are switched on in a later phase. **Every financial event posts balanced journal entries**, so the system can produce a real P&L, Balance Sheet, Trial Balance and VAT report — not just a payments list.

**chart_of_accounts**
| column | type | notes |
|---|---|---|
| id | PK | company_id FK |
| code | varchar | e.g. `1000` Cash, `1010` Bank, `1200` AR–Samsung, `1300` Inventory, `2000` AP–Suppliers, `2100` VAT Payable, `4000` Repair Revenue, `4010` Warranty Revenue, `5000` COGS |
| name | varchar | |
| type | enum(`ASSET`,`LIABILITY`,`EQUITY`,`REVENUE`,`EXPENSE`) | |
| is_active | bool | |

**journal_entries** (header) + **journal_lines** (the debits/credits)
| journal_entries | id, company_id, branch_id, entry_date, source_type(`PAYMENT`,`GRN`,`SUPPLIER_PAYMENT`,`WARRANTY`,`ADJUSTMENT`,`MANUAL`), source_id, memo, posted_by |
| journal_lines | id, entry_id FK, account_id FK, debit(bigint minor), credit(bigint minor), currency |
| Rule enforced in code + DB: sum(debit) = sum(credit) per entry. |

**Posting rules (illustrative — configurable per company):**
- Customer pays repair 500,000 TZS → **Dr Cash / Cr Repair Revenue** (+ Cr VAT Payable if taxable).
- Warranty approved → **Dr AR–Samsung / Cr Warranty Revenue** (USD, converted at `fx_rates`).
- Samsung reimburses → **Dr Bank / Cr AR–Samsung**.
- GRN posts stock → **Dr Inventory / Cr AP–Suppliers**.
- Supplier payment → **Dr AP–Suppliers / Cr Bank**.
- Part consumed on a job → **Dr COGS / Cr Inventory** (at valuation cost).

> Posting happens automatically as a side-effect of the operational events (payment, GRN, warranty status change), inside the same DB transaction. The ledger is never edited by hand except through explicit, approval-gated manual journals.

### 4.10 Configurable workflow engine (see E7)

Job statuses and their allowed transitions are **data, not hardcoded enums**, so different companies/branches can configure their own flow.

**workflow_states** (`id`, `company_id`, `code`, `label`, `is_initial`, `is_terminal`, `sort_order`)
**workflow_transitions** (`id`, `from_state_id`, `to_state_id`, `required_role`, `requires_approval`, `guard` — e.g. "OW quote must be approved before IN_REPAIR")

> The lifecycle in §5 becomes the **seeded default** workflow. The engine validates every `POST /jobs/{id}/transition` against `workflow_transitions`. `jobs.status` becomes an FK to `workflow_states`.

### 4.11 Approvals (see E8)

A single generic approvals table covers every gated action, not just discounts.

**approvals**
| column | type | notes |
|---|---|---|
| id | PK | company_id, branch_id |
| type | enum(`PRICE_OVERRIDE`,`REFUND`,`INVENTORY_ADJUSTMENT`,`STOCK_TRANSFER`,`PURCHASE_ORDER`,`WARRANTY_CANCELLATION`,`INVOICE_VOID`,`REOPEN_JOB`,`LARGE_CASH_REFUND`,`MANUAL_JOURNAL`) | |
| ref_type, ref_id | | the entity awaiting approval |
| requested_by, approved_by | FK→users | |
| status | enum(`PENDING`,`APPROVED`,`REJECTED`) | |
| reason | text | required |
| requested_at, decided_at | datetime | |
| Threshold rules (e.g. refunds over X, discounts over Y%) live in config and decide when an approval is required. |

### 4.12 Attachments (see E4)

**attachments** — polymorphic file store.
| column | type | notes |
|---|---|---|
| id | PK | company_id |
| owner_type | enum(`JOB`,`CUSTOMER`,`DEVICE`,`GRN`,`INVOICE`) | |
| owner_id | uuid | |
| kind | enum(`SIGNATURE`,`PHOTO_BEFORE`,`PHOTO_AFTER`,`VIDEO`,`WARRANTY_CARD`,`PURCHASE_RECEIPT`,`DOC`) | |
| file_url | varchar | object storage (S3/GCS); files never in the DB |
| uploaded_by | FK→users | |
| Purpose: capture device condition photos + customer signature **before** repair and results **after** — kills disputes. |

### 4.13 Notifications event engine (see E6)

Rather than SMS calls sprinkled through the code, operational events are published to an engine that fans out to channels.

**notification_templates** (`id`, `company_id`, `event_code`, `channel` enum(`SMS`,`EMAIL`,`WHATSAPP`), `language` enum(`EN`,`SW`), `body`)
**notifications** (`id`, `customer_id`, `job_id`, `event_code`, `channel`, `status`(`QUEUED`,`SENT`,`FAILED`), `sent_at`, `provider_ref`) — doubles as the CRM **communication log**.

> Events (`JOB_CREATED`, `AWAITING_PARTS`, `READY`, `DISPATCHED`, `PAYMENT_RECEIVED`) are emitted once; subscribers deliver on each configured channel. Adding WhatsApp/Email later = add a subscriber, no workflow rewrite.

### 4.14 Configuration tables (see E17)
To avoid hardcoding, these are all editable data (per company): currencies, payment methods, roles/permission matrix, repair actions, fault codes, labour & warranty pricing, claim codes, tax rates, SMS/email/receipt templates, and the workflow above. Anything a second service centre might do differently lives in config, not code.

### 4.15 Knowledge base (see E12)
**kb_articles** (`id`, `company_id`, `model_code`, `symptom`, `diagnosis`, `solution`, `firmware`, `samsung_bulletin_ref`, `tags`, attachments via §4.12) — searchable repair knowledge so technicians stop re-solving the same fault. Full-text index on symptom/diagnosis/solution.

---

## 5. Job Lifecycle (state machine)

```
RECEIVED ─▶ DIAGNOSING ─▶ AWAITING_PARTS ─▶ IN_REPAIR ─▶ QC ─▶ READY ─▶ DISPATCHED ─▶ CLOSED
     │                          │                                    │
     └────────────▶ AWAITING_CUSTOMER_APPROVAL (OW quote) ───────────┘
     └────────────▶ CANCELLED / RETURNED_UNREPAIRED
```

- **RECEIVED**: job card created at front desk. IMEI, fault, warranty status captured.
- **DIAGNOSING**: engineer inspects; writes tech report; determines IW vs OW.
- **AWAITING_CUSTOMER_APPROVAL**: OW only — quote generated, customer must approve/pay deposit.
- **AWAITING_PARTS**: required parts not in stock → triggers reorder/transfer.
- **IN_REPAIR**: parts consumed (stock deducted), labour logged.
- **QC**: quality check.
- **READY**: `ready_at` set; customer notified (SMS).
- **DISPATCHED**: handed back / couriered; `dispatched_at`, collector name, waybill.
- **CLOSED**: IW claim submitted and/or OW invoice fully paid.

Each transition is permission-gated and audit-logged. Illegal transitions rejected server-side.

---

## 6. Key Workflows

### 6.1 Walk-in warranty repair (IW)
1. Front desk finds/creates customer by phone → registers device (IMEI, model, colour).
2. Opens job card → warranty status **IW**, fault reported, assigns engineer. Prints job ticket + SMS to customer.
3. Engineer diagnoses → tech report → consumes parts (stock auto-deducts) → logs FEM/LEM/SEM labour.
4. Warranty clerk creates **warranty_claim** (USD), submits to Samsung, tracks reimbursement.
5. Job → READY → DISPATCHED → CLOSED. No cash from customer.

### 6.2 Out-of-warranty repair (OW) — POS
1–3 as above but warranty status **OW**.
4. System generates a **quote/invoice** (TZS) from parts + labour. Customer approves; pays **deposit** (M-Pesa/cash).
5. Repair completed → **balance** collected → invoice **PAID** → job CLOSED. Receipt printed.

### 6.3 Counter product / accessory / parts sale (pure POS, no job)
1. Cashier scans/selects products → cart → discount (if permitted) → payment(s) → receipt. Stock deducts via `SALE` movement.

### 6.4 Stock receipt & inter-branch transfer
- Storekeeper records inbound shipment → `RECEIPT` movements per part (replaces weekly wk1–wk5 grid).
- HQ can transfer parts branch→branch: `TRANSFER_OUT` at source, `TRANSFER_IN` at destination.
- Low-stock alert when `qty_on_hand ≤ reorder_level`.

### 6.5 Daily close & reporting
- End of day: system produces per-branch **IW summary (USD)** and **OW summary (TZS)** — exactly the two totals the current reports compute by hand — plus payment-method breakdown and parts consumed. Consolidated group view for HQ.

---

## 7. API Design (REST, JSON)

Base: `/api/v1`. Auth: JWT bearer; every request carries branch scope. Standard list endpoints support `?branch_id=&status=&from=&to=&q=&page=&page_size=`.

**Auth**
- `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /me`

**Customers & devices**
- `GET/POST /customers` · `GET/PATCH /customers/{id}` · `GET /customers/{id}/devices` · `GET /customers/{id}/jobs`
- `POST /devices` · `GET /devices?imei=`

**Jobs**
- `GET /jobs` · `POST /jobs` · `GET /jobs/{id}` · `PATCH /jobs/{id}`
- `POST /jobs/{id}/transition` `{to_status, note}` — the ONLY way status changes
- `POST /jobs/{id}/parts` `{part_id, qty}` → consumes stock · `DELETE /jobs/{id}/parts/{lineId}` → reverses movement
- `POST /jobs/{id}/services` `{repair_action_id, labour_code, price}`
- `POST /jobs/{id}/dispatch` `{received_by, waybill_no}`

**Inventory**
- `GET /parts` · `POST /parts` · `PATCH /parts/{id}` (catalogue)
- `GET /inventory?branch_id=&low_stock=true` · `GET /inventory/{partId}?branch_id=`
- `POST /inventory/transfers` · `POST /inventory/adjustments` `{reason}`
- `GET /stock-movements?part_id=&branch_id=&from=&to=`

**Procurement (stock buying)**
- `GET/POST /suppliers` · `GET/PATCH /suppliers/{id}`
- `GET /purchase-orders?status=&supplier_id=&branch_id=` · `POST /purchase-orders` · `GET /purchase-orders/{id}` · `PATCH /purchase-orders/{id}`
- `POST /purchase-orders/{id}/submit` · `POST /purchase-orders/{id}/approve` · `POST /purchase-orders/{id}/cancel`
- `GET /purchase-orders/suggested?branch_id=` → auto-built reorder list from parts at/below `reorder_level`
- `POST /goods-received-notes` `{po_id, lines:[{po_line_id, qty_received, qty_rejected, unit_cost, bin_location}]}` → posts `RECEIPT` movements, updates stock + PO line status
- `GET /goods-received-notes?po_id=&branch_id=&from=&to=`
- `GET/POST /supplier-bills` · `POST /supplier-bills/{id}/payments` (optional, payables)

**POS / invoices / payments**
- `POST /invoices` · `GET /invoices/{id}` · `POST /invoices/{id}/lines` · `POST /invoices/{id}/void`
- `POST /invoices/{id}/payments` `{method, amount, reference}`
- `GET /invoices/{id}/receipt` → printable (PDF/thermal)

**Warranty**
- `GET/POST /warranty-claims` · `PATCH /warranty-claims/{id}` · `POST /warranty-claims/{id}/submit` · `POST /warranty-claims/{id}/reconcile`

**CRM & device history** (E2/E3)
- `GET /customers/{id}/profile` → 360 view (devices, repairs, purchases, warranty, comms log, outstanding balance, lifetime spend, last visit)
- `GET /devices/{id}/history` → full timeline of repairs, parts replaced, claims, software actions

**Accounting** (E1)
- `GET /accounts` (chart of accounts) · `GET /journal-entries?from=&to=&source_type=` · `POST /journal-entries` (manual, approval-gated)
- `GET /reports/profit-and-loss?from=&to=&branch_id=` · `/reports/balance-sheet` · `/reports/trial-balance` · `/reports/vat`

**Approvals** (E8)
- `GET /approvals?status=pending&type=` · `POST /approvals/{id}/approve` · `POST /approvals/{id}/reject` `{reason}`

**Attachments** (E4)
- `POST /attachments` (multipart → object storage) · `GET /attachments?owner_type=&owner_id=` · `DELETE /attachments/{id}`

**Notifications** (E6)
- `GET/POST /notification-templates` · `GET /notifications?customer_id=&job_id=` (also the comms log)

**Knowledge base** (E12)
- `GET /kb?q=&model=` (full-text search) · `GET/POST /kb/{id}`

**Config** (E17)
- `GET/PUT /config/{group}` for currencies, payment-methods, repair-actions, fault-codes, labour-pricing, tax-rates, templates
- `GET/POST /workflow/states` · `GET/POST /workflow/transitions` (E7)

**Reports** (E14/E15/E19)
- Daily sales `?branch_id=&date=` → IW(USD)+OW(TZS); consolidated `?from=&to=`; inventory valuation; **profit by repair / branch / technician**; **parts ageing**, **inventory turnover**, **dead/slow-moving stock**; **warranty-reimbursement ageing**; **customer lifetime value**; **daily cash reconciliation**; **supplier performance**; **branch ranking**; **BI: top failing models, most-replaced parts, repeat failures, warranty-approval %, engineer success %**.
- All reports: `?format=json|csv|xlsx|pdf`

**Admin**
- `GET/POST /companies` · `GET/POST /branches` · `GET/POST /users` (+ permission matrix) · `GET/POST /fx-rates` · `GET /audit-log`

Every mutating endpoint validates company + branch scope + role, writes an audit row, and returns the updated resource.

---

## 8. Screens / UI (front-end)

Responsive web app (works on desk PCs and front-desk tablets). Suggested primary screens:

1. **Login / branch selector** (group users pick active company + branch) — with 2FA (E18).
2. **Role-based dashboards** (E14) — **Operations** (jobs today, waiting parts, avg repair time, ready for pickup, overdue jobs); **Finance** (revenue, gross profit, cash, bank, outstanding, warranty receivables); **Inventory** (stock value, fast movers, dead stock, below reorder, pending orders); **Management** (branch comparison, engineer comparison, warranty vs cash revenue, profit). User sees the dashboards their role allows.
3. **Job intake** — customer search-or-create, device capture (IMEI scan), fault, warranty toggle, engineer assign; **capture before-photos + customer signature** (E4) → prints ticket.
4. **Job board (Kanban)** — columns driven by the **configurable workflow** (E7); drag to transition (permission + approval checked). Technicians see only their assigned jobs.
5. **Job detail** — tabs: Details · Tech report · Parts (consume/reserve) · Services/labour · Payment/Claim · Attachments · History (audit).
6. **POS terminal** — fast cart for counter sales; product/part search; discount (over threshold → approval); split payments (cash + M-Pesa); print receipt.
7. **Inventory** — stock list per branch showing **on-hand / reserved / available / damaged / in-transit** (E10); serialized-part unit view (E11); transfer, adjust; movement history per part; low-stock view.
7b. **Procurement** — suppliers + **performance ranking** (E9); quotations; purchase orders (create/approve/track); **suggested reorder** → one-click draft PO; **receive goods (GRN)** with received/rejected qty and bin; supplier bills/payments (payables).
8. **Warranty claims** — queue by status; submit/reconcile; USD totals; reimbursement ageing.
9. **CRM** — customer 360 (E2): profile, devices owned, repair/purchase/warranty history, comms log, outstanding balance, lifetime spend.
9b. **Device history** — timeline per IMEI (E3): every repair, part, claim, software action.
10. **Reports & BI** (E15/E19) — the full report catalogue with export.
11. **Knowledge base** (E12) — searchable repair articles by model/symptom.
12. **Approvals inbox** (E8) — pending approvals for managers, with reason + decision.
13. **Accounting** (E1) — chart of accounts, journals, P&L, balance sheet, trial balance, VAT.
14. **Admin / Config** (E17) — companies, branches, users/roles + permission matrix, part catalogue, price lists, FX rates, workflow editor, templates, tax, audit log.

Design notes: IMEI/barcode scanning at intake and POS; notifications on status change (E6); every money field shows currency; TZS in whole shillings, USD to 2 dp; UI language follows customer/user preference (EN/SW).

---

## 9. Recommended Tech Stack (proposal — adjust freely)

- **Backend:** Node.js + TypeScript (NestJS) **or** Python (FastAPI). Either is fine; pick your team's strength.
- **DB:** MySQL 8.0+ (InnoDB, utf8mb4). Prisma/TypeORM (Node) or SQLAlchemy + Alembic (Python) for migrations — all support MySQL. Use a managed MySQL service (e.g. AWS RDS / Google Cloud SQL / PlanetScale) with automated backups.
- **Frontend:** React + TypeScript, Vite, Tailwind; TanStack Query for data; a component lib (shadcn/ui or MUI).
- **Auth:** JWT + refresh tokens; bcrypt/argon2 password hashing; role guards.
- **Infra:** Cloud host (single region near TZ, e.g. EU/ZA for latency); managed MySQL with daily backups + point-in-time recovery; object storage (S3/GCS) for receipts/attachments/photos.
- **Auth & security (E18):** JWT + refresh tokens; argon2/bcrypt hashing; **2FA (TOTP)**; session management + device/login history; IP logging; password expiry policy; a **permission matrix** (role × action) rather than coarse roles; API keys for integrations; encryption at rest for sensitive customer PII (phone/IMEI).
- **Integrations:** SMS gateway (e.g. Africa's Talking / Beem for TZ); optional mobile-money payment confirmation; thermal-printer support (ESC/POS) for receipts.
- **Testing:** unit + integration on the stock-movement and payment logic especially (money + inventory must be bulletproof).

---

## 10. Data Migration from the Spreadsheets

A one-off importer (script) that Claude Code builds early, because it validates the schema against real data:

1. **Parts catalogue** ← `FULL_PARTS_INVENTORY` : `PART NUMBER, PART DESCRIPTION, CATEGORY, Unit Price` → `parts`; `OPEN STK, LOC` per branch → seed `inventory` + one opening-balance `RECEIPT` movement.
2. **Customers/devices/jobs** ← `DAR … DATA BASE` (`CASH …` sheets + `RECEIVE&DISPATCH`) : map columns → customers, devices, jobs, warranty_claims, invoices. Handle the schema drift by writing a per-sheet column-mapping config.
3. **Lookups** — build `models`, `fault_codes`, `repair_actions`, `users(initials)` by extracting distinct values (A05/A06/S23…, NOT TOUCHING/NOT CHARGING…, LCD REPLACED/FRP/SUB PBA…, AH/AM/FM/TH/NR/BL…).
4. **Data cleaning rules**: IMEI stored as clean strings (fix `3.5028E14` scientific-notation and masked `****`/`----` values → flag as "unverified"); SO numbers de-scientific-notated; dates normalised to ISO; Y/N warranty → IW/OW.
5. Dry-run mode that reports unmapped rows before committing.

---

## 11. Non-Functional Requirements

- **Security:** HTTPS only; role + branch authorization on every endpoint; passwords hashed; audit log immutable; PII (customer phone/IMEI) access-controlled.
- **Money integrity:** integer minor units; all stock+payment mutations in DB transactions; no floating point.
- **Concurrency:** two clerks can't oversell the same last part — stock decrement uses row locking / atomic check.
- **Backups:** automated daily DB backup + point-in-time recovery; tested restore.
- **Performance:** list endpoints paginated; inventory/reports indexed on `(branch_id, …)`.
- **Localization:** TZS + USD; East Africa Time; English UI (Swahili labels optional later).
- **Auditability:** who/what/when on every change; reports reproducible for any past date.

## 12. Connectivity note
Chosen model is **cloud, reliable internet**. To stay robust cheaply: (a) POS receipt generation and job-ticket printing should work from cached data if the network blips mid-sale, queuing the write; (b) show a clear "offline — retrying" banner rather than losing a sale. Full offline-first sync is explicitly **out of scope** for v1 but the append-only `stock_movements` / `payments` design would make it addable later.

---

## 12b. ERP Extension Catalogue (from design review)

These upgrades turn the app from a service-centre tool into a commercial ERP. Each maps to schema/API above. The ones marked **[core-now]** are baked into the schema from day one because retrofitting them is expensive; the rest are **[additive]** and can land in later phases without reshaping the core.

| # | Extension | Status | Where |
|---|---|---|---|
| E1 | **Double-entry accounting** (COGS, P&L, balance sheet, trial balance, VAT) | **[core-now schema, additive posting]** | §4.9 |
| E2 | **CRM / customer 360** | [additive, mostly a view] | §4.2, API |
| E3 | **Device history timeline** | [additive, view over FKs] | §4.2, API |
| E4 | **Attachments** (signature, before/after photos, warranty card) | [additive] | §4.12 |
| E5 | **Technician performance** (diagnosis/repair time, first-time-fix, repeat rate, warranty-rejection rate, revenue) | [additive report] | §Reports |
| E6 | **Notification event engine** (SMS/Email/WhatsApp, comms log) | [core-now events, additive channels] | §4.13 |
| E7 | **Configurable workflow engine** (states/transitions in tables) | **[core-now]** | §4.10 |
| E8 | **Generic approvals** (override/refund/adjustment/void/reopen…) | **[core-now]** | §4.11 |
| E9 | **Procurement+** (quotation→requisition→PO→GRN→invoice→payment) & **supplier performance** | [additive on §4.4b] | §4.4b |
| E10 | **Stock status buckets** (on-hand/reserved/available/damaged/in-transit) | **[core-now]** | §4.4 inventory |
| E11 | **Serial/batch tracking** (`part_units`) for recalls | **[core-now flag, additive UI]** | §4.4 |
| E12 | **Knowledge base** | [additive] | §4.15 |
| E13 | **Samsung integration abstraction** (claims, warranty verify, firmware, catalogue, bulletins) | [additive, interface now] | below |
| E14 | **Executive dashboards** (ops/finance/inventory/management) | [additive] | §8 |
| E15 | **Business intelligence** (failing models, repeat failures, profitability, seasonality) | [additive report] | §Reports |
| E16 | *(reserved)* | | |
| E17 | **Configuration tables** (everything editable) | **[core-now]** | §4.14 |
| E18 | **Security hardening** (2FA, sessions, permission matrix, encryption) | [core-now auth, additive 2FA] | §11 |
| E19 | **Full report suite** | [additive] | §Reports |
| E20 | **AI features** | [additive, last] | below |

**E13 — Samsung integration (abstract now, implement later).** Even though Samsung APIs aren't wired today, define an internal `SamsungGateway` interface (`submitClaim`, `verifyWarranty(imei)`, `lookupFirmware`, `getPartCatalogue`, `getBulletins`, `getClaimStatus`) with a manual/no-op implementation for v1. When real APIs arrive, swap the implementation — no call-site changes.

**E20 — AI features (high-value differentiators, built last on top of clean data).**
- **AI Fault Assistant** — customer says "phone heats up" → suggests likely causes (battery, charging IC, software, mainboard) ranked from this centre's own repair history for that model.
- **AI Repair Assistant** — for a job, suggests likely parts, links KB guide, estimates time, shows similar past jobs.
- **AI Inventory Forecast** — predicts next month's part demand per branch ("~35 A06 LCDs, 12 batteries") from consumption trends → feeds suggested POs.
- **AI Management Summaries** — turns the dashboards into a plain-language executive brief ("Revenue up 12%, driven by a 21% rise in OW repairs; Arusha highest technician productivity; Kariakoo slower due to LCD shortages").

These sit on top of the structured data the rest of the system produces, which is exactly why they come last — clean jobs/parts/history data is the prerequisite.



## 13. Phased Roadmap (how to task Claude Code)

Ordering principle: **build the [core-now] architectural pieces early** (workflow engine, approvals, config, stock buckets, accounting tables, company_id) so nothing needs re-plumbing; layer the **[additive]** modules on afterwards; AI comes last on top of clean data.

**Phase 0 — Foundations (1–2 sprints)**
Repo scaffold; MySQL + migrations for org/reference (companies, branches, users, fx_rates, models, fault_codes); **config tables (E17)**; auth + **permission matrix + 2FA (E18)**; audit-log middleware; **generic approvals framework (E8)**; empty chart of accounts (E1). Deliverable: login, company/branch/user admin, configurable foundation.

**Phase 1 — Jobs core + workflow engine (2 sprints)**
customers, devices, jobs; **configurable workflow engine (E7)** driving the lifecycle; job intake (with **attachments/signature E4**), job board, job detail. Device is keyed on IMEI so **device history (E3)** works from the start. Deliverable: open/assign/transition a job to dispatch, with photos and configurable states.

**Phase 2 — Inventory & Procurement (2–3 sprints)**
parts, inventory with **status buckets (E10)**, stock_movements, adjustments, transfers, reserve-on-job, low-stock; **`part_units` serial tracking flag (E11)**; suppliers + **PO→GRN→payables (E9)** + suggested reorder + **supplier performance**. **Run the migration importer** to load real parts + opening stock. Deliverable: accurate available-stock and a full buying trail.

**Phase 3 — POS, payments & accounting posting (2 sprints)**
products, invoices, payments (cash + mobile money), deposit/balance, counter sales, receipts — and **switch on double-entry posting (E1)** so every payment/GRN/consumption writes journals. Deliverable: money in the door with a live ledger behind it.

**Phase 4 — Warranty (1 sprint)**
warranty_claims, submit/reconcile, USD valuation, FEM/LEM/SEM codes, reimbursement ageing; warranty postings (AR–Samsung). **Define the Samsung gateway interface (E13)** with manual implementation. Deliverable: IW claims end-to-end.

**Phase 5 — CRM, reporting, dashboards & BI (2 sprints)**
customer 360 (E2); the full report suite (E19) incl. **technician performance (E5)** and **BI (E15)**; **role dashboards (E14)**; **notification event engine (E6)** with SMS (Email/WhatsApp as additional subscribers); knowledge base (E12); financial statements (P&L, balance sheet, trial balance, VAT). Deliverable: HQ sees the whole group live, customers get notified, technicians get measured.

**Phase 6 — AI & polish (ongoing)**
AI fault/repair assistants, inventory forecast, management summaries (E20); barcode/IMEI scanning hardening; WhatsApp/Email channels; real Samsung API implementations when available; backup/restore drill; full spreadsheet history import.

---

## 14. Open Questions for You to Confirm

1. **Tax:** is VAT/EFD (TRA electronic fiscal device) receipting required? This affects invoice/receipt design significantly in Tanzania.
2. **Mobile money:** do you want live M-Pesa/Tigo/Airtel payment confirmation (API integration), or just record the txn reference manually?
3. **Job numbering:** keep Samsung SO numbers as the primary reference, or generate your own job numbers alongside them? (Spec assumes both.)
4. **Products vs parts:** are counter-sale products (accessories, new phones) a separate catalogue from repair spare-parts, or one shared catalogue? (Spec assumes separate but shared movement ledger.)
5. **Engineer identity:** should legacy initials (AH, AM, FM…) become real user accounts, or stay as a free label? (Spec assumes real accounts.)
6. **Number of branches / users** expected at launch and in 2 years — sizing.
7. **Existing hardware:** thermal receipt printers, barcode scanners already on site?
8. **Accounting depth:** do you need full statutory financial statements (P&L, balance sheet, TRA VAT returns) from this system, or is it enough to *feed* an existing accounting package (QuickBooks/Sage/Tally) via export? This decides how deep E1 goes.
9. **Multi-company:** is hosting other brands/companies (LG, Hisense, Tecno, or separate legal entities) a real near-term plan, or just future-proofing? Affects how hard we push company-scoping in v1.
10. **Serial tracking scope:** which parts genuinely need unit-level serial/batch tracking (E11) — likely high-value LCDs/PBAs only? Tracking everything adds front-desk friction.
11. **Stock valuation method:** latest-cost, weighted-average, or FIFO for part costs and COGS? (The movement ledger supports any; pick one for consistent reports.)
12. **Notification channels at launch:** SMS only first, or SMS + WhatsApp from day one? (Engine supports both; question is priority.)
13. **AI features:** in-scope for the first commercial release, or a later premium tier?
