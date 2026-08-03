import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type DamageSeverity,
  type DamageType,
  type DeviceCategory,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { JobsService } from '../jobs/jobs.service';
import type {
  AcceptTermsDto,
  ConditionZoneQueryDto,
  SaveJobConditionDto,
  SymptomNodeQueryDto,
  UpsertConditionZoneDto,
  UpsertSymptomNodeDto,
} from './dto/intake.dto';

/**
 * Intake integrity (SCMS proposal Module 1, §2).
 *
 * "The intake process dictates system data integrity. If weak, inconsistent,
 * or unverified information is entered at the counter, downstream operations
 * (diagnostics, parts procurement, and billing) will instantly fragment."
 *
 * This service owns the three structured captures that replace free text at
 * the counter — the cascading symptom tree, the visual condition map, and the
 * digital agreement — plus the readiness check the workflow guard consults.
 *
 * IMEI/serial validation (step 1) is enforced where the identifier is written
 * (DevicesService / JobsService intake) rather than here, so it cannot be
 * bypassed by creating a device through a different route.
 */

export interface SymptomNodeWire {
  id: string;
  code: string;
  label: string;
  parent_id: string | null;
  level: number;
  is_leaf: boolean;
  category: DeviceCategory | null;
  fault_code_id: string | null;
  service_category_id: string | null;
  estimate_amount: string | null;
  estimate_currency: string | null;
  estimate_minutes: number | null;
  sort_order: number;
  active: boolean;
  /** The ancestor labels, root-first — "Display › Backlight › Flickers…". */
  path: string[];
}

export interface ConditionZoneWire {
  id: string;
  category: DeviceCategory;
  code: string;
  label: string;
  x: number;
  y: number;
  face: string;
  sort_order: number;
  active: boolean;
}

export interface ConditionMarkWire {
  id: string;
  zone_id: string;
  zone_code: string;
  zone_label: string;
  face: string;
  x: number;
  y: number;
  damage: DamageType;
  severity: DamageSeverity;
  note: string | null;
}

/** The whole condition record for one job. */
export interface JobConditionWire {
  job_id: string;
  category: DeviceCategory;
  captured_at: string | null;
  captured_by: string | null;
  liquid_indicator_tripped: boolean | null;
  marks: ConditionMarkWire[];
  /** The hotspot layout for this device's class, so one call renders the map. */
  zones: ConditionZoneWire[];
}

/**
 * What the front desk still owes before the device may leave the counter —
 * the same rule the `intake_evidence_complete` workflow guard enforces,
 * exposed as data so the UI can show a checklist rather than making the agent
 * discover the requirement by being refused.
 */
export interface IntakeReadinessWire {
  job_id: string;
  ready: boolean;
  condition_captured: boolean;
  symptom_selected: boolean;
  terms_accepted: boolean;
  has_before_photo: boolean;
  has_signature: boolean;
  /** Human-readable outstanding items, in the order the counter works them. */
  outstanding: string[];
}

const DEFAULT_PAGE_SIZE = 200;

