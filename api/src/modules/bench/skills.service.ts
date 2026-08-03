import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type DeviceCategory } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { SkillListQueryDto, UpsertSkillDto } from './dto/bench.dto';

/**
 * The technician skill matrix (SCMS proposal Module 2, §3).
 *
 * "Technician profile must match device skill matrix." The matrix is what the
 * `engineer_skill_match` workflow guard consults before a job may leave the
 * counter, and what routing uses to suggest who should take a job.
 *
 * `can_qc` additionally marks the Senior Quality Assurers the proposal names
 * as the QC gate's authority — a distinct competence from being able to do
 * the repair, which is why it is a flag on the skill rather than a role.
 */

export interface SkillWire {
  id: string;
  user_id: string;
  user_name: string;
  user_role: string;
  category: DeviceCategory;
  service_category_id: string | null;
  level: number;
  can_qc: boolean;
  certified_at: string | null;
  notes: string | null;
  active: boolean;
}

/** A technician ranked as a candidate for a job (routing suggestion). */
export interface RoutingCandidate {
  user_id: string;
  user_name: string;
  level: number;
  can_qc: boolean;
  /** Jobs currently on this technician's bench (not terminal). */
  open_jobs: number;
}

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: SkillListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<SkillWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.UserSkillWhereInput = {
      deletedAt: null,
      ...(query.user_id ? { userId: query.user_id } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.can_qc !== undefined ? { canQc: query.can_qc } : {}),
      ...(query.q ? { user: { fullName: { contains: query.q } } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.userSkill.findMany({
        where,
        include: { user: { select: { fullName: true, role: true } } },
        orderBy: [{ category: 'asc' }, { level: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.userSkill.count({ where }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /**
   * Grant or update a skill. Upserted on (user, category, service category),
   * so the admin screen can PUT the same row repeatedly without checking
   * whether it already exists.
   */
  async upsert(dto: UpsertSkillDto, user: AuthUser): Promise<SkillWire> {
    const target = await this.prisma.user.findFirst({
      where: { id: dto.user_id, deletedAt: null },
      select: { id: true, fullName: true, role: true },
    });
    if (!target) {
      throw new BadRequestException('user_id does not match a user of your company');
    }

    if (dto.service_category_id) {
      const cat = await this.prisma.serviceCategory.findFirst({
        where: { id: dto.service_category_id, deletedAt: null },
        select: { id: true },
      });
      if (!cat) {
        throw new BadRequestException(
          'service_category_id does not match a service category',
        );
      }
    }

    const data = {
      level: dto.level ?? 1,
      canQc: dto.can_qc ?? false,
      certifiedAt: dto.certified_at ? new Date(dto.certified_at) : null,
      notes: dto.notes ?? null,
      active: dto.active ?? true,
      deletedAt: null,
      updatedById: user.userId,
    };

    // The unique key includes a NULLABLE column, and MySQL treats every NULL
    // as distinct — so `upsert` on that key would insert a duplicate row for
    // the company-wide (service_category_id IS NULL) case every time. Find the
    // existing row explicitly instead.
    const existing = await this.prisma.userSkill.findFirst({
      where: {
        userId: dto.user_id,
        category: dto.category,
        serviceCategoryId: dto.service_category_id ?? null,
      },
    });

    const row = existing
      ? await this.prisma.userSkill.update({
          where: { id: existing.id },
          data,
          include: { user: { select: { fullName: true, role: true } } },
        })
      : await this.prisma.userSkill.create({
          data: {
            ...data,
            id: randomUUID(),
            companyId: user.companyId,
            userId: dto.user_id,
            category: dto.category,
            serviceCategoryId: dto.service_category_id ?? null,
            createdById: user.userId,
          },
          include: { user: { select: { fullName: true, role: true } } },
        });

    return toWire(row);
  }

  /**
   * Revoke a skill (soft). Refuses when the technician still holds OPEN jobs
   * of that device class: revoking would leave live work assigned to someone
   * the system now says is not certified for it, and the next transition would
   * fail with a confusing error at the worst moment.
   */
  async remove(id: string, user: AuthUser): Promise<{ id: string }> {
    const skill = await this.prisma.userSkill.findFirst({
      where: { id, deletedAt: null },
    });
    if (!skill) throw new NotFoundException('Skill not found');

    const openJobs = await this.prisma.job.count({
      where: {
        assignedEngineerId: skill.userId,
        deletedAt: null,
        state: { isTerminal: false },
        device: { category: skill.category },
      },
    });
    if (openJobs > 0) {
      throw new ConflictException(
        `This technician still has ${openJobs} open ${skill.category} job(s). Reassign them before revoking the skill.`,
      );
    }

    await this.prisma.userSkill.update({
      where: { id },
      data: { active: false, deletedAt: new Date(), updatedById: user.userId },
    });
    return { id };
  }

  /**
   * GET /jobs/{id}/routing — who could take this job, best first.
   *
   * The proposal's "Auto-allocation algorithm or manual lead dispatch": rank
   * certified technicians by competence and then by how loaded their bench
   * already is, so dispatch is a decision made with the two facts that matter
   * rather than by memory.
   *
   * SUGGESTS; does not assign. Auto-assignment without a human in the loop
   * would need workload, shift patterns and absence data the system does not
   * have, and getting it wrong silently is worse than not doing it.
   */
  async candidatesForJob(
    jobId: string,
    user: AuthUser,
  ): Promise<RoutingCandidate[]> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, deletedAt: null },
      select: {
        branchId: true,
        serviceCategoryId: true,
        device: { select: { category: true } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');

    const skills = await this.prisma.userSkill.findMany({
      where: {
        category: job.device.category,
        active: true,
        deletedAt: null,
        // A skill narrowed to a service line only counts for that line;
        // an unnarrowed skill (NULL) covers everything in the class.
        OR: [
          { serviceCategoryId: null },
          ...(job.serviceCategoryId
            ? [{ serviceCategoryId: job.serviceCategoryId }]
            : []),
        ],
        // Only technicians who can actually be handed work at this branch.
        user: {
          active: true,
          deletedAt: null,
          OR: [{ homeBranchId: job.branchId }, { scope: 'group' }],
        },
      },
      include: { user: { select: { id: true, fullName: true } } },
    });
    if (skills.length === 0) return [];

    // One grouped count for every candidate rather than a query each.
    const loads = await this.prisma.job.groupBy({
      by: ['assignedEngineerId'],
      where: {
        assignedEngineerId: { in: skills.map((s) => s.userId) },
        deletedAt: null,
        state: { isTerminal: false },
      },
      _count: { _all: true },
    });
    const loadByUser = new Map(
      loads.map((l) => [l.assignedEngineerId ?? '', l._count._all]),
    );

    // Deduplicate: a technician may hold both a class-wide and a line-specific
    // skill for this job. Keep the higher level.
    const best = new Map<string, RoutingCandidate>();
    for (const s of skills) {
      const cur = best.get(s.userId);
      if (!cur || s.level > cur.level) {
        best.set(s.userId, {
          user_id: s.userId,
          user_name: s.user.fullName,
          level: s.level,
          can_qc: s.canQc,
          open_jobs: loadByUser.get(s.userId) ?? 0,
        });
      }
    }

    return [...best.values()].sort(
      // Most competent first; among equals, the least loaded bench.
      (a, b) => b.level - a.level || a.open_jobs - b.open_jobs,
    );
  }

  /**
   * May `userId` sign off the QC gate for `category`?
   *
   * Used by the QC endpoints on top of the `job.qc.approve` permission: the
   * permission says the ROLE may approve QC at all, this says the PERSON is
   * certified on this class of hardware. The proposal asks for a "Senior
   * Quality Assurer", which is both.
   *
   * An unpopulated matrix (no `can_qc` rows anywhere for the class) does NOT
   * block — same rule as the assignment guard: a company that has not filled
   * the table in yet must not find its QC gate welded shut.
   */
  async canApproveQc(
    userId: string,
    category: DeviceCategory,
  ): Promise<boolean> {
    const [assurers, mine] = await Promise.all([
      this.prisma.userSkill.count({
        where: { category, canQc: true, active: true, deletedAt: null },
      }),
      this.prisma.userSkill.findFirst({
        where: {
          userId,
          category,
          canQc: true,
          active: true,
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);
    if (assurers === 0) return true;
    return mine !== null;
  }
}

function toWire(s: {
  id: string;
  userId: string;
  category: DeviceCategory;
  serviceCategoryId: string | null;
  level: number;
  canQc: boolean;
  certifiedAt: Date | null;
  notes: string | null;
  active: boolean;
  user: { fullName: string; role: string };
}): SkillWire {
  return {
    id: s.id,
    user_id: s.userId,
    user_name: s.user.fullName,
    user_role: s.user.role,
    category: s.category,
    service_category_id: s.serviceCategoryId,
    level: s.level,
    can_qc: s.canQc,
    certified_at: s.certifiedAt?.toISOString().slice(0, 10) ?? null,
    notes: s.notes,
    active: s.active,
  };
}
