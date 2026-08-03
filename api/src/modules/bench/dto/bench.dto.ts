import { DeviceCategory, QcCheckResult } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

// ---------------------------------------------------------------------------
// Technician skill matrix (proposal §3, BOOKED → ASSIGNED)
// ---------------------------------------------------------------------------

export class SkillListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  /** Only technicians authorised to sign off the QC gate. */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  can_qc?: boolean;
}

export class UpsertSkillDto {
  @IsUUID()
  user_id!: string;

  @IsEnum(DeviceCategory)
  category!: DeviceCategory;

  /** Narrow to one service line; omit for the whole device class. */
  @IsOptional()
  @IsUUID()
  service_category_id?: string | null;

  /** 1 = trainee … 5 = master. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  level?: number;

  /** Senior Quality Assurer for this device class. */
  @IsOptional()
  @IsBoolean()
  can_qc?: boolean;

  @IsOptional()
  @IsISO8601()
  certified_at?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ---------------------------------------------------------------------------
// QC checklist template (proposal §3, "Mandatory Calibration Logs")
// ---------------------------------------------------------------------------

export class QcItemListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;
}

export class UpsertQcItemDto {
  @IsEnum(DeviceCategory)
  category!: DeviceCategory;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[A-Z0-9_]+$/, {
    message: 'code must be uppercase letters, digits or underscores',
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  help?: string;

  @IsOptional()
  @IsBoolean()
  requires_value?: boolean;

  @IsOptional()
  @IsBoolean()
  requires_attachment?: boolean;

  /** false = advisory: must be answered, may be failed without blocking. */
  @IsOptional()
  @IsBoolean()
  blocking?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Recording QC results + declaring bench work
// ---------------------------------------------------------------------------

export class QcCheckInput {
  @IsUUID()
  item_id!: string;

  @IsEnum(QcCheckResult)
  result!: QcCheckResult;

  /** The measured reading, for items that require one (e.g. "102 kPa"). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  value?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * PUT /jobs/{id}/qc-checks — record the calibration/flash results for the
 * CURRENT attempt. Replace semantics like the condition map: the Quality
 * Assurer works one form and may correct an entry before submitting.
 */
export class SaveQcChecksDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QcCheckInput)
  checks!: QcCheckInput[];
}

/**
 * PATCH /jobs/{id}/work — the technician declaring what they actually did
 * (proposal §3: IN_REPAIR → QC "Forces input of actual labor hours and
 * technician repair notes").
 *
 * A separate endpoint from the generic job PATCH so the two mandatory fields
 * travel together and the UI has one obvious "submit my work" action.
 */
export class DeclareWorkDto {
  /** Actual hands-on hours. Not money — a plain decimal. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999)
  labour_hours!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(5000)
  tech_report!: string;
}

/**
 * POST /jobs/{id}/qc-reject — the Quality Assurer bouncing a unit back to the
 * bench with the mandatory failure reason (proposal §3, QC_TESTING →
 * DIAGNOSIS). Recording the reason and performing the move are ONE action, so
 * a reason can never be logged without the rejection actually happening.
 */
export class QcRejectDto {
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  reason!: string;

  /** Where to send it back to; defaults to the repair stage. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  to_state_code?: string;
}
