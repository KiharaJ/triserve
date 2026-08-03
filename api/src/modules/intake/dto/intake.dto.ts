import { DamageSeverity, DamageType, DeviceCategory } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
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
// Symptom tree (proposal §2 step 4)
// ---------------------------------------------------------------------------

/** GET /symptom-nodes?parent_id=&category=&leaf_only= */
export class SymptomNodeQueryDto extends ListQueryDto {
  /**
   * Children of this node. Omit for the ROOT tier — which is why "no
   * parent_id" cannot simply mean "everything": the cascading picker asks for
   * one tier at a time, and `roots_only` distinguishes "give me tier 1" from
   * "give me the whole tree to search".
   */
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  /** Only selectable symptom triggers (used by free-text search). */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  leaf_only?: boolean;
}

export class UpsertSymptomNodeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(/^[A-Z0-9._-]+$/, {
    message: 'code must be uppercase letters, digits, dots, dashes or underscores',
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string | null;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory | null;

  @IsOptional()
  @IsUUID()
  fault_code_id?: string | null;

  @IsOptional()
  @IsUUID()
  service_category_id?: string | null;

  /** Indicative OW price, minor units (digits only) — see the money convention. */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'estimate_amount must be minor units (digits only)',
  })
  estimate_amount?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  @MinLength(3)
  estimate_currency?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  estimate_minutes?: number | null;

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
// Condition map (proposal §2 step 3)
// ---------------------------------------------------------------------------

export class ConditionZoneQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;
}

export class UpsertConditionZoneDto {
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
  @MaxLength(120)
  label!: string;

  /** Normalised hotspot position on the outline, 0–1. */
  @IsNumber()
  @Min(0)
  @Max(1)
  x!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  y!: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  face?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** One tick on the interactive device outline. */
export class ConditionMarkInput {
  @IsUUID()
  zone_id!: string;

  @IsEnum(DamageType)
  damage!: DamageType;

  @IsOptional()
  @IsEnum(DamageSeverity)
  severity?: DamageSeverity;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * PUT /jobs/{id}/condition — the whole condition walk-through in one call.
 *
 * REPLACE semantics, not append: the agent works the map as a single form and
 * may untick something they ticked a moment ago. Sending the complete set and
 * replacing avoids a delete-then-add dance from the client, and makes the
 * "agent completed the check" stamp meaningful — it is set by THIS call.
 *
 * An EMPTY `marks` array is meaningful and allowed: it records "I looked, the
 * device is unmarked", which is exactly the evidence a later dispute needs.
 */
export class SaveJobConditionDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ConditionMarkInput)
  marks!: ConditionMarkInput[];

  /**
   * Tri-state, mirroring the column: omit = not checked, false = checked and
   * clean, true = tripped. "Not checked" and "clean" must never look alike in
   * a liquid-damage warranty dispute.
   */
  @IsOptional()
  @IsBoolean()
  liquid_indicator_tripped?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// ---------------------------------------------------------------------------
// Digital agreement (proposal §2 step 5)
// ---------------------------------------------------------------------------

/**
 * POST /jobs/{id}/terms — record that the customer was shown the service
 * terms, data-loss disclaimer and disposal policy, saw the preliminary
 * estimate, and signed.
 */
export class AcceptTermsDto {
  /**
   * The signature ATTACHMENT already uploaded for this job. Required: the
   * proposal's step 5 is "The customer signs digitally on a tablet/pad", and
   * a terms stamp with no signature behind it is precisely the unevidenced
   * claim this whole module exists to prevent.
   */
  @IsUUID()
  signature_attachment_id!: string;

  /** The preliminary estimate shown, minor units. */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'estimate_amount must be minor units (digits only)',
  })
  estimate_amount?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  estimate_currency?: string;

  /** The symptom-tree LEAF the agent selected. */
  @IsOptional()
  @IsUUID()
  symptom_node_id?: string;
}
