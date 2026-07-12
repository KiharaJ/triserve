import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { IsString, MaxLength } from 'class-validator';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  CreateWarrantyClaimDto,
  ReconcileWarrantyClaimDto,
  SubmitWarrantyClaimDto,
  UpdateWarrantyClaimDto,
  WarrantyClaimListQueryDto,
} from './dto/warranty-claim.dto';
import {
  GspnBridgeService,
  type GspnImportReport,
} from './gspn-bridge.service';
import {
  WarrantyClaimsService,
  type WarrantyClaimWire,
} from './warranty-claims.service';

class GspnImportDto {
  @IsString()
  @MaxLength(5_000_000)
  csv!: string;
}

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
  constructor(
    private readonly claims: WarrantyClaimsService,
    private readonly gspn: GspnBridgeService,
  ) {}

  /** GSPN bridge (E13): download claims as a CSV to file with Samsung. */
  @Get('export')
  @RequirePermissions('warranty.claim.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="gspn-claims.csv"')
  export(
    @Query('status') status: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<string> {
    return this.gspn.exportCsv(status, user);
  }

  /** GSPN bridge (E13): apply Samsung's reconciliation CSV to the claims. */
  @Post('import')
  @RequirePermissions('warranty.claim.reconcile')
  import(
    @Body() dto: GspnImportDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GspnImportReport> {
    return this.gspn.importReconciliations(dto.csv ?? '', user);
  }

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

  @Post(':id/submit')
  @RequirePermissions('warranty.claim.submit')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitWarrantyClaimDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WarrantyClaimWire> {
    return this.claims.submit(id, dto, user);
  }

  @Post(':id/reconcile')
  @RequirePermissions('warranty.claim.reconcile')
  reconcile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReconcileWarrantyClaimDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WarrantyClaimWire> {
    return this.claims.reconcile(id, dto, user);
  }
}
