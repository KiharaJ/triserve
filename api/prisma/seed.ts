/**
 * TriServe seed — Task 0.1 (core org + config).
 *
 * Idempotent: safe to run any number of times. Upserts by natural keys:
 *   - company by name (findFirst + create/update — name has no unique index)
 *   - branch by (company_id, code)
 *   - user by email
 *   - payment_method by (company_id, code)
 *   - approval_rule by (company_id, type)          (Task 0.5, §4.11/E8)
 *
 * Run with: npx prisma db seed   (wired via package.json "prisma.seed")
 */
import { Prisma, PrismaClient, type ApprovalType } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const COMPANY_NAME = 'Samsung ASC Group';

const BRANCHES: Array<{ code: string; name: string; isHq: boolean; tzRegion: string }> = [
  { code: 'DAR', name: 'Dar es Salaam ASC', isHq: true, tzRegion: 'Dar es Salaam' },
  { code: 'KRK', name: 'Kariakoo ASC', isHq: false, tzRegion: 'Dar es Salaam' },
  { code: 'ARU', name: 'Arusha ASC', isHq: false, tzRegion: 'Arusha' },
  { code: 'MLM', name: 'Moshi (Kilimanjaro) ASC', isHq: false, tzRegion: 'Kilimanjaro' },
  { code: 'DOD', name: 'Dodoma ASC', isHq: false, tzRegion: 'Dodoma' },
];

const PAYMENT_METHODS: Array<{ code: string; label: string }> = [
  { code: 'CASH', label: 'Cash' },
  { code: 'MPESA', label: 'M-Pesa' },
  { code: 'TIGOPESA', label: 'Tigo Pesa' },
  { code: 'AIRTEL', label: 'Airtel Money' },
  { code: 'CARD', label: 'Card' },
  { code: 'BANK', label: 'Bank Transfer' },
];

/**
 * Example approval thresholds (Task 0.5, §4.11/E8). Amounts are BIGINT
 * minor units (senti) of the company base currency — TZS 100,000 = 10,000,000.
 */
const APPROVAL_RULES: Array<{
  type: ApprovalType;
  thresholdAmount: bigint | null;
  thresholdPercent: Prisma.Decimal | null;
  note: string;
}> = [
  {
    type: 'REFUND',
    thresholdAmount: 100_000n * 100n, // TZS 100,000 in senti
    thresholdPercent: null,
    note: 'refunds of TZS 100,000 or more require approval',
  },
  {
    type: 'PRICE_OVERRIDE',
    thresholdAmount: null,
    thresholdPercent: new Prisma.Decimal(10),
    note: 'price overrides of 10% or more require approval',
  },
];

async function main(): Promise<void> {
  // --- Company (upsert by name) ---------------------------------------------
  const existingCompany = await prisma.company.findFirst({
    where: { name: COMPANY_NAME },
  });
  const company = existingCompany
    ? await prisma.company.update({
        where: { id: existingCompany.id },
        data: { baseCurrency: 'TZS', active: true },
      })
    : await prisma.company.create({
        data: {
          id: randomUUID(),
          name: COMPANY_NAME,
          legalName: 'Samsung ASC Group Ltd',
          baseCurrency: 'TZS',
        },
      });
  console.log(`company:        ${company.name} (${company.id})`);

  // --- Branches (upsert by company_id + code) -------------------------------
  for (const b of BRANCHES) {
    const branch = await prisma.branch.upsert({
      where: { companyId_code: { companyId: company.id, code: b.code } },
      update: { name: b.name, isHq: b.isHq, tzRegion: b.tzRegion, active: true },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: b.code,
        name: b.name,
        isHq: b.isHq,
        tzRegion: b.tzRegion,
      },
    });
    console.log(`branch:         ${branch.code} — ${branch.name}${branch.isHq ? ' [HQ]' : ''}`);
  }

  // --- Super admin (upsert by email) -----------------------------------------
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@triserve.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      role: 'SUPER_ADMIN',
      scope: 'group',
      active: true,
    },
    create: {
      id: randomUUID(),
      companyId: company.id,
      fullName: 'System Administrator',
      email: adminEmail,
      passwordHash,
      role: 'SUPER_ADMIN',
      scope: 'group',
    },
  });
  console.log(`super admin:    ${admin.email} (role=${admin.role}, scope=${admin.scope})`);

  // --- Payment methods (upsert by company_id + code) --------------------------
  for (const pm of PAYMENT_METHODS) {
    const row = await prisma.paymentMethod.upsert({
      where: { companyId_code: { companyId: company.id, code: pm.code } },
      update: { label: pm.label, active: true },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: pm.code,
        label: pm.label,
      },
    });
    console.log(`payment method: ${row.code} — ${row.label}`);
  }

  // --- Approval rules (upsert by company_id + type, Task 0.5) ----------------
  for (const r of APPROVAL_RULES) {
    const rule = await prisma.approvalRule.upsert({
      where: { companyId_type: { companyId: company.id, type: r.type } },
      update: {
        thresholdAmount: r.thresholdAmount,
        thresholdPercent: r.thresholdPercent,
        enabled: true,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        type: r.type,
        thresholdAmount: r.thresholdAmount,
        thresholdPercent: r.thresholdPercent,
      },
    });
    console.log(`approval rule:  ${rule.type} — ${r.note}`);
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
