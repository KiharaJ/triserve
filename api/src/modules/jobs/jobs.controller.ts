import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  CreateJobDto,
  DispatchJobDto,
  JobListQueryDto,
  TransitionJobDto,
  UpdateJobDto,
} from './dto/job.dto';
import {
  JobsService,
  type JobDetailWire,
  type JobWire,
  type TransitionResult,
} from './jobs.service';

/**
 * /api/v1/jobs (Task 1.3, DESIGN.md §4.3 / §5).
 *
 *   GET   /jobs?branch_id=&state=&assigned_engineer_id=&warranty_status=&q=&from=&to=&page=
 *                                                       'job.read'
 *   GET   /jobs/{id}                                    'job.read'
 *   POST  /jobs                                         'job.create'
 *   PATCH /jobs/{id}                                    'job.update'
 *   POST  /jobs/{id}/transition {to_state_code, note}   'job.transition' (+ edge perm)
 *   POST  /jobs/{id}/dispatch   {received_by, waybill_no} 'job.transition.dispatch'
 *
 * Company + branch scoped; TECHNICIANs see only jobs assigned to them.
 * Status changes ONLY via /transition (and its /dispatch wrapper): the
 * endpoint guard enforces the broad job.transition permission and
 * WorkflowService enforces the specific edge's required_permission.
 * No DELETE: jobs are lifecycle/audit anchors (soft-delete arrives later).
 */
@Controller('jobs')
@UseGuards(AuthGuard, PermissionsGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @RequirePermissions('job.read')
  list(
    @Query() query: JobListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<JobWire>> {
    return this.jobs.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('job.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobDetailWire> {
    return this.jobs.get(id, user);
  }

  @Post()
  @RequirePermissions('job.create')
  create(
    @Body() dto: CreateJobDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobDetailWire> {
    return this.jobs.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('job.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobDetailWire> {
    return this.jobs.update(id, dto, user);
  }

  @Post(':id/transition')
  @RequirePermissions('job.transition')
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionJobDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TransitionResult> {
    return this.jobs.transition(id, dto, user);
  }

  @Post(':id/dispatch')
  @RequirePermissions('job.transition.dispatch')
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchJobDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TransitionResult> {
    return this.jobs.dispatch(id, dto, user);
  }
}
