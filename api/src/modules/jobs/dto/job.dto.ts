import {
  CustomerType,
  DeviceCategory,
  JobCoverage,
  ServiceType,
  WarrantyStatus,
  WarrantySource,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/**
 * GET /jobs?branch_id=&state=&assigned_engineer_id=&warranty_status=&q=&from=&to=&page=
 * `state` is a workflow-state CODE (e.g. RECEIVED); `q` matches job_no,
 * so_number, customer name/phone or device IMEI; `from`/`to` bound
 * received_at.
 */
export class JobListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  state?: string;

  @IsOptional()
  @IsUUID()
  assigned_engineer_id?: string;

  /** Task 1.5 (CRM stub, §4.2/E2): a customer's jobs for their 360 view. */
  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsEnum(WarrantyStatus)
  warranty_status?: WarrantyStatus;

  /** Filter by who pays — e.g. every job the customer is billed for. */
  @IsOptional()
  @IsEnum(JobCoverage)
  coverage?: JobCoverage;

  @IsOptional()
  @IsEnum(ServiceType)
  service_type?: ServiceType;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * Nested new-customer payload for POST /jobs intake (find-or-create by
 * normalized phone). A lean subset of the full customer shape — the front
 * desk captures more via /customers afterwards if needed.
 */
export class JobCustomerInput {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  alt_phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  /** Individual / Business / Dealer (§4.2); defaults to Individual. */
  @IsOptional()
  @IsEnum(CustomerType)
  type?: CustomerType;
}

/**
 * Nested new-device payload for POST /jobs intake (find-or-create by
 * normalized imei_serial within the company).
 */
export class JobDeviceInput {
  @IsEnum(DeviceCategory)
  category!: DeviceCategory;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  model?: string;

  @IsOptional()
  @IsUUID()
  model_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  imei_serial?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  /** When the customer bought it — the input to the IW/OW ruling (§4.7). */
  @IsOptional()
  @IsISO8601()
  purchase_date?: string;
}

/**
 * POST /jobs — opens a job card at the workflow INITIAL state.
 * Provide EITHER `customer_id` OR a nested `customer`, and EITHER `device_id`
 * OR a nested `device` (validated in the service). `branch_id` is required
 * for group-scoped users; branch users default to their home branch.
 */
export class CreateJobDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => JobCustomerInput)
  customer?: JobCustomerInput;

  @IsOptional()
  @IsUUID()
  device_id?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => JobDeviceInput)
  device?: JobDeviceInput;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  so_number?: string;

  @IsOptional()
  @IsEnum(WarrantyStatus)
  warranty_status?: WarrantyStatus;

  @IsOptional()
  @IsEnum(ServiceType)
  service_type?: ServiceType;

  /**
   * What the warranty pays for. Omit and it derives from `warranty_status`
   * (IW/GOODWILL → FULL, else NONE) — send it explicitly for the partial
   * cases the Samsung job card allows (labour-only / parts-only).
   */
  @IsOptional()
  @IsEnum(JobCoverage)
  coverage?: JobCoverage;

  @IsOptional()
  @IsEnum(WarrantySource)
  warranty_source?: WarrantySource;

  @IsOptional()
  @IsUUID()
  warranty_registration_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  fault_reported?: string;

  @IsOptional()
  @IsUUID()
  fault_code_id?: string;

  /**
   * GSPN diagnostic codes (§4.7). Only the customer-reported symptom is
   * normally known at the counter — the rest are diagnosis outputs set later
   * via PATCH — but all six are accepted so a migrated or back-dated job can
   * be opened complete. Each is validated against its KIND.
   */
  @IsOptional()
  @IsUUID()
  condition_code_id?: string;

  @IsOptional()
  @IsUUID()
  symptom_code_id?: string;

  @IsOptional()
  @IsUUID()
  defect_code_id?: string;

  @IsOptional()
  @IsUUID()
  defect_type_id?: string;

  @IsOptional()
  @IsUUID()
  defect_block_id?: string;

  @IsOptional()
  @IsUUID()
  repair_code_id?: string;

  @IsOptional()
  @IsUUID()
  assigned_engineer_id?: string;

  /** Accessories handed in with the device — job-card T&C 2 custody record. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  accessories_held?: string;

  @IsOptional()
  @IsISO8601()
  appointment_at?: string;

  @IsOptional()
  @IsISO8601()
  return_by_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

/**
 * PATCH /jobs/{id} — mutable business fields only. Status is EXCLUDED: it
 * changes solely through POST /jobs/{id}/transition (§4.10). `null` on
 * assigned_engineer_id / fault_code_id unassigns.
 */
export class UpdateJobDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  fault_reported?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  tech_report?: string;

  @IsOptional()
  @IsUUID()
  assigned_engineer_id?: string | null;

  @IsOptional()
  @IsEnum(WarrantyStatus)
  warranty_status?: WarrantyStatus;

  @IsOptional()
  @IsEnum(ServiceType)
  service_type?: ServiceType;

  @IsOptional()
  @IsEnum(JobCoverage)
  coverage?: JobCoverage;

  @IsOptional()
  @IsEnum(WarrantySource)
  warranty_source?: WarrantySource;

  @IsOptional()
  @IsUUID()
  warranty_registration_id?: string | null;

  @IsOptional()
  @IsUUID()
  fault_code_id?: string | null;

  /**
   * GSPN diagnostic codes (§4.7). Each is validated to be a service code of
   * the matching KIND — the ids are interchangeable UUIDs, so nothing else
   * stops a REPAIR code landing in `symptom_code_id`. `null` clears one.
   */
  @IsOptional()
  @IsUUID()
  condition_code_id?: string | null;

  @IsOptional()
  @IsUUID()
  symptom_code_id?: string | null;

  @IsOptional()
  @IsUUID()
  defect_code_id?: string | null;

  @IsOptional()
  @IsUUID()
  defect_type_id?: string | null;

  @IsOptional()
  @IsUUID()
  defect_block_id?: string | null;

  @IsOptional()
  @IsUUID()
  repair_code_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  repair_description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  accessories_held?: string;

  @IsOptional()
  @IsISO8601()
  appointment_at?: string | null;

  @IsOptional()
  @IsISO8601()
  return_by_date?: string | null;

  @IsOptional()
  @IsISO8601()
  repair_warranty_until?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  so_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  /**
   * Admin overrides (§4.11). When a guard blocks this request, ask for an
   * override with `request_override` + `override_reason` (which raises a
   * PENDING approval and changes NOTHING), then retry the same request with
   * `override_approval_id` once it is approved. One approval, one use.
   */
  @IsOptional()
  @IsBoolean()
  request_override?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  override_reason?: string;

  @IsOptional()
  @IsUUID()
  override_approval_id?: string;
}

/**
 * POST /jobs/{id}/transition — the ONLY way a job's status changes.
 * `to_state_code` is the target workflow-state code; `note` is recorded on
 * the TRANSITION audit row.
 */
export class TransitionJobDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  to_state_code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /**
   * Admin overrides (§4.11). When a guard blocks this request, ask for an
   * override with `request_override` + `override_reason` (which raises a
   * PENDING approval and changes NOTHING), then retry the same request with
   * `override_approval_id` once it is approved. One approval, one use.
   */
  @IsOptional()
  @IsBoolean()
  request_override?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  override_reason?: string;

  @IsOptional()
  @IsUUID()
  override_approval_id?: string;
}

/**
 * POST /jobs/{id}/dispatch — convenience wrapper that transitions the job to
 * DISPATCHED while stamping the handover details.
 */
export class DispatchJobDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  received_by!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  waybill_no?: string;
}
