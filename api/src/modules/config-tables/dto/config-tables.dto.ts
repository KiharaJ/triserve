import type { DeviceCategory, ServiceCodeKind } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

/** Prisma enums are types, not values — class-validator needs a value object. */
const SERVICE_CODE_KINDS: Record<ServiceCodeKind, ServiceCodeKind> = {
  CONDITION: 'CONDITION',
  SYMPTOM: 'SYMPTOM',
  DEFECT: 'DEFECT',
  DEFECT_TYPE: 'DEFECT_TYPE',
  DEFECT_BLOCK: 'DEFECT_BLOCK',
  REPAIR: 'REPAIR',
};

const DEVICE_CATEGORIES: Record<DeviceCategory, DeviceCategory> = {
  HHP: 'HHP',
  CE: 'CE',
  AC: 'AC',
  REF: 'REF',
  OTHER: 'OTHER',
};

/**
 * Wire DTOs for the per-company config tables (Task 0.7, DESIGN.md §4.14 /
 * E17): payment methods, fault codes, repair actions, tax rates, currencies.
 * Snake_case per API convention. Money values travel as STRINGS of BIGINT
 * minor units (senti) — never floats. DTOs are deliberately FLAT (no
 * inheritance): class-validator merges inherited metadata, which would
 * stack conflicting length rules.
 */

const CODE_PATTERN = /^[A-Z0-9_-]+$/i;
const CODE_MESSAGE = 'code may only contain letters, digits, "-" and "_"';

/** GET list query for every config table. */
export class ConfigListQueryDto extends ListQueryDto {
  @IsOptional()
  @BooleanQuery()
  active?: boolean;
}

// --- Payment methods ---------------------------------------------------------

export class CreatePaymentMethodDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePaymentMethodDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// --- Fault codes ---------------------------------------------------------------

export class CreateFaultCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateFaultCodeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// --- Service codes (Samsung GSPN, §4.7) -----------------------------------------

/**
 * `service_codes` is six lookups in one table, so `kind` is required on create
 * and the list endpoint is nearly always filtered by it — a picker wants
 * SYMPTOM codes, never a mixed bag of all six.
 *
 * Note the code pattern is NOT applied here: Samsung's codes are theirs, and
 * rejecting one we did not anticipate would block a legitimate claim. Length
 * is bounded; the character set is not ours to police.
 */
export class ServiceCodeListQueryDto extends ConfigListQueryDto {
  @IsOptional()
  @IsEnum(SERVICE_CODE_KINDS)
  kind?: ServiceCodeKind;

  @IsOptional()
  @IsEnum(DEVICE_CATEGORIES)
  category?: DeviceCategory;
}

export class CreateServiceCodeDto {
  @IsEnum(SERVICE_CODE_KINDS)
  kind!: ServiceCodeKind;

  @IsString()
  @MinLength(1)
  @MaxLength(30)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  /** Narrows the code to one device grouping; omit/null = applies to all. */
  @IsOptional()
  @IsEnum(DEVICE_CATEGORIES)
  category?: DeviceCategory | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateServiceCodeDto {
  @IsOptional()
  @IsEnum(SERVICE_CODE_KINDS)
  kind?: ServiceCodeKind;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label?: string;

  @IsOptional()
  @IsEnum(DEVICE_CATEGORIES)
  category?: DeviceCategory | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// --- Repair actions -------------------------------------------------------------

export class CreateRepairActionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  /** Default labour price in BIGINT minor units (senti), as a string. */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'default_labour_price must be minor units (digits only)',
  })
  default_labour_price?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  default_currency?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateRepairActionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label?: string;

  /** Minor units string, or null to clear. */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'default_labour_price must be minor units (digits only)',
  })
  default_labour_price?: string | null;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  default_currency?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// --- Tax rates ---------------------------------------------------------------------

export class CreateTaxRateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  /** Percentage as a decimal string, e.g. "18" or "18.5" (max 3 dp). */
  @Matches(/^\d{1,3}(\.\d{1,3})?$/, {
    message: 'percent must be a decimal like "18" or "18.5"',
  })
  percent!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateTaxRateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label?: string;

  @IsOptional()
  @Matches(/^\d{1,3}(\.\d{1,3})?$/, {
    message: 'percent must be a decimal like "18" or "18.5"',
  })
  percent?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// --- Currencies -----------------------------------------------------------------------

export class CreateCurrencyDto {
  @IsString()
  @Matches(/^[A-Z]{3}$/i, { message: 'code must be a 3-letter ISO code' })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10)
  symbol!: string;
}

export class UpdateCurrencyDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/i, { message: 'code must be a 3-letter ISO code' })
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  symbol?: string;
}
