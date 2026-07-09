import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

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
