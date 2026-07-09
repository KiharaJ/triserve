import { ALL_PERMISSIONS } from '@triserve/shared';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

/** GET /workflow/states?q=&active=&page=&page_size= */
export class WorkflowStateListQueryDto extends ListQueryDto {
  @IsOptional()
  @BooleanQuery()
  active?: boolean;
}

/** GET /workflow/transitions?q=&page=&page_size= (q matches state codes). */
export class WorkflowTransitionListQueryDto extends ListQueryDto {}

/** POST /workflow/states */
export class CreateWorkflowStateDto {
  /** SCREAMING_SNAKE_CASE status code, unique per company (e.g. 'QC'). */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message:
      'code must be SCREAMING_SNAKE_CASE (letters, digits, underscores; starts with a letter)',
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;

  @IsOptional()
  @IsBoolean()
  is_initial?: boolean;

  @IsOptional()
  @IsBoolean()
  is_terminal?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** POST /workflow/transitions — states referenced by their codes. */
export class CreateWorkflowTransitionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  from_code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  to_code!: string;

  /**
   * Permission the acting user must hold to take this edge (null = any
   * authenticated user). Must be a known @triserve/shared permission so a
   * typo cannot silently lock (or open) an edge.
   */
  @IsOptional()
  @IsIn(ALL_PERMISSIONS, {
    message: 'required_permission must be a known permission action',
  })
  required_permission?: string;

  @IsOptional()
  @IsBoolean()
  requires_approval?: boolean;

  /** Name of a registered workflow guard (see guards/registry.ts). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  guard_code?: string;
}
