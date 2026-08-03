import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import type { TransitionResult } from '../jobs/jobs.service';
import {
  DeclareWorkDto,
  QcItemListQueryDto,
  QcRejectDto,
  SaveQcChecksDto,
  SkillListQueryDto,
  UpsertQcItemDto,
  UpsertSkillDto,
} from './dto/bench.dto';
import {
  QcService,
  type JobQcWire,
  type QcItemWire,
} from './qc.service';
import {
  SkillsService,
  type RoutingCandidate,
  type SkillWire,
} from './skills.service';

/**
 * /api/v1 — the bench: skills, routing and quality control
 * (SCMS proposal Module 2, §3).
 *
 *   GET/PUT/DELETE /skills                 'user.read' / 'user.manage'
 *   GET  /jobs/{id}/routing                'job.assign'   who should take it
 *   GET/POST/PATCH/DELETE /qc-checklist    'config.read' / 'config.manage'
 *   GET  /jobs/{id}/qc                     'job.read'
 *   PATCH /jobs/{id}/work                  'job.update'   hours + notes
 *   PUT  /jobs/{id}/qc-checks              'job.qc.record'
 *   POST /jobs/{id}/qc-approve             'job.qc.approve'
 *   POST /jobs/{id}/qc-reject              'job.qc.approve'
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class BenchController {
  constructor(
    private readonly skills: SkillsService,
    private readonly qc: QcService,
  ) {}

  // -------------------------------------------------------------- skills

  @Get('skills')
  @RequirePermissions('user.read')
  listSkills(
    @Query() query: SkillListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<SkillWire>> {
    return this.skills.list(query, user);
  }

  @Put('skills')
  @RequirePermissions('user.manage')
  upsertSkill(
    @Body() dto: UpsertSkillDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SkillWire> {
    return this.skills.upsert(dto, user);
  }

  @Delete('skills/:id')
  @RequirePermissions('user.manage')
  removeSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ id: string }> {
    return this.skills.remove(id, user);
  }

  @Get('jobs/:id/routing')
  @RequirePermissions('job.assign')
  routing(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<RoutingCandidate[]> {
    return this.skills.candidatesForJob(id, user);
  }

  // ------------------------------------------------------- QC template

  @Get('qc-checklist')
  @RequirePermissions('job.read')
  listQcItems(
    @Query() query: QcItemListQueryDto,
  ): Promise<PaginatedResponse<QcItemWire>> {
    return this.qc.listItems(query);
  }

  @Post('qc-checklist')
  @RequirePermissions('config.manage')
  createQcItem(
    @Body() dto: UpsertQcItemDto,
    @CurrentUser() user: AuthUser,
  ): Promise<QcItemWire> {
    return this.qc.upsertItem(dto, user);
  }

  @Patch('qc-checklist/:id')
  @RequirePermissions('config.manage')
  updateQcItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertQcItemDto,
    @CurrentUser() user: AuthUser,
  ): Promise<QcItemWire> {
    return this.qc.upsertItem(dto, user, id);
  }

  @Delete('qc-checklist/:id')
  @RequirePermissions('config.manage')
  removeQcItem(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ id: string }> {
    return this.qc.removeItem(id, user);
  }

  // ------------------------------------------------------------ per job

  @Get('jobs/:id/qc')
  @RequirePermissions('job.read')
  qcPanel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobQcWire> {
    return this.qc.panel(id, user);
  }

  @Patch('jobs/:id/work')
  @RequirePermissions('job.update')
  declareWork(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclareWorkDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ labour_hours: string; tech_report: string }> {
    return this.qc.declareWork(id, dto, user);
  }

  @Put('jobs/:id/qc-checks')
  @RequirePermissions('job.qc.record')
  saveChecks(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveQcChecksDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobQcWire> {
    return this.qc.saveChecks(id, dto, user);
  }

  @Post('jobs/:id/qc-approve')
  @RequirePermissions('job.qc.approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TransitionResult> {
    return this.qc.approve(id, user);
  }

  @Post('jobs/:id/qc-reject')
  @RequirePermissions('job.qc.approve')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QcRejectDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TransitionResult> {
    return this.qc.reject(id, dto, user);
  }
}
