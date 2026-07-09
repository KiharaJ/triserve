import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  CreateWorkflowStateDto,
  CreateWorkflowTransitionDto,
  WorkflowStateListQueryDto,
  WorkflowTransitionListQueryDto,
} from './dto/workflow.dto';
import {
  WorkflowService,
  type WorkflowGraphWire,
  type WorkflowStateWire,
  type WorkflowTransitionWire,
} from './workflow.service';

/**
 * /api/v1/workflow (Task 1.2, DESIGN.md §4.10/E7) — workflow engine config.
 *
 *   GET  /workflow/states       any authenticated user
 *   POST /workflow/states       'config.manage' (admin)
 *   GET  /workflow/transitions  any authenticated user
 *   POST /workflow/transitions  'config.manage' (admin)
 *   GET  /workflow/graph        any authenticated user
 *
 * GETs are deliberately NOT permission-gated (beyond auth): every role must
 * read the graph to render the Kanban board and its legal moves. Mutations
 * reshape the company's state machine — 'config.manage' (SUPER_ADMIN under
 * the default matrix), same gate as the other §4.14 config tables.
 */
@Controller('workflow')
@UseGuards(AuthGuard, PermissionsGuard)
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Get('states')
  listStates(
    @Query() query: WorkflowStateListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<WorkflowStateWire>> {
    return this.workflow.listStates(query, user);
  }

  @Post('states')
  @RequirePermissions('config.manage')
  createState(
    @Body() dto: CreateWorkflowStateDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WorkflowStateWire> {
    return this.workflow.createState(dto, user);
  }

  @Get('transitions')
  listTransitions(
    @Query() query: WorkflowTransitionListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<WorkflowTransitionWire>> {
    return this.workflow.listTransitions(query, user);
  }

  @Post('transitions')
  @RequirePermissions('config.manage')
  createTransition(
    @Body() dto: CreateWorkflowTransitionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WorkflowTransitionWire> {
    return this.workflow.createTransition(dto, user);
  }

  /** The whole board in one call: Kanban columns + legal moves. */
  @Get('graph')
  graph(@CurrentUser() user: AuthUser): Promise<WorkflowGraphWire> {
    return this.workflow.graph(user);
  }
}