@Injectable()
export class IntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  // ------------------------------------------------------- symptom tree

  /**
   * One TIER of the cascading picker (children of `parent_id`, or the roots).
   * `q` switches to a flat LEAF search across the whole tree — an experienced
   * agent types "flicker" rather than clicking down three levels, and forcing
   * the cascade on them would slow the counter down for no gain in data
   * quality (the stored value is the same leaf either way).
   */
  async listSymptomNodes(
    query: SymptomNodeQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<SymptomNodeWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const searching = Boolean(query.q?.trim());

    const where: Prisma.SymptomNodeWhereInput = {
      deletedAt: null,
      active: true,
      ...(query.category
        ? // A node with NO category applies to every device class.
          { OR: [{ category: query.category }, { category: null }] }
        : {}),
      ...(searching
        ? { isLeaf: true, label: { contains: query.q } }
        : { parentId: query.parent_id ?? null }),
      ...(query.leaf_only ? { isLeaf: true } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.symptomNode.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.symptomNode.count({ where }),
    ]);

    // Search results are meaningless without their ancestry: "Flickers only
    // when warm" could be a display or an AC fault. Only resolved when
    // searching — the cascade already shows the path on screen.
    const paths = searching
      ? await this.resolvePaths(rows.map((r) => r.id))
      : new Map<string, string[]>();

    return {
      data: rows.map((r) => symptomToWire(r, paths.get(r.id) ?? [])),
      page,
      page_size: pageSize,
      total,
    };
  }

  /** Create or update a symptom node (config, 'config.manage'). */
  async upsertSymptomNode(
    dto: UpsertSymptomNodeDto,
    user: AuthUser,
    id?: string,
  ): Promise<SymptomNodeWire> {
    const parent = dto.parent_id
      ? await this.prisma.symptomNode.findFirst({
          where: { id: dto.parent_id, deletedAt: null },
          select: { id: true, level: true },
        })
      : null;
    if (dto.parent_id && !parent) {
      throw new BadRequestException('parent_id does not match a symptom node');
    }
    // A node cannot be its own ancestor. Cheap to check, and a cycle would
    // make the picker (and resolvePaths) loop forever.
    if (id && dto.parent_id && (await this.isDescendant(dto.parent_id, id))) {
      throw new UnprocessableEntityException(
        'A symptom node cannot be moved underneath its own descendant',
      );
    }

    const level = parent ? parent.level + 1 : 1;
    const data = {
      code: dto.code,
      label: dto.label,
      parentId: dto.parent_id ?? null,
      level,
      category: dto.category ?? null,
      faultCodeId: dto.fault_code_id ?? null,
      serviceCategoryId: dto.service_category_id ?? null,
      estimateAmount: dto.estimate_amount ? BigInt(dto.estimate_amount) : null,
      estimateCurrency: dto.estimate_currency ?? null,
      estimateMinutes: dto.estimate_minutes ?? null,
      sortOrder: dto.sort_order ?? 0,
      active: dto.active ?? true,
      updatedById: user.userId,
    };

    let row;
    try {
      row = id
        ? await this.prisma.symptomNode.update({ where: { id }, data })
        : await this.prisma.symptomNode.create({
            data: {
              ...data,
              id: randomUUID(),
              companyId: user.companyId,
              // A brand-new node has no children yet, so it is a leaf until
              // one is added — see recomputeLeaf below.
              isLeaf: true,
              createdById: user.userId,
            },
          });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A symptom node with code '${dto.code}' already exists`,
        );
      }
      throw e;
    }

    // Adding a child demotes the parent from leaf; the picker must stop
    // offering it as a selectable symptom the moment it has a tier below it.
    if (dto.parent_id) await this.recomputeLeaf(dto.parent_id);
    await this.recomputeLeaf(row.id);

    const fresh = await this.prisma.symptomNode.findFirstOrThrow({
      where: { id: row.id },
    });
    return symptomToWire(fresh, []);
  }

  /** Soft-delete a symptom node; refuses while it still has children. */
  async removeSymptomNode(id: string, user: AuthUser): Promise<{ id: string }> {
    const node = await this.prisma.symptomNode.findFirst({
      where: { id, deletedAt: null },
    });
    if (!node) throw new NotFoundException('Symptom node not found');

    const children = await this.prisma.symptomNode.count({
      where: { parentId: id, deletedAt: null },
    });
    if (children > 0) {
      throw new ConflictException(
        `Remove or move the ${children} symptom(s) underneath this one first`,
      );
    }

    await this.prisma.symptomNode.update({
      where: { id },
      data: { active: false, deletedAt: new Date(), updatedById: user.userId },
    });
    if (node.parentId) await this.recomputeLeaf(node.parentId);
    return { id };
  }

  // ---------------------------------------------------- condition zones

  async listConditionZones(
    query: ConditionZoneQueryDto,
  ): Promise<PaginatedResponse<ConditionZoneWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.ConditionZoneWhereInput = {
      deletedAt: null,
      active: true,
      ...(query.category ? { category: query.category } : {}),
      ...(query.q ? { label: { contains: query.q } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.conditionZone.findMany({
        where,
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.conditionZone.count({ where }),
    ]);

    return { data: rows.map(zoneToWire), page, page_size: pageSize, total };
  }

  async upsertConditionZone(
    dto: UpsertConditionZoneDto,
    user: AuthUser,
    id?: string,
  ): Promise<ConditionZoneWire> {
    const data = {
      category: dto.category,
      code: dto.code,
      label: dto.label,
      x: new Prisma.Decimal(dto.x),
      y: new Prisma.Decimal(dto.y),
      face: dto.face ?? 'FRONT',
      sortOrder: dto.sort_order ?? 0,
      active: dto.active ?? true,
      updatedById: user.userId,
    };
    try {
      const row = id
        ? await this.prisma.conditionZone.update({ where: { id }, data })
        : await this.prisma.conditionZone.create({
            data: {
              ...data,
              id: randomUUID(),
              companyId: user.companyId,
              createdById: user.userId,
            },
          });
      return zoneToWire(row);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A ${dto.category} hotspot with code '${dto.code}' already exists`,
        );
      }
      throw e;
    }
  }

  /**
   * Soft-delete a hotspot. Existing marks on past jobs KEEP pointing at it —
   * the FK still resolves, so a two-year-old condition report still renders.
   * Deactivating only removes it from the intake form.
   */
  async removeConditionZone(
    id: string,
    user: AuthUser,
  ): Promise<{ id: string }> {
    const zone = await this.prisma.conditionZone.findFirst({
      where: { id, deletedAt: null },
    });
    if (!zone) throw new NotFoundException('Condition zone not found');
    await this.prisma.conditionZone.update({
      where: { id },
      data: { active: false, deletedAt: new Date(), updatedById: user.userId },
    });
    return { id };
  }

  // ------------------------------------------------- per-job condition

  /** GET /jobs/{id}/condition — the marks plus the layout to render them on. */
  async getJobCondition(
    jobId: string,
    user: AuthUser,
  ): Promise<JobConditionWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const device = await this.prisma.device.findFirstOrThrow({
      where: { id: job.deviceId },
      select: { category: true },
    });

    const [marks, zones] = await Promise.all([
      this.prisma.jobConditionMark.findMany({
        where: { jobId },
        include: { zone: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.conditionZone.findMany({
        where: { category: device.category, active: true, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    return {
      job_id: jobId,
      category: device.category,
      captured_at: job.conditionCapturedAt?.toISOString() ?? null,
      captured_by: job.conditionCapturedById,
      liquid_indicator_tripped: job.liquidIndicatorTripped,
      marks: marks.map(markToWire),
      zones: zones.map(zoneToWire),
    };
  }

  /**
   * PUT /jobs/{id}/condition — record the visual walk-through.
   *
   * Replaces the whole set (see the DTO for why) and stamps
   * `condition_captured_at`, which is what the intake guard checks. Both
   * happen in ONE transaction: a half-saved condition report that nonetheless
   * counted as "captured" would let a device through the gate with evidence
   * missing.
   */
  async saveJobCondition(
    jobId: string,
    dto: SaveJobConditionDto,
    user: AuthUser,
  ): Promise<JobConditionWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const device = await this.prisma.device.findFirstOrThrow({
      where: { id: job.deviceId },
      select: { category: true },
    });

    // Validate every zone up front: a mark against another device class's
    // hotspot would render at a nonsense position on the outline.
    const zoneIds = [...new Set(dto.marks.map((m) => m.zone_id))];
    if (zoneIds.length > 0) {
      const zones = await this.prisma.conditionZone.findMany({
        where: { id: { in: zoneIds }, deletedAt: null },
        select: { id: true, category: true },
      });
      const byId = new Map(zones.map((z) => [z.id, z]));
      for (const zid of zoneIds) {
        const zone = byId.get(zid);
        if (!zone) {
          throw new BadRequestException(
            `zone_id ${zid} does not match a condition hotspot`,
          );
        }
        if (zone.category !== device.category) {
          throw new UnprocessableEntityException(
            `Hotspot ${zid} belongs to ${zone.category}, but this device is ${device.category}`,
          );
        }
      }
    }

    // The unique key is (job, zone, damage), so the same dent reported twice
    // in one payload would collide. De-duplicate rather than 500 — a UI that
    // sends a duplicate is being clumsy, not malicious.
    const deduped = new Map<string, (typeof dto.marks)[number]>();
    for (const m of dto.marks) deduped.set(`${m.zone_id}:${m.damage}`, m);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.jobConditionMark.deleteMany({ where: { jobId } });
      for (const m of deduped.values()) {
        await tx.jobConditionMark.create({
          data: {
            id: randomUUID(),
            companyId: job.companyId,
            jobId,
            zoneId: m.zone_id,
            damage: m.damage,
            severity: m.severity ?? 'MINOR',
            note: m.note ?? null,
            createdById: user.userId,
            updatedById: user.userId,
          },
        });
      }
      await tx.job.update({
        where: { id: jobId },
        data: {
          conditionCapturedAt: now,
          conditionCapturedById: user.userId,
          ...(dto.liquid_indicator_tripped !== undefined
            ? { liquidIndicatorTripped: dto.liquid_indicator_tripped }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedById: user.userId,
        },
      });
    });

    // Semantic row: the mechanical mark creates are audited individually, but
    // "the condition walk-through was completed, with N findings" is the fact
    // a dispute actually turns on.
    await this.audit.record({
      entityType: 'Job',
      entityId: jobId,
      action: 'UPDATE',
      before: null,
      after: {
        condition_captured_at: now.toISOString(),
        mark_count: deduped.size,
        liquid_indicator_tripped: dto.liquid_indicator_tripped ?? null,
      },
      companyId: job.companyId,
      branchId: job.branchId,
      actorUserId: user.userId,
    });

    return this.getJobCondition(jobId, user);
  }

  // ------------------------------------------------- digital agreement

  /**
   * POST /jobs/{id}/terms — the customer signed (proposal §2 step 5).
   *
   * Verifies the signature attachment actually belongs to THIS job and is
   * actually a signature. Without that check the field is a self-assertion:
   * any UUID would do, including one from another customer's job.
   */
  async acceptTerms(
    jobId: string,
    dto: AcceptTermsDto,
    user: AuthUser,
  ): Promise<IntakeReadinessWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);

    const signature = await this.prisma.attachment.findFirst({
      where: {
        id: dto.signature_attachment_id,
        ownerType: 'JOB',
        ownerId: jobId,
        kind: 'SIGNATURE',
      },
      select: { id: true },
    });
    if (!signature) {
      throw new UnprocessableEntityException(
        'signature_attachment_id must be a SIGNATURE attachment uploaded against this job',
      );
    }

    if (dto.symptom_node_id) {
      const node = await this.prisma.symptomNode.findFirst({
        where: { id: dto.symptom_node_id, deletedAt: null },
        select: { isLeaf: true },
      });
      if (!node) {
        throw new BadRequestException(
          'symptom_node_id does not match a symptom node',
        );
      }
      // The whole point of the tree (§2 step 4) is that "Display" is not a
      // diagnosis. Only a trigger is selectable.
      if (!node.isLeaf) {
        throw new UnprocessableEntityException(
          'Pick a specific symptom, not a category — only the deepest level of the tree can be recorded on a job',
        );
      }
    }

    const now = new Date();
    await this.prisma.job.update({
      where: { id: jobId },
      data: {
        termsAcceptedAt: now,
        ...(dto.estimate_amount !== undefined
          ? { estimateAmount: BigInt(dto.estimate_amount) }
          : {}),
        ...(dto.estimate_currency !== undefined
          ? { estimateCurrency: dto.estimate_currency }
          : {}),
        ...(dto.symptom_node_id !== undefined
          ? { symptomNodeId: dto.symptom_node_id }
          : {}),
        updatedById: user.userId,
      },
    });

    await this.audit.record({
      entityType: 'Job',
      entityId: jobId,
      action: 'UPDATE',
      before: null,
      after: {
        terms_accepted_at: now.toISOString(),
        signature_attachment_id: dto.signature_attachment_id,
        estimate_amount: dto.estimate_amount ?? null,
        estimate_currency: dto.estimate_currency ?? null,
      },
      companyId: job.companyId,
      branchId: job.branchId,
      actorUserId: user.userId,
    });

    return this.readiness(jobId, user);
  }

  /**
   * GET /jobs/{id}/intake-readiness — the same conditions the
   * `intake_evidence_complete` guard applies, as a checklist. Kept in step
   * with the guard by construction: both read the same five facts, and the
   * guard's message is generated from the same wording.
   */
  async readiness(jobId: string, user: AuthUser): Promise<IntakeReadinessWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);

    const files = await this.prisma.attachment.findMany({
      where: {
        ownerType: 'JOB',
        ownerId: jobId,
        kind: { in: ['PHOTO_BEFORE', 'SIGNATURE'] },
      },
      select: { kind: true },
    });

    const conditionCaptured = job.conditionCapturedAt !== null;
    const symptomSelected = job.symptomNodeId !== null;
    const termsAccepted = job.termsAcceptedAt !== null;
    const hasBeforePhoto = files.some((f) => f.kind === 'PHOTO_BEFORE');
    const hasSignature = files.some((f) => f.kind === 'SIGNATURE');

    const outstanding: string[] = [];
    if (!conditionCaptured) outstanding.push('the visual condition check');
    if (!symptomSelected) outstanding.push('a symptom-tree selection');
    if (!hasBeforePhoto) outstanding.push('at least one before-photo');
    if (!hasSignature) outstanding.push("the customer's signature");
    if (!termsAccepted) outstanding.push("the customer's acceptance of terms");

    return {
      job_id: jobId,
      ready: outstanding.length === 0,
      condition_captured: conditionCaptured,
      symptom_selected: symptomSelected,
      terms_accepted: termsAccepted,
      has_before_photo: hasBeforePhoto,
      has_signature: hasSignature,
      outstanding,
    };
  }

  // ------------------------------------------------------------ helpers

  /** Set `is_leaf` from whether the node currently has any live children. */
  private async recomputeLeaf(id: string): Promise<void> {
    const children = await this.prisma.symptomNode.count({
      where: { parentId: id, deletedAt: null },
    });
    await this.prisma.symptomNode.update({
      where: { id },
      data: { isLeaf: children === 0 },
    });
  }

  /** True when `candidateId` sits underneath `ancestorId` in the tree. */
  private async isDescendant(
    candidateId: string,
    ancestorId: string,
  ): Promise<boolean> {
    let cursor: string | null = candidateId;
    // Bounded walk: a tree deeper than this is a data problem, and an
    // unbounded loop over a cycle would hang the request.
    for (let depth = 0; cursor && depth < 32; depth++) {
      if (cursor === ancestorId) return true;
      const row: { parentId: string | null } | null =
        await this.prisma.symptomNode.findFirst({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = row?.parentId ?? null;
    }
    return false;
  }

  /**
   * Ancestor labels for each node, root-first. Loads the whole (small) tree
   * once and walks it in memory rather than issuing a query per ancestor per
   * result — a 20-row search would otherwise cost 60 round trips.
   */
  private async resolvePaths(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;

    const all = await this.prisma.symptomNode.findMany({
      where: { deletedAt: null },
      select: { id: true, label: true, parentId: true },
    });
    const byId = new Map(all.map((n) => [n.id, n]));

    for (const id of ids) {
      const path: string[] = [];
      let cursor = byId.get(id)?.parentId ?? null;
      for (let depth = 0; cursor && depth < 32; depth++) {
        const node = byId.get(cursor);
        if (!node) break;
        path.unshift(node.label);
        cursor = node.parentId;
      }
      out.set(id, path);
    }
    return out;
  }
}

function symptomToWire(
  n: {
    id: string;
    code: string;
    label: string;
    parentId: string | null;
    level: number;
    isLeaf: boolean;
    category: DeviceCategory | null;
    faultCodeId: string | null;
    serviceCategoryId: string | null;
    estimateAmount: bigint | null;
    estimateCurrency: string | null;
    estimateMinutes: number | null;
    sortOrder: number;
    active: boolean;
  },
  path: string[],
): SymptomNodeWire {
  return {
    id: n.id,
    code: n.code,
    label: n.label,
    parent_id: n.parentId,
    level: n.level,
    is_leaf: n.isLeaf,
    category: n.category,
    fault_code_id: n.faultCodeId,
    service_category_id: n.serviceCategoryId,
    // Money crosses the wire as a STRING: BIGINT minor units exceed the
    // precision JSON numbers guarantee.
    estimate_amount: n.estimateAmount?.toString() ?? null,
    estimate_currency: n.estimateCurrency,
    estimate_minutes: n.estimateMinutes,
    sort_order: n.sortOrder,
    active: n.active,
    path,
  };
}

function zoneToWire(z: {
  id: string;
  category: DeviceCategory;
  code: string;
  label: string;
  x: Prisma.Decimal;
  y: Prisma.Decimal;
  face: string;
  sortOrder: number;
  active: boolean;
}): ConditionZoneWire {
  return {
    id: z.id,
    category: z.category,
    code: z.code,
    label: z.label,
    // Coordinates are bounded 0–1 with 4 decimals, so a JS number is exact
    // here — unlike money, which stays a string.
    x: Number(z.x),
    y: Number(z.y),
    face: z.face,
    sort_order: z.sortOrder,
    active: z.active,
  };
}

function markToWire(m: {
  id: string;
  zoneId: string;
  damage: DamageType;
  severity: DamageSeverity;
  note: string | null;
  zone: {
    code: string;
    label: string;
    face: string;
    x: Prisma.Decimal;
    y: Prisma.Decimal;
  };
}): ConditionMarkWire {
  return {
    id: m.id,
    zone_id: m.zoneId,
    zone_code: m.zone.code,
    zone_label: m.zone.label,
    face: m.zone.face,
    x: Number(m.zone.x),
    y: Number(m.zone.y),
    damage: m.damage,
    severity: m.severity,
    note: m.note,
  };
}
