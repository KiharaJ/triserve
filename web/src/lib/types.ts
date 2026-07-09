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
