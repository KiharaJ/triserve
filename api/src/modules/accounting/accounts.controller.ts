import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  ChartOfAccountsService,
  type AccountWire,
} from './chart-of-accounts.service';
import { AccountListQueryDto } from './dto/accounting.dto';

/**
 * /api/v1/accounts (Task 0.6, DESIGN.md §4.9 / E1).
 *
 *   GET /accounts?type=&is_active=&page=&page_size=   'accounting.read'
 *
 * Company-scoped chart of accounts, ordered by code. Read-only in Phase 0.
 */
@Controller('accounts')
@UseGuards(AuthGuard, PermissionsGuard)
export class AccountsController {
  constructor(private readonly accounts: ChartOfAccountsService) {}

  @Get()
  @RequirePermissions('accounting.read')
  list(
    @Query() query: AccountListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<AccountWire>> {
    return this.accounts.list(query, user);
  }
}
