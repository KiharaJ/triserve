import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import {
  Prisma,
  type NotificationChannel,
  type NotificationStatus,
  type PreferredLanguage,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  NotificationListQueryDto,
  TemplateListQueryDto,
  UpsertTemplateDto,
} from './dto/notification.dto';
import { NotificationWorkerService } from './notification-worker.service';

/** One row of the comms log / outbox. */
export interface NotificationWire {
  id: string;
  event_code: string;
  channel: NotificationChannel;
  language: PreferredLanguage;
  to_address: string;
  subject: string | null;
  body: string;
  status: NotificationStatus;
  attempts: number;
  available_at: string;
  sent_at: string | null;
  provider_ref: string | null;
  last_error: string | null;
  customer_id: string | null;
  job_id: string | null;
  created_at: string;
}

export interface TemplateWire {
  id: string;
  event_code: string;
  channel: NotificationChannel;
  language: PreferredLanguage;
  subject: string | null;
  body: string;
  active: boolean;
  updated_at: string;
}

const DEFAULT_PAGE_SIZE = 25;

/**
 * /api/v1/notifications + /api/v1/notification-templates
 * (SCMS proposal Module 7; DESIGN.md §4.13/E6, §7).
 *
 *   GET  /notifications                 'notification.read'   outbox + comms log
 *   POST /notifications/drain           'notification.manage' force a send pass
 *   GET  /notification-templates        'notification.read'
 *   PUT  /notification-templates        'notification.manage' upsert one
 *   DELETE /notification-templates/{id} 'notification.manage' deactivate
 *
 * There is deliberately NO endpoint to compose an arbitrary message. Messages
 * come from EVENTS the system raises against a company's templates; a free
 * "send SMS to this number" route would be an open relay attached to the
 * centre's sender id.
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: NotificationWorkerService,
  ) {}

  @Get('notifications')
  @RequirePermissions('notification.read')
  async list(
    @Query() query: NotificationListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<NotificationWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.NotificationWhereInput = {
      ...(query.customer_id ? { customerId: query.customer_id } : {}),
      ...(query.job_id ? { jobId: query.job_id } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.event_code ? { eventCode: query.event_code } : {}),
      // Two independent OR groups (free-text search, and branch visibility)
      // must both hold, so they go in an AND array rather than sharing one
      // `OR` key — a second `OR` would silently replace the first.
      AND: [
        ...(query.q
          ? [
              {
                OR: [
                  { body: { contains: query.q } },
                  { toAddress: { contains: query.q } },
                ],
              },
            ]
          : []),
        // A branch-scoped user sees their branch's traffic plus company-level
        // rows (branch_id NULL) — the same OR-null rule attachments use, and
        // for the same reason: an equality filter would hide the company-level
        // ones instead of including them.
        ...(user.scope === 'branch' && user.homeBranchId
          ? [{ OR: [{ branchId: null }, { branchId: user.homeBranchId }] }]
          : []),
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      data: rows.map(notificationToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  /**
   * Force an immediate drain pass instead of waiting for the poll interval.
   * Useful when a gateway outage has just been fixed and a manager wants the
   * backlog cleared now rather than in fifteen seconds.
   */
  @Post('notifications/drain')
  @RequirePermissions('notification.manage')
  @HttpCode(HttpStatus.OK)
  drain(): Promise<{ claimed: number; sent: number; failed: number }> {
    return this.worker.drain();
  }

  /**
   * Re-queue a FAILED message. Attempts reset to zero: a human has looked at
   * `last_error` and decided the cause is fixed, which is a different
   * situation from an automatic retry.
   */
  @Post('notifications/:id/retry')
  @RequirePermissions('notification.manage')
  @HttpCode(HttpStatus.OK)
  async retry(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NotificationWire> {
    const row = await this.prisma.notification.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Notification not found');
    const updated = await this.prisma.notification.update({
      where: { id },
      data: {
        status: 'QUEUED',
        attempts: 0,
        availableAt: new Date(),
        leasedUntil: null,
        lastError: null,
      },
    });
    return notificationToWire(updated);
  }

  @Get('notification-templates')
  @RequirePermissions('notification.read')
  async listTemplates(
    @Query() query: TemplateListQueryDto,
  ): Promise<PaginatedResponse<TemplateWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 100;
    const where: Prisma.NotificationTemplateWhereInput = {
      deletedAt: null,
      ...(query.event_code ? { eventCode: query.event_code } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.q
        ? {
            OR: [
              { eventCode: { contains: query.q } },
              { body: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notificationTemplate.findMany({
        where,
        orderBy: [{ eventCode: 'asc' }, { channel: 'asc' }, { language: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notificationTemplate.count({ where }),
    ]);

    return {
      data: rows.map(templateToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  /** Upsert by the natural key (event, channel, language). */
  @Put('notification-templates')
  @RequirePermissions('notification.manage')
  async upsertTemplate(
    @Body() dto: UpsertTemplateDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TemplateWire> {
    const language = dto.language ?? 'EN';
    const row = await this.prisma.notificationTemplate.upsert({
      where: {
        companyId_eventCode_channel_language: {
          companyId: user.companyId,
          eventCode: dto.event_code,
          channel: dto.channel,
          language,
        },
      },
      update: {
        subject: dto.subject ?? null,
        body: dto.body,
        active: true,
        deletedAt: null,
        updatedById: user.userId,
      },
      create: {
        id: randomUUID(),
        companyId: user.companyId,
        eventCode: dto.event_code,
        channel: dto.channel,
        language,
        subject: dto.subject ?? null,
        body: dto.body,
        createdById: user.userId,
        updatedById: user.userId,
      },
    });
    return templateToWire(row);
  }

  /**
   * Deactivate a template. SOFT: already-sent notifications keep their
   * rendered body (the comms log must stay truthful), and a company that
   * removes a template simply stops sending that event on that channel.
   */
  @Delete('notification-templates/:id')
  @RequirePermissions('notification.manage')
  async removeTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ id: string; active: false }> {
    const row = await this.prisma.notificationTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Template not found');
    await this.prisma.notificationTemplate.update({
      where: { id },
      data: { active: false, deletedAt: new Date(), updatedById: user.userId },
    });
    return { id, active: false };
  }
}

function notificationToWire(n: {
  id: string;
  eventCode: string;
  channel: NotificationChannel;
  language: PreferredLanguage;
  toAddress: string;
  subject: string | null;
  body: string;
  status: NotificationStatus;
  attempts: number;
  availableAt: Date;
  sentAt: Date | null;
  providerRef: string | null;
  lastError: string | null;
  customerId: string | null;
  jobId: string | null;
  createdAt: Date;
}): NotificationWire {
  return {
    id: n.id,
    event_code: n.eventCode,
    channel: n.channel,
    language: n.language,
    to_address: n.toAddress,
    subject: n.subject,
    body: n.body,
    status: n.status,
    attempts: n.attempts,
    available_at: n.availableAt.toISOString(),
    sent_at: n.sentAt?.toISOString() ?? null,
    provider_ref: n.providerRef,
    last_error: n.lastError,
    customer_id: n.customerId,
    job_id: n.jobId,
    created_at: n.createdAt.toISOString(),
  };
}

function templateToWire(t: {
  id: string;
  eventCode: string;
  channel: NotificationChannel;
  language: PreferredLanguage;
  subject: string | null;
  body: string;
  active: boolean;
  updatedAt: Date;
}): TemplateWire {
  return {
    id: t.id,
    event_code: t.eventCode,
    channel: t.channel,
    language: t.language,
    subject: t.subject,
    body: t.body,
    active: t.active,
    updated_at: t.updatedAt.toISOString(),
  };
}
