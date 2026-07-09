import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import {
  getCurrentUser,
  getRequestMeta,
} from '../../common/context/request-context';
import type { AuthUser } from '../../modules/auth/auth.types';
import { snapshotRow } from '../../prisma/audit.extension';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditLogQueryDto } from './dto/audit-log-query.dto';

/** Wire shape of one audit row (snake_case per API convention). */
export interface AuditLogEntry {
  id: string;
  company_id: string;
  branch_id: string | null;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string;
  action: AuditAction;
  before_json: unknown;
  after_json: unknown;
  at: string;
  ip: string | null;
  user_agent: string | null;
}

/** Input for the manual {@link AuditService.record} path. */
export interface AuditRecordInput {
  entityType: string;
  entityId: string;
  action: AuditAction;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Defaults to the request-context actor's company. */
  companyId?: string;
  /** Defaults to the entity's/actor's branch resolution done by the caller. */
  branchId?: string | null;
  /** Defaults to the request-context actor (null for system). */
  actorUserId?: string | null;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * Audit log service (Task 0.4, DESIGN.md §4.8).
 *
 * WRITE PATH: create/update/delete on audited models is recorded
 * AUTOMATICALLY by the audit Prisma extension (audit.extension.ts) — no
 * service calls needed. `record()` below is the manual escape hatch for
 * events the extension cannot see: workflow TRANSITIONs, LOGINs,
 * APPROVE/REJECT decisions, or mutations inside a caller-managed
 * transaction (a documented extension limitation).
 *
 * Immutability: there is no update/delete anywhere on this surface, and the
 * extension throws on any prisma.auditLog.update/delete attempt.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Append one audit row (manual path — the extension covers plain CRUD). */
  async record(input: AuditRecordInput): Promise<void> {
    const user = getCurrentUser();
    const meta = getRequestMeta();
    const companyId = input.companyId ?? user?.companyId;
    if (!companyId) {
      throw new Error(
        'AuditService.record: companyId is required outside a request context',
      );
    }

    await this.prisma.auditLog.create({
      data: {
        companyId,
        branchId: input.branchId ?? user?.homeBranchId ?? null,
        actorUserId:
          input.actorUserId !== undefined
            ? input.actorUserId
            : (user?.userId ?? null),
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        ...(input.before ? { beforeJson: snapshotRow(input.before) } : {}),
        ...(input.after ? { afterJson: snapshotRow(input.after) } : {}),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });
  }

  /** Company-scoped, filtered, paginated audit trail (newest first). */
  async list(
    query: AuditLogQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<AuditLogEntry>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const at =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;

    // companyId is set explicitly AND re-tightened by the company-scope
    // extension (defense in depth).
    const where: Prisma.AuditLogWhereInput = {
      companyId: user.companyId,
      ...(query.entity_type ? { entityType: query.entity_type } : {}),
      ...(query.entity_id ? { entityId: query.entity_id } : {}),
      ...(query.actor_user_id ? { actorUserId: query.actor_user_id } : {}),
      ...(at ? { at } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        company_id: row.companyId,
        branch_id: row.branchId,
        actor_user_id: row.actorUserId,
        entity_type: row.entityType,
        entity_id: row.entityId,
        action: row.action,
        before_json: row.beforeJson ?? null,
        after_json: row.afterJson ?? null,
        at: row.at.toISOString(),
        ip: row.ip,
        user_agent: row.userAgent,
      })),
      page,
      page_size: pageSize,
      total,
    };
  }
}
