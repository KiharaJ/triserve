/**
 * Wire types for the Phase 0 API surface (Task 0.7). These mirror the
 * snake_case JSON the NestJS API returns; domain enums come from
 * @triserve/shared so both sides share one vocabulary.
 */
import type { RoleName } from '@triserve/shared'

export type UserScope = 'branch' | 'group'

export interface PublicUser {
  id: string
  email: string
  full_name: string
  role: RoleName
  scope: UserScope
  company_id: string
  home_branch_id: string | null
  totp_enabled: boolean
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
  role: RoleName
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
export type PreferredLanguageCode = 'EN' | 'SW'

export interface CustomerWire {
  id: string
  name: string
  phone: string | null
  alt_phone: string | null
  email: string | null
  location: string | null
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
  brand: string
  model: string | null
  model_id: string | null
  category: DeviceCategory
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

/** GET /jobs list item — no nested relations (ids only); see JobDetailWire. */
export interface JobWire {
  id: string
  job_no: string
  so_number: string | null
  branch_id: string
  customer_id: string
  device_id: string
  booked_by: string
  assigned_engineer_id: string | null
  warranty_status: WarrantyStatus
  fault_reported: string | null
  fault_code_id: string | null
  tech_report: string | null
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
}

export interface AllowedTransition {
  to_state_code: string
  to_label: string
  requires_approval: boolean
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
  labour_code: LabourCode | null
  currency: 'USD'
  claim_amount_usd: string
  reimbursed_amount_usd: string | null
  status: WarrantyClaimStatus
  submitted_at: string | null
  paid_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
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
