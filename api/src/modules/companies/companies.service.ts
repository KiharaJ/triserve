import { Injectable, NotFoundException } from '@nestjs/common';
import type { Company } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { UpdateCompanyDto } from './dto/company.dto';

/** Wire shape of the company profile (snake_case per API convention). */
export interface CompanyWire {
  id: string;
  name: string;
  legal_name: string | null;
  tin: string | null;
  vrn: string | null;
  base_currency: string;
  logo_url: string | null;
  address: string | null;
  phone: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Company profile (Task 0.7, DESIGN.md §4.1). Single-row-per-tenant: every
 * read/write targets the CALLER's company (the company-scope extension pins
 * Company queries to `id = user.companyId` as defense in depth). Updates
 * are audited automatically (Company ∈ AUDITED_MODELS).
 */
@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /company — the caller's company profile. */
  async get(user: AuthUser): Promise<CompanyWire> {
    const company = await this.prisma.company.findFirst({
      where: { id: user.companyId, deletedAt: null },
    });
    if (!company) throw new NotFoundException('Company not found');
    return toWire(company);
  }

  /** PATCH /company — update the caller's company profile. */
  async update(user: AuthUser, dto: UpdateCompanyDto): Promise<CompanyWire> {
    // Existence check first for a clean 404 (extension re-scopes anyway).
    await this.get(user);

    const company = await this.prisma.company.update({
      where: { id: user.companyId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.legal_name !== undefined ? { legalName: dto.legal_name } : {}),
        ...(dto.tin !== undefined ? { tin: dto.tin } : {}),
        ...(dto.vrn !== undefined ? { vrn: dto.vrn } : {}),
        ...(dto.logo_url !== undefined ? { logoUrl: dto.logo_url } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        updatedById: user.userId,
      },
    });
    return toWire(company);
  }
}

function toWire(c: Company): CompanyWire {
  return {
    id: c.id,
    name: c.name,
    legal_name: c.legalName,
    tin: c.tin,
    vrn: c.vrn,
    base_currency: c.baseCurrency,
    logo_url: c.logoUrl,
    address: c.address,
    phone: c.phone,
    active: c.active,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}
