import { DeviceCategory, WarrantyKind } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

const MINOR_UNITS = /^\d{1,15}$/;

/** POST /products — a retail catalogue item (any brand). */
export class CreateProductDto {
  @IsString()
  @MaxLength(60)
  sku!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  device_type?: string;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'sell_price_tzs must be minor units (digits only)' })
  sell_price_tzs?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'cost_usd must be minor units (digits only)' })
  cost_usd?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock_qty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  default_warranty_months?: number;

  @IsOptional()
  @IsEnum(WarrantyKind)
  default_warranty_kind?: WarrantyKind;

  @IsOptional()
  @IsBoolean()
  is_serialized?: boolean;
}

/** PATCH /products/{id} — all fields optional. */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  device_type?: string;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'sell_price_tzs must be minor units (digits only)' })
  sell_price_tzs?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'cost_usd must be minor units (digits only)' })
  cost_usd?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock_qty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  default_warranty_months?: number;

  @IsOptional()
  @IsEnum(WarrantyKind)
  default_warranty_kind?: WarrantyKind | null;

  @IsOptional()
  @IsBoolean()
  is_serialized?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** GET /products?q=&type=&active=&page= */
export class ProductListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @IsOptional()
  @BooleanQuery()
  active?: boolean;
}
