import { WarrantyKind, WarrantyRegistrationStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/**
 * POST /warranty-registrations — register a warranty on a sold product. Either
 * `expiry_date` or `months` (from start_date) must be given. `branch_id`
 * defaults to the seller's branch; customer/device/invoice are optional links.
 */
export class CreateWarrantyRegistrationDto {
  @IsString()
  @MaxLength(255)
  product_name!: string;

  @IsEnum(WarrantyKind)
  kind!: WarrantyKind;

  @IsISO8601()
  start_date!: string;

  @IsOptional()
  @IsISO8601()
  expiry_date?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  months?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsUUID()
  device_id?: string;

  @IsOptional()
  @IsUUID()
  invoice_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  terms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** PATCH /warranty-registrations/{id} — edit or void. */
export class UpdateWarrantyRegistrationDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  product_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsISO8601()
  expiry_date?: string;

  @IsOptional()
  @IsEnum(WarrantyRegistrationStatus)
  status?: WarrantyRegistrationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  terms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** GET /warranty-registrations?status=&kind=&customer_id=&q=&page= */
export class WarrantyRegistrationListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsEnum(WarrantyKind)
  kind?: WarrantyKind;

  @IsOptional()
  @IsUUID()
  customer_id?: string;
}
