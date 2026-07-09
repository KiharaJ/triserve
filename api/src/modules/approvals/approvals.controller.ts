import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { ApprovalsService, type ApprovalEntry } from './approvals.service';
import {
  ApprovalListQueryDto,
  ApproveApprovalDto,
  CreateApprovalDto,
  RejectApprovalDto,
} from './dto/approvals.dto';

/**
 * /api/v1/approvals (Task 0.5, DESIGN.md §4.11 / E8 / §7).
 *
 *   GET  /approvals?status=&type=&branch_id=   'approval.request'
 *   POST /approvals                            'approval.request'
 *   POST /approvals/{id}/approve {reason?}     'approval.decide'
 *   POST /approvals/{id}/reject  {reason}      'approval.decide'
 *
 * All company-scoped to the caller (branch users additionally pinned to
 * their home branch by the Prisma scope extension). Decisions are audited
 * with action APPROVE/REJECT. Later domain modules do NOT go through HTTP —
 * they call ApprovalsService.request()/isRequired() directly.
 */
@Controller('approvals')
@UseGuards(AuthGuard, PermissionsGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermissions('approval.request')
  list(
    @Query() query: ApprovalListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<ApprovalEntry>> {
    return this.approvals.list(query, user);
  }

  @Post()
  @RequirePermissions('approval.request')
  create(@Body() dto: CreateApprovalDto): Promise<ApprovalEntry> {
    return this.approvals.request(dto.type, {
      branchId: dto.branch_id,
      refType: dto.ref_type ?? null,
      refId: dto.ref_id ?? null,
      payload: dto.payload,
      reason: dto.reason,
    });
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('approval.decide')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveApprovalDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ApprovalEntry> {
    return this.approvals.decide(id, 'APPROVED', user, dto.reason);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('approval.decide')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectApprovalDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ApprovalEntry> {
    return this.approvals.decide(id, 'REJECTED', user, dto.reason);
  }
}
