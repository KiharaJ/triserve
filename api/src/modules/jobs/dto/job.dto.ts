import { DeviceCategory, WarrantyStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
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
  @IsString()
  @MaxLength(5000)
  fault_reported?: string;

  @IsOptional()
  @IsUUID()
  fault_code_id?: string;

  @IsOptional()
  @IsUUID()
  assigned_engineer_id?: string;

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
  @IsUUID()
  fault_code_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  so_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
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
