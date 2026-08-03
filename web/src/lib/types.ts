/**
 * Wire types for the Phase 0 API surface (Task 0.7). These mirror the
 * snake_case JSON the NestJS API returns; domain enums come from
 * @triserve/shared so both sides share one vocabulary.
 */
import type { Permission } from '@triserve/shared'

export type UserScope = 'branch' | 'group'

export interface PublicUser {
  id: string
  email: string
  full_name: string
  role: string
  scope: UserScope
  company_id: string
  home_branch_id: string | null
  totp_enabled: boolean
  /** Effective permissions (E17) — role defaults + this company's overrides. */
  permissions: Permission[]
}

export interface AuthTokensResponse {
  access_token: string
  refresh_token: string
  user: PublicUser
}

export interface MfaRequiredResponse {
  mfa_required: true
  mfa_token: string
}

export type LoginResponse = AuthTokensResponse | MfaRequiredResponse

export interface SessionEntry {
  id: string
  user_agent: string | null
  ip: string | null
  created_at: string
  last_used_at: string
  revoked_at: string | null
  current: boolean
}

export interface CompanyWire {
  id: string
  name: string
  legal_name: string | null
  tin: string | null
  vrn: string | null
  base_currency: string
  logo_url: string | null
  address: string | null
  phone: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface BranchWire {
  id: string
  code: string
  name: string
  is_hq: boolean
  address: string | null
  phone: string | null
  tz_region: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface UserWire {
  id: string
  full_name: string
  initials: string | null
  email: string
  phone: string | null
  role: string
  scope: UserScope
  home_branch_id: string | null
  totp_enabled: boolean
  active: boolean
  created_at: string
  updated_at: string
}

export interface CodeLabelWire {
  id: string
  code: string
  label: string
  active: boolean
  created_at: string
  updated_at: string
}

export interface RepairActionWire extends CodeLabelWire {
  /** BIGINT minor units (senti) as a string — never floats. */
  default_labour_price: string | null
  default_currency: string | null
}

export interface TaxRateWire extends CodeLabelWire {
  /** Decimal percent as a string, e.g. "18" or "18.5". */
  percent: string
}

export interface CurrencyWire {
  id: string
  code: string
  name: string
  symbol: string
  is_base: boolean
  created_at: string
  updated_at: string
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export type ApprovalType =
  | 'PRICE_OVERRIDE'
  | 'REFUND'
  | 'INVENTORY_ADJUSTMENT'
  | 'STOCK_TRANSFER'
  | 'PURCHASE_ORDER'
  | 'WARRANTY_CANCELLATION'
  | 'INVOICE_VOID'
  | 'REOPEN_JOB'
  | 'LARGE_CASH_REFUND'
  | 'MANUAL_JOURNAL'

export interface ApprovalEntry {
  id: string
  company_id: string
  branch_id: string
  type: ApprovalType
  ref_type: string | null
  ref_id: string | null
  payload_json: unknown
  requested_by: string
  approved_by: string | null
  status: ApprovalStatus
  reason: string
  requested_at: string
  decided_at: string | null
}

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'TRANSITION'
  | 'LOGIN'
  | 'APPROVE'
  | 'REJECT'

export interface AuditLogEntry {
  id: string
  company_id: string
  branch_id: string | null
  actor_user_id: string | null
  entity_type: string
  entity_id: string
  action: AuditAction
  before_json: unknown
  after_json: unknown
  at: string
  ip: string | null
  user_agent: string | null
}

/**
 * Task 1.5 wire types (DESIGN.md §4.2/§4.3/§4.10/§4.12) — customers, devices,
 * models, jobs, the configurable workflow graph, and attachments. Mirror the
 * NestJS controllers/services in api/src/modules/{customers,devices,models,
 * jobs,workflow,attachments}.
 */

export type DeviceCategory = 'HHP' | 'CE' | 'AC' | 'REF' | 'OTHER'
export type WarrantyStatus = 'IW' | 'OW' | 'GOODWILL' | 'UNKNOWN'

/** How the device reached us — Samsung's "Service Type" (§4.7). */
export type ServiceType =
  | 'CARRY_IN'
  | 'PICKUP'
  | 'IN_HOME'
  | 'INITIAL_INSTALL'
  | 'INSPECTION'
  | 'INSURANCE'
  | 'PRODUCT_RETURN'
  | 'RETURN_HANDLING'
  | 'STOCK_REPAIR'
  | 'ADH'

/**
 * What the warranty PAYS FOR — the four boxes on Samsung's job card, and the
 * field that decides who is billed. Distinct from `WarrantyStatus`, which is
 * only the IW/OW fact.
 */
export type JobCoverage = 'FULL' | 'LABOUR_ONLY' | 'PARTS_ONLY' | 'NONE'

/** How urgently a job needs doing — the triage signal the board sorts by. */
export type JobPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'

export const JOB_PRIORITIES: { value: JobPriority; label: string }[] = [
  { value: 'LOW', label: 'Low' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'HIGH', label: 'High' },
  { value: 'URGENT', label: 'Urgent' },
]

/**
 * A service line the centre offers — what the customer is ASKING FOR.
 * A config table, so a centre adds its own lines without a release.
 */
export interface ServiceCategoryWire {
  id: string
  code: string
  label: string
  default_sla_hours: number | null
  sort_order: number
  active: boolean
  created_at: string
  updated_at: string
}

/**
 * GET /reports/snapshot — the centre RIGHT NOW. No date range: every figure
 * is as-of-now, and nothing is stored (overdue is a function of the clock).
 */
export interface FloorSnapshotWire {
  at: string
  attention: {
    open: number
    overdue: number
    due_today: number
    urgent: number
    unassigned: number
    stale: number
  }
  aging: { bucket: string; count: number }[]
  by_state: {
    code: string
    label: string
    sort_order: number
    count: number
    overdue: number
  }[]
  by_line: {
    service_category_id: string | null
    label: string
    count: number
    overdue: number
  }[]
  priority_mix: { priority: string; count: number }[]
  engineers: {
    engineer_id: string | null
    name: string
    initials: string | null
    active: number
    overdue: number
    oldest_days: number | null
  }[]
}

/** The evidence behind a warranty ruling (§4.7). */
export type WarrantySource = 'REGISTRATION' | 'PURCHASE_DATE' | 'MANUAL' | 'GOODWILL'

/** The six GSPN diagnostic code axes. */
export type ServiceCodeKind =
  | 'CONDITION'
  | 'SYMPTOM'
  | 'DEFECT'
  | 'DEFECT_TYPE'
  | 'DEFECT_BLOCK'
  | 'REPAIR'

export const SERVICE_TYPES: { value: ServiceType; label: string }[] = [
  { value: 'CARRY_IN', label: 'Carry In' },
  { value: 'PICKUP', label: 'Pickup Service' },
  { value: 'IN_HOME', label: 'In Home' },
  { value: 'INITIAL_INSTALL', label: 'Initial Installation' },
  { value: 'INSPECTION', label: 'Inspection' },
  { value: 'INSURANCE', label: 'Insurance Service' },
  { value: 'PRODUCT_RETURN', label: 'Product Return' },
  { value: 'RETURN_HANDLING', label: 'Return Handling' },
  { value: 'STOCK_REPAIR', label: 'Stock Repair' },
  { value: 'ADH', label: 'Accidental Damage Handling' },
]

/** Labels spell out WHO PAYS — "Labour only" alone reads ambiguously. */
export const JOB_COVERAGES: { value: JobCoverage; label: string }[] = [
  { value: 'FULL', label: 'Full warranty — customer pays nothing' },
  { value: 'LABOUR_ONLY', label: 'Labour only — customer pays for parts' },
  { value: 'PARTS_ONLY', label: 'Parts only — customer pays for labour' },
  { value: 'NONE', label: 'Out of warranty — customer pays' },
]

export const coverageLabel = (c: JobCoverage): string =>
  JOB_COVERAGES.find((o) => o.value === c)?.label ?? c

export const serviceTypeLabel = (t: ServiceType): string =>
  SERVICE_TYPES.find((o) => o.value === t)?.label ?? t

/**
 * The coverage implied by a warranty ruling, mirroring the API's
 * `defaultCoverage()` (api/src/modules/jobs/jobs.service.ts) so the form shows
 * the same answer the server would pick.
 */
export function defaultCoverageFor(status: WarrantyStatus): JobCoverage {
  return status === 'IW' || status === 'GOODWILL' ? 'FULL' : 'NONE'
}
export type PreferredLanguageCode = 'EN' | 'SW'

export type CustomerType = 'INDIVIDUAL' | 'BUSINESS' | 'DEALER'

/** Selectable customer types with display labels (Individual/Business/Dealer). */
export const CUSTOMER_TYPES: { value: CustomerType; label: string }[] = [
  { value: 'INDIVIDUAL', label: 'Individual' },
  { value: 'BUSINESS', label: 'Business' },
  { value: 'DEALER', label: 'Dealer' },
]

export const customerTypeLabel = (t: CustomerType): string =>
  CUSTOMER_TYPES.find((o) => o.value === t)?.label ?? t

export interface CustomerWire {
  id: string
  name: string
  phone: string | null
  alt_phone: string | null
  email: string | null
  location: string | null
  type: CustomerType
  dealer_name: string | null
  is_dealer: boolean
  preferred_branch_id: string | null
  preferred_language: PreferredLanguageCode
  rating: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface DeviceWire {
  id: string
  customer_id: string
  customer_name: string | null
  brand: string
  model: string | null
  model_id: string | null
  category: DeviceCategory
  device_type: string | null
  imei_serial: string | null
  color: string | null
  created_at: string
  updated_at: string
}

export interface ModelWire {
  id: string
  model_code: string
  category: DeviceCategory
  brand: string
  active: boolean
  created_at: string
  updated_at: string
}

export interface FaultCodeWire {
  id: string
  code: string
  label: string
  active: boolean
  created_at: string
  updated_at: string
}

/**
 * POST /jobs/import/gspn-jobcard — a DRAFT parsed from an uploaded Samsung
 * job-card PDF. Nothing is created server-side; every field is a suggestion
 * the advisor confirms. `coverage` is always null: the warranty tick box is a
 * drawn mark, not text, so it cannot be read from the PDF.
 */
export interface ParsedJobCard {
  so_number: string | null
  customer_name: string | null
  phone: string | null
  address: string | null
  model: string | null
  serial: string | null
  imei_masked: string | null
  purchase_date: string | null
  service_type: ServiceType | null
  accessories_held: string | null
  fault_reported: string | null
  repair_description: string | null
  appointment_at: string | null
  coverage: null
  warnings: string[]
}

/** A `code - label` pair off a GSPN document; `code` is null when unprefixed. */
export interface GspnCode {
  code: string | null
  label: string
}

export interface ParsedClaimLine {
  line_no: number
  part_no: string
  description: string | null
  location: string | null
  qty: number
  unit_price_usd: string | null
  amount_usd: string | null
  invoice_no: string | null
  part_serial_no: string | null
}

/**
 * POST /warranty-claims/import/gspn-pdf — a DRAFT parsed from a GSPN Warranty
 * Claim Detail PDF. Nothing is created; the claim still has to be matched to
 * one of our jobs, which is a human call. Money is USD minor units.
 */
export interface ParsedClaim {
  claim_no: string | null
  samsung_ref_no: string | null
  ticket_no: string | null
  gspn_status: string | null
  service_type: ServiceType | null
  customer_name: string | null
  phone: string | null
  model: string | null
  serial: string | null
  imei_masked: string | null
  purchase_date: string | null
  repair_received_at: string | null
  completed_at: string | null
  delivered_at: string | null
  warranty_status: WarrantyStatus | null
  condition_code: GspnCode | null
  symptom_code: GspnCode | null
  defect_code: GspnCode | null
  defect_type: GspnCode | null
  repair_code: GspnCode | null
  defect_description: string | null
  repair_description: string | null
  claim_amount_usd: string | null
  labour_amount_usd: string | null
  parts_amount_usd: string | null
  shipping_amount_usd: string | null
  tax_amount_usd: string | null
  lines: ParsedClaimLine[]
  warnings: string[]
}

/** One Samsung GSPN diagnostic code — `kind` disambiguates the shared table. */
export interface ServiceCodeWire extends FaultCodeWire {
  kind: ServiceCodeKind
  category: DeviceCategory | null
  sort_order: number
}

/** GET /jobs list item — no nested relations (ids only); see JobDetailWire. */
export interface JobWire {
  id: string
  job_no: string
  so_number: string | null
  branch_id: string
  branch_code: string
  branch_name: string
  customer_id: string
  device_id: string
  booked_by: string
  assigned_engineer_id: string | null
  assigned_engineer_name: string | null
  warranty_status: WarrantyStatus
  service_type: ServiceType
  service_category_id: string | null
  priority: JobPriority
  /** Internal turnaround target — NOT the date promised to the customer. */
  sla_due_at: string | null
  is_overdue: boolean
  coverage: JobCoverage
  warranty_source: WarrantySource | null
  warranty_registration_id: string | null
  warranty_decided_by: string | null
  warranty_decided_at: string | null
  fault_reported: string | null
  fault_code_id: string | null
  tech_report: string | null
  condition_code_id: string | null
  symptom_code_id: string | null
  defect_code_id: string | null
  defect_type_id: string | null
  defect_block_id: string | null
  repair_code_id: string | null
  repair_description: string | null
  accessories_held: string | null
  appointment_at: string | null
  return_by_date: string | null
  repair_warranty_until: string | null
  state_id: string
  state_code: string
  state_label: string
  received_at: string
  ready_at: string | null
  dispatched_at: string | null
  dispatched_by: string | null
  received_by_customer: string | null
  waybill_no: string | null
  claim_id: string | null
  invoice_id: string | null
  notes: string | null
  created_at: string
  updated_at: string

  // -- SCMS proposal fields --------------------------------------------------
  /** Module 1: the symptom-tree LEAF picked at the counter. */
  symptom_node_id?: string | null
  condition_captured_at?: string | null
  liquid_indicator_tripped?: boolean | null
  estimate_amount?: string | null
  estimate_currency?: string | null
  terms_accepted_at?: string | null
  /** Module 2: bench clocks and QC bookkeeping. */
  diagnosis_started_at?: string | null
  repair_started_at?: string | null
  qc_submitted_at?: string | null
  labour_hours?: string | null
  qc_failure_reason?: string | null
  qc_reject_count?: number
  qc_approved_by?: string | null
  qc_approved_at?: string | null
  /** Modules 4/5: the bench is locked pending a supervisor/customer decision. */
  tech_locked?: boolean
  tech_lock_reason?: string | null
}

export interface AllowedTransition {
  to_state_code: string
  to_label: string
  requires_approval: boolean
  /** Set when a business guard is holding this move — render it disabled with
   *  this as the reason, rather than dropping the button. */
  blocked_reason?: string
  /** Machine-readable counterpart of `blocked_reason` (the guard_code). */
  blocked_guard?: string
}

export interface JobCustomerSummary {
  id: string
  name: string
  phone: string | null
  phone_normalized: string | null
  email: string | null
  location: string | null
}

export interface JobDeviceSummary {
  id: string
  brand: string
  model: string | null
  model_id: string | null
  model_code: string | null
  category: string
  imei_serial: string | null
  color: string | null
  purchase_date: string | null
}

/** GET /jobs/{id} — full detail incl. relations + legal next moves. */
export interface JobDetailWire extends JobWire {
  customer: JobCustomerSummary
  device: JobDeviceSummary
  allowed_next_transitions: AllowedTransition[]
}

/** Result of POST /jobs/{id}/transition (or /dispatch). */
export interface TransitionResult {
  held: boolean
  job: JobDetailWire
  pending_approval?: ApprovalEntry
}

export interface WorkflowStateWire {
  id: string
  code: string
  label: string
  is_initial: boolean
  is_terminal: boolean
  sort_order: number
  active: boolean
  created_at: string
  updated_at: string
}

export interface WorkflowTransitionWire {
  id: string
  from_code: string
  to_code: string
  required_permission: string | null
  requires_approval: boolean
  guard_code: string | null
  created_at: string
  updated_at: string
}

/** GET /workflow/graph — Kanban columns (states) + legal moves (transitions). */
export interface WorkflowGraphWire {
  states: WorkflowStateWire[]
  transitions: WorkflowTransitionWire[]
}

export type AttachmentOwnerType =
  | 'JOB'
  | 'CUSTOMER'
  | 'DEVICE'
  | 'GRN'
  | 'INVOICE'

export type AttachmentKind =
  | 'SIGNATURE'
  | 'PHOTO_BEFORE'
  | 'PHOTO_AFTER'
  | 'VIDEO'
  | 'WARRANTY_CARD'
  | 'PURCHASE_RECEIPT'
  | 'DOC'

/** `url` is a FRESH presigned/signed GET URL minted on every read. */
export interface AttachmentWire {
  id: string
  company_id: string
  branch_id: string | null
  owner_type: AttachmentOwnerType
  owner_id: string
  kind: AttachmentKind
  file_name: string
  mime_type: string
  size_bytes: number
  uploaded_by: string
  url: string
  created_at: string
}

// --- Parts / inventory (Task 2.1, §4.4 / E10) --------------------------------

export type StockMovementType =
  | 'RECEIPT'
  | 'CONSUMPTION'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'ADJUSTMENT'
  | 'SALE'
  | 'RETURN'
  | 'SUPPLIER_RETURN'
  | 'RESERVE'
  | 'UNRESERVE'
  | 'DAMAGE'

export type StockRefType =
  | 'JOB'
  | 'GRN'
  | 'TRANSFER'
  | 'POS_SALE'
  | 'COUNT'
  | 'ADJUSTMENT'

export interface SupplierWire {
  id: string
  name: string
  contact_person: string | null
  phone: string | null
  email: string | null
  address: string | null
  default_currency: string
  lead_time_days: number | null
  payment_terms: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface PartWire {
  id: string
  part_number: string
  description: string
  category: DeviceCategory
  /** USD cents (minor units) — landed cost. */
  unit_cost_usd: string | null
  /** TZS senti (minor units) — OW counter price. */
  default_sell_price_tzs: string | null
  compatible_models: string[]
  is_serialized: boolean
  preferred_supplier_id: string | null
  preferred_supplier: { id: string; name: string } | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface InventoryWire {
  id: string
  branch_id: string
  part_id: string
  part: { part_number: string; description: string; category: DeviceCategory }
  bin_location: string | null
  qty_on_hand: number
  qty_reserved: number
  qty_in_transit_in: number
  qty_damaged: number
  /** Derived: on_hand − reserved − damaged (§4.4 / E10). */
  qty_available: number
  reorder_level: number
  low_stock: boolean
  updated_at: string
}

export interface StockMovementWire {
  id: string
  branch_id: string
  part_id: string
  part: { part_number: string; description: string } | null
  movement_type: StockMovementType
  qty: number
  ref_type: StockRefType | null
  ref_id: string | null
  unit_cost: string | null
  cost_currency: string | null
  reason: string | null
  moved_by: string
  moved_at: string
}

/** Result of an adjust/count — applied, or HELD pending approval (§4.11). */
export interface StockChangeResult {
  held: boolean
  movement: StockMovementWire | null
  inventory: InventoryWire
  pending_approval?: ApprovalEntry
}

export type StockTransferStatus =
  | 'DRAFT'
  | 'DISPATCHED'
  | 'RECEIVED'
  | 'CANCELLED'

export interface TransferLineWire {
  id: string
  part_id: string
  part: { part_number: string; description: string }
  qty: number
}

export interface TransferWire {
  id: string
  transfer_no: string
  from_branch_id: string
  from_branch_code: string
  to_branch_id: string
  to_branch_code: string
  status: StockTransferStatus
  notes: string | null
  dispatched_at: string | null
  dispatched_by: string | null
  received_at: string | null
  received_by: string | null
  created_at: string
  lines: TransferLineWire[]
}

/** Result of a dispatch — applied, or HELD pending approval (§4.11). */
export interface TransferDispatchResult {
  held: boolean
  transfer: TransferWire
  pending_approval?: ApprovalEntry
}

export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'ORDERED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CANCELLED'

export interface PoLineWire {
  id: string
  part_id: string
  part: { part_number: string; description: string }
  qty_ordered: number
  qty_received: number
  unit_cost: string
  currency: string
  line_status: string
}

export interface PurchaseOrderWire {
  id: string
  po_no: string
  supplier_id: string
  supplier_name: string
  branch_id: string
  branch_code: string
  status: PurchaseOrderStatus
  currency: string
  order_date: string | null
  expected_date: string | null
  subtotal: string
  tax: string
  shipping: string
  total: string
  requires_approval: boolean
  approved_by: string | null
  ordered_at: string | null
  notes: string | null
  created_at: string
  lines: PoLineWire[]
}

// --- Reorder suggestions (Task 2.9, §4.4b) -----------------------------------

export interface ReorderItem {
  part_id: string
  part_number: string
  description: string
  available: number
  reorder_level: number
  suggested_qty: number
  unit_cost_usd: string | null
}

export interface ReorderGroup {
  supplier_id: string | null
  supplier_name: string | null
  currency: string | null
  items: ReorderItem[]
}

export interface ReorderSuggestions {
  branch_id: string
  branch_code: string
  groups: ReorderGroup[]
}

// --- Serial units (Task 2.4, §4.4 / E11) -------------------------------------

export type PartUnitStatus =
  | 'IN_STOCK'
  | 'RESERVED'
  | 'INSTALLED'
  | 'RETURNED'
  | 'DAMAGED'

export interface PartUnitWire {
  id: string
  part_id: string
  part: { part_number: string; description: string }
  serial_no: string
  branch_id: string
  branch_code: string
  status: PartUnitStatus
  supplier_id: string | null
  grn_id: string | null
  installed_on_job_id: string | null
  removed_from_job_id: string | null
  warranty_expiry: string | null
  created_at: string
}

// --- POS invoices (Task 3.1, §4.6) -------------------------------------------

export type InvoiceType =
  | 'REPAIR_OW'
  | 'PRODUCT_SALE'
  | 'PARTS_SALE'
  | 'ACCESSORY'
export type InvoiceStatus =
  | 'DRAFT'
  | 'PARTIAL'
  | 'PAID'
  | 'VOID'
  | 'REFUNDED'
export type InvoiceLineType = 'PART' | 'PRODUCT' | 'SERVICE' | 'CUSTOM'
export type PaymentMethodType =
  | 'CASH'
  | 'MPESA'
  | 'TIGOPESA'
  | 'AIRTEL'
  | 'CARD'
  | 'BANK'

export interface PaymentWire {
  id: string
  invoice_id: string
  method: PaymentMethodType
  amount: string
  currency: string
  reference: string | null
  paid_at: string
  received_by: string
  notes: string | null
  created_at: string
}

export interface InvoiceLineWire {
  id: string
  line_type: InvoiceLineType
  part_id: string | null
  description: string
  qty: number
  unit_price: string
  line_total: string
  is_warranty: boolean
}

export interface InvoiceWire {
  id: string
  invoice_no: string
  branch_id: string
  branch_code: string
  customer_id: string | null
  customer_name: string | null
  customer_is_dealer: boolean | null
  job_id: string | null
  job_no: string | null
  type: InvoiceType
  currency: string
  subtotal: string
  discount: string
  tax: string
  total: string
  amount_paid: string
  balance: string
  status: InvoiceStatus
  sold_by: string
  notes: string | null
  created_at: string
  lines: InvoiceLineWire[]
  payments: PaymentWire[]
}

export type JobPartStatus = 'RESERVED' | 'CONSUMED'

/** A part committed to a job (§4.5, Task 2.2). */
export interface JobPartWire {
  id: string
  job_id: string
  part_id: string
  part: { part_number: string; description: string; category: DeviceCategory }
  qty: number
  unit_sell_price: string | null
  currency: string | null
  is_warranty: boolean
  status: JobPartStatus
  reserved_at: string
  consumed_at: string | null
}

// --- Products (retail catalogue) ---------------------------------------------

export interface ProductWire {
  id: string
  sku: string
  name: string
  brand: string
  device_type: string | null
  category: DeviceCategory
  sell_price_tzs: string | null
  cost_usd: string | null
  stock_qty: number
  default_warranty_months: number | null
  default_warranty_kind: WarrantyKind | null
  is_serialized: boolean
  active: boolean
  created_at: string
  updated_at: string
}

// --- Operations / BI report (Phase 5 / E15 + E5) -----------------------------

export interface OperationsReportWire {
  from: string | null
  to: string | null
  totals: {
    total_jobs: number
    active_jobs: number
    avg_turnaround_hours: number | null
  }
  intake_by_month: { month: string; count: number }[]
  by_state: { code: string; label: string; is_terminal: boolean; count: number }[]
  by_branch: { code: string; name: string; count: number }[]
  top_models: { model: string; count: number }[]
  technicians: {
    engineer_id: string
    name: string
    initials: string | null
    assigned: number
    completed: number
    active: number
    avg_turnaround_hours: number | null
  }[]
}

// --- Warranty registrations (retail) -----------------------------------------

export type WarrantyKind = 'STORE' | 'MANUFACTURER' | 'SAMSUNG'
export type WarrantyRegistrationStatus = 'ACTIVE' | 'EXPIRED' | 'VOID'

export interface WarrantyRegistrationWire {
  id: string
  branch_id: string
  branch_code: string
  customer_id: string | null
  customer_name: string | null
  device_id: string | null
  invoice_id: string | null
  invoice_no: string | null
  product_name: string
  brand: string
  serial_no: string | null
  kind: WarrantyKind
  start_date: string
  expiry_date: string
  months: number | null
  terms: string | null
  status: WarrantyRegistrationStatus
  is_expired: boolean
  notes: string | null
  created_at: string
}

// --- Financial reports (Phase 5 / E1) ----------------------------------------

export interface TrialBalanceRow {
  code: string
  name: string
  type: string
  debit: string
  credit: string
  balance: string
}
export interface TrialBalanceCurrency {
  currency: string
  rows: TrialBalanceRow[]
  total_debit: string
  total_credit: string
  balanced: boolean
}
export interface TrialBalanceWire {
  from: string | null
  to: string | null
  currencies: TrialBalanceCurrency[]
}

export interface PlLine {
  code: string
  name: string
  amount: string
}
export interface ProfitLossCurrency {
  currency: string
  revenue: PlLine[]
  total_revenue: string
  expenses: PlLine[]
  total_expenses: string
  net_profit: string
}
export interface ProfitLossWire {
  from: string | null
  to: string | null
  currencies: ProfitLossCurrency[]
}

// --- Customer 360 (Phase 5, §4.2 / E2) ---------------------------------------

export interface ProfileMoney {
  currency: string
  amount: string
}
export interface CustomerProfileWire {
  customer: CustomerWire
  stats: {
    total_jobs: number
    active_jobs: number
    total_devices: number
    total_invoices: number
    lifetime_spend: ProfileMoney[]
    outstanding: ProfileMoney[]
    warranty_claims: number
    warranty_reimbursed_usd: string
    first_seen: string | null
    last_visit: string | null
  }
  devices: Array<{
    id: string
    brand: string
    model: string | null
    category: DeviceCategory
    imei_serial: string | null
    color: string | null
  }>
  jobs: Array<{
    id: string
    job_no: string
    state_code: string
    state_label: string
    is_terminal: boolean
    warranty_status: WarrantyStatus
    device_model: string | null
    received_at: string
  }>
  invoices: Array<{
    id: string
    invoice_no: string
    type: InvoiceType
    currency: string
    total: string
    balance: string
    status: InvoiceStatus
    created_at: string
  }>
  warranty: Array<{
    id: string
    claim_no: string | null
    status: WarrantyClaimStatus
    claim_amount_usd: string
    reimbursed_amount_usd: string | null
    created_at: string
  }>
}

// --- Warranty claims (Phase 4, §4.7) -----------------------------------------

export type LabourCode = 'FEM' | 'LEM' | 'SEM'
export type WarrantyClaimStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAID'
  | 'CANCELLED'

export interface WarrantyClaimWire {
  id: string
  branch_id: string
  branch_code: string
  job_id: string
  job_no: string
  claim_no: string | null
  samsung_ref_no: string | null
  ticket_no: string | null
  gspn_status: string | null
  labour_code: LabourCode | null
  currency: 'USD'
  claim_amount_usd: string
  /** The split GSPN settles on; all zero on claims raised before it existed. */
  labour_amount_usd: string
  parts_amount_usd: string
  shipping_amount_usd: string
  tax_amount_usd: string
  reimbursed_amount_usd: string | null
  status: WarrantyClaimStatus
  submitted_at: string | null
  paid_at: string | null
  repair_received_at: string | null
  completed_at: string | null
  delivered_at: string | null
  notes: string | null
  lines: WarrantyClaimLineWire[]
  created_at: string
  updated_at: string
}

/** One part claimed against Samsung, at THEIR reimbursement price. */
export interface WarrantyClaimLineWire {
  id: string
  line_no: number
  part_id: string | null
  part_no: string
  description: string | null
  location: string | null
  qty: number
  unit_price_usd: string
  amount_usd: string
  part_serial_no: string | null
  invoice_no: string | null
}

/**
 * GET /warranty-claims/match?serial= — a job a claim might belong to.
 * A suggestion, not a binding: several jobs can share a serial.
 */
export interface ClaimJobMatch {
  job_id: string
  job_no: string
  branch_code: string
  customer_name: string
  model: string | null
  imei_serial: string | null
  state_code: string
  state_label: string
  received_at: string
  coverage: JobCoverage
  existing_claim_ids: string[]
}

// --- Dashboard summary (§8) — server-side analytics roll-up ------------------

export interface MoneyByCurrency {
  currency: string
  amount: string // minor units
  count: number
}
export interface MonthlyPoint {
  month: string // 'YYYY-MM'
  currency: string
  amount: string
}
export interface NamedTotal {
  key: string
  label: string
  currency: string
  amount: string
  count: number
}
export interface DashboardStageCount {
  code: string
  label: string
  count: number
  is_terminal: boolean
}
export interface DashboardSummaryWire {
  generated_at: string
  scope: { branch_id: string | null }
  revenue_all_time: MoneyByCurrency[]
  revenue_this_month: MoneyByCurrency[]
  monthly: MonthlyPoint[]
  by_method: NamedTotal[]
  by_branch: NamedTotal[]
  jobs_by_state: DashboardStageCount[]
  jobs_active: number
  jobs_total: number
  counts: {
    customers: number
    devices: number
    parts: number
    stock_on_hand: number
    low_stock: number
    open_invoices: number
  }
}

// ===========================================================================
// SCMS proposal modules (Service_Center_System_Proposal.docx)
//
// Wire contracts mirroring the API's `*Wire` interfaces. Money is always a
// STRING of minor units — BIGINT values exceed the precision a JSON number
// guarantees, so they never become numbers on this side either.
// ===========================================================================

// -- Module 1 (§2): intake integrity -----------------------------------------

export type DamageType =
  | 'SCRATCH'
  | 'HAIRLINE_CRACK'
  | 'CRACK'
  | 'SHATTERED'
  | 'DENT'
  | 'SCUFF'
  | 'CHIP'
  | 'DISCOLOURATION'
  | 'CORROSION'
  | 'BURN'
  | 'MISSING_PART'
  | 'LOOSE_PART'
  | 'WATER_INGRESS'
  | 'LIQUID_INDICATOR_TRIPPED'
  | 'PREVIOUS_REPAIR'
  | 'OTHER'

export type DamageSeverity = 'MINOR' | 'MODERATE' | 'SEVERE'

export interface SymptomNode {
  id: string
  code: string
  label: string
  parent_id: string | null
  level: number
  is_leaf: boolean
  category: DeviceCategory | null
  fault_code_id: string | null
  service_category_id: string | null
  estimate_amount: string | null
  estimate_currency: string | null
  estimate_minutes: number | null
  sort_order: number
  active: boolean
  /** Ancestor labels, root-first — populated on search results. */
  path: string[]
}

export interface ConditionZone {
  id: string
  category: DeviceCategory
  code: string
  label: string
  /** Normalised 0–1 hotspot position on the device outline. */
  x: number
  y: number
  face: string
  sort_order: number
  active: boolean
}

export interface ConditionMark {
  id: string
  zone_id: string
  zone_code: string
  zone_label: string
  face: string
  x: number
  y: number
  damage: DamageType
  severity: DamageSeverity
  note: string | null
}

export interface JobCondition {
  job_id: string
  category: DeviceCategory
  captured_at: string | null
  captured_by: string | null
  liquid_indicator_tripped: boolean | null
  marks: ConditionMark[]
  zones: ConditionZone[]
}

export interface IntakeReadiness {
  job_id: string
  ready: boolean
  condition_captured: boolean
  symptom_selected: boolean
  terms_accepted: boolean
  has_before_photo: boolean
  has_signature: boolean
  outstanding: string[]
}

// -- Module 2 (§3): bench, QC and the clocks ---------------------------------

export type WorkflowStage =
  | 'INTAKE'
  | 'DIAGNOSIS'
  | 'HOLD'
  | 'REPAIR'
  | 'QC'
  | 'READY'
  | 'DONE'

export type HoldKind = 'NONE' | 'PARTS' | 'CUSTOMER' | 'EXTERNAL'

export type QcCheckResult = 'PASS' | 'FAIL' | 'NA'

/** The proposal's queue colours: >50% green, 20–50% amber, <20%/breached red. */
export type SlaBand = 'GREEN' | 'AMBER' | 'RED' | 'NONE'

export interface UserSkill {
  id: string
  user_id: string
  user_name: string
  user_role: string
  category: DeviceCategory
  service_category_id: string | null
  level: number
  can_qc: boolean
  certified_at: string | null
  notes: string | null
  active: boolean
}

export interface RoutingCandidate {
  user_id: string
  user_name: string
  level: number
  can_qc: boolean
  open_jobs: number
}

export interface QcChecklistItem {
  id: string
  category: DeviceCategory
  code: string
  label: string
  help: string | null
  requires_value: boolean
  requires_attachment: boolean
  blocking: boolean
  sort_order: number
  active: boolean
}

export interface JobQcLine {
  item_id: string
  code: string
  label: string
  help: string | null
  requires_value: boolean
  requires_attachment: boolean
  blocking: boolean
  result: QcCheckResult | null
  value: string | null
  note: string | null
  recorded_at: string | null
}

export interface JobQcPanel {
  job_id: string
  category: DeviceCategory
  attempt_no: number
  qc_reject_count: number
  qc_submitted_at: string | null
  qc_failure_reason: string | null
  qc_approved_by: string | null
  qc_approved_at: string | null
  labour_hours: string | null
  tech_report: string | null
  can_approve: boolean
  approve_blocked_reason: string | null
  lines: JobQcLine[]
}

export interface JobClockMetrics {
  job_id: string
  received_at: string
  /** Clock-to-Diagnosis, ms. Null until diagnosis starts. */
  ctd_ms: number | null
  /** Hold-for-Parts, ms, summed across every parts hold. */
  hfp_ms: number
  customer_hold_ms: number
  /** Total turnaround, ms. */
  tat_ms: number
  tat_final: boolean
  /** Elapsed time that counts against the SLA (pauses excluded). */
  sla_elapsed_ms: number
  internal_elapsed_ms: number
  sla_due_at: string | null
  sla_remaining_percent: number | null
  sla_band: SlaBand
  qc_reject_count: number
  stage_totals_ms: Record<string, number>
}

export interface SlaQueue {
  counts: Record<SlaBand, number>
  jobs: Array<{
    job_id: string
    job_no: string
    state_code: string
    stage: WorkflowStage
    engineer_id: string | null
    engineer_name: string | null
    sla_band: SlaBand
    sla_remaining_percent: number | null
    sla_due_at: string | null
    hfp_ms: number
    tat_ms: number
  }>
}

export interface SlaAggregate {
  key: string
  label: string
  jobs: number
  avg_ctd_ms: number | null
  median_ctd_ms: number | null
  avg_hfp_ms: number
  avg_tat_ms: number | null
  median_tat_ms: number | null
  on_time: number
  breached: number
  on_time_percent: number | null
  rework_jobs: number
  first_time_fix_percent: number | null
}

// -- Module 3 (§4): the closed-loop core exchange ----------------------------

export interface PickingTicket {
  job_id: string
  job_no: string
  branch_id: string
  printed_at: string
  lines: Array<{
    line_id: string
    part_id: string
    part_number: string
    description: string
    qty: number
    bin_location: string | null
    bin_moved: boolean
    core_required: boolean
    is_serialized: boolean
  }>
}

export interface CoreStatus {
  job_id: string
  clear: boolean
  outstanding_count: number
  lines: Array<{
    line_id: string
    part_number: string
    description: string
    qty: number
    status: string
    new_serial_no: string | null
    core_serial_no: string | null
    core_returned_at: string | null
    outstanding: boolean
  }>
}

// -- Module 4 (§5): BER & replacement ----------------------------------------

export type BerStatus = 'FLAGGED' | 'CERTIFIED' | 'REJECTED' | 'WITHDRAWN'

export type BerOutcome =
  | 'REPLACE_IW'
  | 'REPLACE_TRADE_UP'
  | 'SALVAGE'
  | 'DECLINED'
  | 'REPAIR_ANYWAY'

export interface BerAssessment {
  id: string
  job_id: string
  job_no: string
  branch_id: string
  certificate_no: string | null
  parts_cost: string
  labour_cost: string
  total_cost: string
  device_value: string
  currency: string
  ratio_percent: string
  threshold_percent: number
  valuation_source: string
  status: BerStatus
  breached: boolean
  flagged_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  decision_notes: string | null
  outcome: BerOutcome | null
  offer_amount: string | null
  customer_responded_at: string | null
}

export interface BerPreview {
  job_id: string
  parts_cost: string
  labour_cost: string
  total_cost: string
  device_value: string
  currency: string
  ratio_percent: string
  threshold_percent: number
  breached: boolean
  valuation_source: string
  /** Where each figure came from, in words. */
  basis: string[]
}

export interface BerEvaluateResult {
  preview: BerPreview
  assessment: BerAssessment | null
}

export type SwapUnitStatus = 'IN_STOCK' | 'ALLOCATED' | 'ISSUED' | 'RETIRED'

export interface SwapUnit {
  id: string
  branch_id: string
  model_id: string | null
  model_label: string | null
  category: DeviceCategory
  imei_serial: string
  color: string | null
  cost: string | null
  currency: string | null
  status: SwapUnitStatus
  allocated_job_id: string | null
  issued_at: string | null
  notes: string | null
}

export interface DeviceSwap {
  id: string
  job_id: string
  branch_id: string
  old_device_id: string
  new_device_id: string
  swap_unit_id: string
  old_imei_serial: string | null
  new_imei_serial: string | null
  history_job_count: number
  reason: string | null
  authorized_by: string
  authorized_at: string
}

// -- Module 5 (§6): role ceilings + the OW authorization gate ----------------

export type RoleLimitType =
  | 'DISCOUNT'
  | 'PRICE_ADJUSTMENT'
  | 'PARTS_VARIANCE'
  | 'WRITE_OFF'
  | 'REFUND'

export interface RoleLimit {
  id: string
  role: string
  type: RoleLimitType
  max_amount: string | null
  currency: string | null
  max_percent: string | null
  enabled: boolean
  summary: string
}

export interface QuoteApproval {
  invoice_id: string
  invoice_no: string
  job_id: string | null
  total: string
  currency: string
  quote_sent_at: string | null
  quote_sent_to: string | null
  approval_expires_at: string | null
  customer_approved_at: string | null
  customer_declined_at: string | null
  approval_via: string | null
  approved: boolean
}

export interface PublicQuote {
  token: string
  company: string
  branch: string
  invoice_no: string
  job_no: string | null
  device: string
  currency: string
  subtotal: string
  discount: string
  tax: string
  total: string
  lines: Array<{ description: string; qty: number; line_total: string }>
  expires_at: string
  decided: 'APPROVED' | 'DECLINED' | null
}

// -- Module 6 (§7): handover, logistics and CSAT -----------------------------

export interface CollectionOtp {
  id: string
  job_id: string
  /** Last two digits only — the full PIN is never returned by the API. */
  code_hint: string
  sent_to: string | null
  sent_at: string | null
  expires_at: string
  attempts: number
  attempts_remaining: number
  verified_at: string | null
  voided_at: string | null
  void_reason: string | null
  active: boolean
}

export type ConsignmentStatus = 'OPEN' | 'IN_TRANSIT' | 'ARRIVED' | 'CANCELLED'
export type ConsignmentDirection = 'INBOUND_TO_HUB' | 'OUTBOUND_TO_SPOKE'
export type ScanPoint =
  | 'HUB_DEPART'
  | 'COURIER_HUB'
  | 'COURIER_DEPART'
  | 'SPOKE_ARRIVE'
  | 'HUB_ARRIVE'
  | 'CUSTOM'

export interface ConsignmentJobLine {
  job_id: string
  job_no: string
  customer_name: string
  device: string
  imei_serial: string | null
  added_at: string
  checked_in_at: string | null
  /** On the manifest but not checked in at arrival. */
  missing: boolean
}

export interface ConsignmentScan {
  id: string
  scan_point: ScanPoint
  location: string | null
  handler_name: string | null
  scanned_at: string
  scanned_by: string | null
  note: string | null
}

export interface Consignment {
  id: string
  consignment_no: string
  tote_label: string
  from_branch_id: string
  from_branch: string
  to_branch_id: string
  to_branch: string
  direction: ConsignmentDirection
  status: ConsignmentStatus
  courier_name: string | null
  courier_ref: string | null
  waybill_no: string | null
  sealed_at: string | null
  dispatched_at: string | null
  arrived_at: string | null
  job_count: number
  missing_count: number
  notes: string | null
  jobs: ConsignmentJobLine[]
  scans: ConsignmentScan[]
}

export interface CsatSurvey {
  id: string
  job_id: string
  job_no: string
  branch_id: string
  customer_id: string
  customer_name: string
  score: number | null
  comment: string | null
  sent_at: string | null
  responded_at: string | null
  expires_at: string
}

export interface PublicCsat {
  token: string
  company: string
  branch: string
  job_no: string
  device: string
  answered: boolean
  score: number | null
}

// -- Module 7 (§8): notifications --------------------------------------------

export type NotificationChannel = 'SMS' | 'EMAIL' | 'WHATSAPP' | 'IN_APP'
export type NotificationStatus =
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'CANCELLED'

export interface NotificationRow {
  id: string
  event_code: string
  channel: NotificationChannel
  language: 'EN' | 'SW'
  to_address: string
  subject: string | null
  body: string
  status: NotificationStatus
  attempts: number
  available_at: string
  sent_at: string | null
  provider_ref: string | null
  last_error: string | null
  customer_id: string | null
  job_id: string | null
  created_at: string
}

export interface NotificationTemplate {
  id: string
  event_code: string
  channel: NotificationChannel
  language: 'EN' | 'SW'
  subject: string | null
  body: string
  active: boolean
  updated_at: string
}
