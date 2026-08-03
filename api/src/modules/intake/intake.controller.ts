import {
  Body,
  Controller,
  Delete,
  Get,
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
import {
  AcceptTermsDto,
  ConditionZoneQueryDto,
  SaveJobConditionDto,
  SymptomNodeQueryDto,
  UpsertConditionZoneDto,
  UpsertSymptomNodeDto,
} from './dto/intake.dto';
import {
  IntakeService,
  type ConditionZoneWire,
  type IntakeReadinessWire,
  type JobConditionWire,
  type SymptomNodeWire,
} from './intake.service';

/**
 * /api/v1 — intake integrity (SCMS proposal Module 1, §2).
 *
 * Config (managers/admins):
 *   GET/POST/PATCH/DELETE /symptom-nodes     'config.read' / 'config.manage'
 *   GET/POST/PATCH/DELETE /condition-zones   'config.read' / 'config.manage'
 *
 * Counter (front desk):
 *   GET /jobs/{id}/condition                 'job.read'
 *   PUT /jobs/{id}/condition                 'job.intake.capture'
 *   POST /jobs/{id}/terms                    'job.intake.capture'
 *   GET /jobs/{id}/intake-readiness          'job.read'
 *
 * The picker endpoints are READ-gated on 'job.read' rather than 'config.read'
 * on purpose: every agent who books a job must be able to load the symptom
 * tree, and none of them holds configuration rights.
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  // ---------------------------------------------------------- symptom tree

  @Get('symptom-nodes')
  @RequirePermissions('job.read')
  listSymptomNodes(
    @Query() query: SymptomNodeQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<SymptomNodeWire>> {
    return this.intake.listSymptomNodes(query, user);
  }

  @Post('symptom-nodes')
  @RequirePermissions('config.manage')
  createSymptomNode(
    @Body() dto: UpsertSymptomNodeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SymptomNodeWire> {
    return this.intake.upsertSymptomNode(dto, user);
  }

  @Patch('symptom-nodes/:id')
  @RequirePermissions('config.manage')
  updateSymptomNode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertSymptomNodeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SymptomNodeWire> {
    return this.intake.upsertSymptomNode(dto, user, id);
  }

  @Delete('symptom-nodes/:id')
  @RequirePermissions('config.manage')
  removeSymptomNode(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ id: string }> {
    return this.intake.removeSymptomNode(id, user);
  }

  // -------------------------------------------------------- condition map

  @Get('condition-zones')
  @RequirePermissions('job.read')
  listConditionZones(
    @Query() query: ConditionZoneQueryDto,
  ): Promise<PaginatedResponse<ConditionZoneWire>> {
    return this.intake.listConditionZones(query);
  }

  @Post('condition-zones')
  @RequirePermissions('config.manage')
  createConditionZone(
    @Body() dto: UpsertConditionZoneDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConditionZoneWire> {
    return this.intake.upsertConditionZone(dto, user);
  }

  @Patch('condition-zones/:id')
  @RequirePermissions('config.manage')
  updateConditionZone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertConditionZoneDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConditionZoneWire> {
    return this.intake.upsertConditionZone(dto, user, id);
  }

  @Delete('condition-zones/:id')
  @RequirePermissions('config.manage')
  removeConditionZone(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ id: string }> {
    return this.intake.removeConditionZone(id, user);
  }

  // ------------------------------------------------------- per-job intake

  @Get('jobs/:id/condition')
  @RequirePermissions('job.read')
  getJobCondition(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobConditionWire> {
    return this.intake.getJobCondition(id, user);
  }

  @Put('jobs/:id/condition')
  @RequirePermissions('job.intake.capture')
  saveJobCondition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveJobConditionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobConditionWire> {
    return this.intake.saveJobCondition(id, dto, user);
  }

  @Post('jobs/:id/terms')
  @RequirePermissions('job.intake.capture')
  acceptTerms(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptTermsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<IntakeReadinessWire> {
    return this.intake.acceptTerms(id, dto, user);
  }

  @Get('jobs/:id/intake-readiness')
  @RequirePermissions('job.read')
  readiness(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<IntakeReadinessWire> {
    return this.intake.readiness(id, user);
  }
}
