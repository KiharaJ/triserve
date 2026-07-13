import { DeviceCategory } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/**
 * GET /devices?imei=&customer_id=&page=&page_size=
 * `imei` is normalized (scientific notation expanded, separators stripped)
 * before matching imei_serial.
 */
export class DeviceListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  imei?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;
}

/** POST /devices */
export class CreateDeviceDto {
  @IsUUID()
  customer_id!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  brand?: string;

  /** Free-text model as captured at the desk (legacy data is messy). */
  @IsOptional()
  @IsString()
  @MaxLength(150)
  model?: string;

  /** Optional normalized link to the `models` lookup. */
  @IsOptional()
  @IsUUID()
  model_id?: string;

  /** Samsung-repair grouping; optional for retail devices (defaults OTHER). */
  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  /** Flexible retail type: Mobile, Watch, TV, Laptop, AC, Two-Wheeler… */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  device_type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  imei_serial?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;
}

/** PATCH /devices/{id} — all fields optional (incl. ownership transfer). */
export class UpdateDeviceDto {
  @IsOptional()
  @IsUUID()
  customer_id?: string;

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
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  device_type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  imei_serial?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;
}
