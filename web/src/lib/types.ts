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
