import { Injectable } from '@nestjs/common';
import type { AccountType, ChartOfAccount, Prisma } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { AccountListQueryDto } from './dto/accounting.dto';

/** Wire shape of one ledger account (snake_case per API convention). */
export interface AccountWire {
  id: string;
  company_id: string;
  code: string;
  name: string;
  type: AccountType;
  is_active: boolean;
}

const DEFAULT_PAGE_SIZE = 100; // a chart is small — show it whole by default

/**
 * Chart of accounts — READ ONLY for Task 0.6 (§4.9/E1). Account management
 * (create/deactivate) arrives with the config UI (E17); the starter chart
 * is seeded per company.
 */
@Injectable()
export class ChartOfAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Company-scoped, filtered, paginated accounts ordered by code. */
  async list(
    query: AccountListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<AccountWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    // companyId explicit AND re-tightened by the company-scope extension.
    const where: Prisma.ChartOfAccountWhereInput = {
      companyId: user.companyId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.is_active !== undefined ? { isActive: query.is_active } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.chartOfAccount.count({ where }),
      this.prisma.chartOfAccount.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }
}

function toWire(a: ChartOfAccount): AccountWire {
  return {
    id: a.id,
    company_id: a.companyId,
    code: a.code,
    name: a.name,
    type: a.type,
    is_active: a.isActive,
  };
}
