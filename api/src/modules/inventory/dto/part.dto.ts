import { DeviceCategory } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

/** Money on the wire = BIGINT minor-unit digits as a string (§ money convention). */
const MINOR_UNITS = /^\d{1,15}$/;
const MINOR_UNITS_MSG = 'must be BIGINT minor units (digits only)';

/**
 * GET /parts?category=&active=&q=&page= — `q` matches part_number / description.
 */
export class PartListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  @IsOptional()
  @BooleanQuery()
  active?: boolean;
}

/**
 * POST /parts — catalogue entry (one per part number per company).
 * `unit_cost_usd` (USD cents) is the landed cost; `default_sell_price_tzs`
 * (TZS minor units) the OW counter price — both BIGINT minor-unit strings.
 * `compatible_models` is a list of model codes this part fits (§4.4).
 */
export class CreatePartDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  part_number!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsEnum(DeviceCategory)
  category!: DeviceCategory;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: `unit_cost_usd ${MINOR_UNITS_MSG}` })
  unit_cost_usd?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: `default_sell_price_tzs ${MINOR_UNITS_MSG}`,
  })
  default_sell_price_tzs?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  compatible_models?: string[];

  @IsOptional()
  @IsBoolean()
  is_serialized?: boolean;

  @IsOptional()
  @IsUUID()
  preferred_supplier_id?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** PATCH /parts/{id} — every field optional; `null` clears nullable money. */
export class UpdatePartDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  part_number?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: `unit_cost_usd ${MINOR_UNITS_MSG}` })
  unit_cost_usd?: string | null;

  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: `default_sell_price_tzs ${MINOR_UNITS_MSG}`,
  })
  default_sell_price_tzs?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  compatible_models?: string[];

  @IsOptional()
  @IsBoolean()
  is_serialized?: boolean;

  @IsOptional()
  @IsUUID()
  preferred_supplier_id?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
