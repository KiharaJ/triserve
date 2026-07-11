import { PartUnitStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /parts/{partId}/units — register one or more serial/batch units into
 * stock (§4.4/E11). The part must be is_serialized. `branch_id` is the location
 * (defaults to the user's home branch).
 */
export class RegisterUnitsDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  serials!: string[];

  @IsOptional()
  @IsUUID()
  supplier_id?: string;

  @IsOptional()
  @IsUUID()
  grn_id?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY, { message: 'warranty_expiry must be YYYY-MM-DD' })
  warranty_expiry?: string;
}

/** PATCH /part-units/{id} — status / location / warranty / job linkage. */
export class UpdatePartUnitDto {
  @IsOptional()
  @IsEnum(PartUnitStatus)
  status?: PartUnitStatus;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY, { message: 'warranty_expiry must be YYYY-MM-DD' })
  warranty_expiry?: string | null;

  @IsOptional()
  @IsUUID()
  installed_on_job_id?: string | null;

  @IsOptional()
  @IsUUID()
  removed_from_job_id?: string | null;
}

/** GET /part-units?part_id=&branch_id=&status=&serial=&page= */
export class PartUnitListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  part_id?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsEnum(PartUnitStatus)
  status?: PartUnitStatus;

  /** Serial/batch search (contains) — the recall / "which unit" lookup. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial?: string;
}
