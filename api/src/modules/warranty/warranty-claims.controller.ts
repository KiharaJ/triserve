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
  CreateWarrantyClaimDto,
  UpdateWarrantyClaimDto,
  WarrantyClaimListQueryDto,
} from './dto/warranty-claim.dto';
import {
  WarrantyClaimsService,
  type WarrantyClaimWire,
} from './warranty-claims.service';

/**
 * /api/v1/warranty-claims (Task 4.1, DESIGN.md §4.7) — the IW (warranty) side.
 *
 *   GET   /warranty-claims?status=&labour_code=&branch_id=&job_id=&q=  'warranty.claim.read'
 *   GET   /warranty-claims/{id}                                       'warranty.claim.read'
 *   POST  /warranty-claims                                            'warranty.claim.create'
 *   PATCH /warranty-claims/{id}                          (DRAFT)      'warranty.claim.create'
 *
 * Company- AND branch-scoped. Submit/reconcile + AR–Samsung postings arrive in
 * Task 4.2 ('warranty.claim.submit' / '.reconcile').
 */
@Controller('warranty-claims')
@UseGuards(AuthGuard, PermissionsGuard)
export class WarrantyClaimsController {
  constructor(private readonly claims: WarrantyClaimsService) {}

  @Get()
  @RequirePermissions('warranty.claim.read')
  list(
    @Query() query: WarrantyClaimListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<WarrantyClaimWire>> {
    return this.claims.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('warranty.claim.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<WarrantyClaimWire> {
    return this.claims.get(id, user);
  }

  @Post()
  @RequirePermissions('warranty.claim.create')
  create(
    @Body() dto: CreateWarrantyClaimDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WarrantyClaimWire> {
    return this.claims.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('warranty.claim.create')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarrantyClaimDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WarrantyClaimWire> {
    return this.claims.update(id, dto, user);
  }
}
