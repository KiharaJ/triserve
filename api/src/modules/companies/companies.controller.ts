import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CompaniesService, type CompanyWire } from './companies.service';
import { UpdateCompanyDto } from './dto/company.dto';

/**
 * /api/v1/company (Task 0.7, DESIGN.md §4.1) — the CALLER's company
 * profile. Singular resource on purpose: a tenant only ever sees itself
 * (multi-company listing is not a Phase 0 concern).
 *
 *   GET   /company    'config.read'
 *   PATCH /company    'config.manage'   (SUPER_ADMIN only by default)
 */
@Controller('company')
@UseGuards(AuthGuard, PermissionsGuard)
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  @RequirePermissions('config.read')
  get(@CurrentUser() user: AuthUser): Promise<CompanyWire> {
    return this.companies.get(user);
  }

  @Patch()
  @RequirePermissions('config.manage')
  update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateCompanyDto,
  ): Promise<CompanyWire> {
    return this.companies.update(user, dto);
  }
}
