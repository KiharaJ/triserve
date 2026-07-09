/**
 * TriServe seed — Task 0.1 (core org + config).
 *
 * Idempotent: safe to run any number of times. Upserts by natural keys:
 *   - company by name (findFirst + create/update — name has no unique index)
 *   - branch by (company_id, code)
 *   - user by email
 *   - payment_method by (company_id, code)
 *   - approval_rule by (company_id, type)          (Task 0.5, §4.11/E8)
 *   - chart_of_accounts by (company_id, code)      (Task 0.6, §4.9/E1)
 *   - workflow_state by (company_id, code)         (Task 1.2, §4.10/E7)
 *   - workflow_transition by (company_id, from_state_id, to_state_id)
 *
 * Run with: npx prisma db seed   (wired via package.json "prisma.seed")
 */
import {
  Prisma,
  PrismaClient,
  type AccountType,
  type ApprovalType,
} from '@prisma/client';
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

/**
 * Starter chart of accounts (Task 0.6, DESIGN.md §4.9/E1). Types follow the
 * code ranges: 1xxx ASSET, 2xxx LIABILITY, 3xxx EQUITY, 4xxx REVENUE,
 * 5xxx EXPENSE. Intentional seed data — companies extend it later (E17).
 */
const CHART_OF_ACCOUNTS: Array<{
  code: string;
  name: string;
  type: AccountType;
}> = [
  { code: '1000', name: 'Cash', type: 'ASSET' },
  { code: '1010', name: 'Bank', type: 'ASSET' },
  { code: '1200', name: 'AR–Samsung', type: 'ASSET' },
  { code: '1300', name: 'Inventory', type: 'ASSET' },
  { code: '2000', name: 'AP–Suppliers', type: 'LIABILITY' },
  { code: '2100', name: 'VAT Payable', type: 'LIABILITY' },
  { code: '3000', name: "Owner's Equity", type: 'EQUITY' },
  { code: '4000', name: 'Repair Revenue', type: 'REVENUE' },
  { code: '4010', name: 'Warranty Revenue', type: 'REVENUE' },
  { code: '5000', name: 'COGS', type: 'EXPENSE' },
];

/**
 * DEFAULT workflow (Task 1.2, DESIGN.md §4.10/§5/E7) — the §5 job lifecycle
 * as seeded data. Companies reshape it later via /workflow/* admin endpoints.
 */
const WORKFLOW_STATES: Array<{
  code: string;
  label: string;
  isInitial?: boolean;
  isTerminal?: boolean;
  sortOrder: number;
}> = [
  { code: 'RECEIVED', label: 'Received', isInitial: true, sortOrder: 10 },
  { code: 'DIAGNOSING', label: 'Diagnosing', sortOrder: 20 },
  { code: 'AWAITING_CUSTOMER_APPROVAL', label: 'Awaiting Customer Approval', sortOrder: 30 },
  { code: 'AWAITING_PARTS', label: 'Awaiting Parts', sortOrder: 40 },
  { code: 'IN_REPAIR', label: 'In Repair', sortOrder: 50 },
  { code: 'QC', label: 'Quality Check', sortOrder: 60 },
  { code: 'READY', label: 'Ready for Collection', sortOrder: 70 },
  { code: 'DISPATCHED', label: 'Dispatched', sortOrder: 80 },
  { code: 'CLOSED', label: 'Closed', isTerminal: true, sortOrder: 90 },
  { code: 'CANCELLED', label: 'Cancelled', isTerminal: true, sortOrder: 100 },
  { code: 'RETURNED_UNREPAIRED', label: 'Returned Unrepaired', isTerminal: true, sortOrder: 110 },
];

/**
 * Default transition edges + permission mapping:
 *   - 'job.transition'          front-desk/general moves (intake, diagnosis
 *                               routing, cancellations) — every job role.
 *   - 'job.transition.repair'   bench moves (→IN_REPAIR, →QC, QC→READY) —
 *                               TECHNICIAN + BRANCH_MANAGER (+SUPER_ADMIN).
 *   - 'job.transition.dispatch' handover moves (READY→DISPATCHED,
 *                               DISPATCHED→CLOSED) — SERVICE_ADVISOR +
 *                               BRANCH_MANAGER (+SUPER_ADMIN); technicians
 *                               deliberately cannot dispatch.
 *
 * AWAITING_CUSTOMER_APPROVAL→IN_REPAIR carries guard_code
 * 'ow_quote_approved' — a stub (always true) until POS lands (Phase 3);
 * requires_approval stays false for now (OW-quote gating comes with POS).
 */
const WORKFLOW_TRANSITIONS: Array<{
  from: string;
  to: string;
  requiredPermission: string | null;
  requiresApproval?: boolean;
  guardCode?: string | null;
}> = [
  { from: 'RECEIVED', to: 'DIAGNOSING', requiredPermission: 'job.transition' },
  { from: 'RECEIVED', to: 'CANCELLED', requiredPermission: 'job.transition' },
  { from: 'DIAGNOSING', to: 'AWAITING_CUSTOMER_APPROVAL', requiredPermission: 'job.transition' },
  { from: 'DIAGNOSING', to: 'AWAITING_PARTS', requiredPermission: 'job.transition' },
  { from: 'DIAGNOSING', to: 'RETURNED_UNREPAIRED', requiredPermission: 'job.transition' },
  { from: 'DIAGNOSING', to: 'CANCELLED', requiredPermission: 'job.transition' },
  {
    from: 'AWAITING_CUSTOMER_APPROVAL',
    to: 'IN_REPAIR',
    requiredPermission: 'job.transition.repair',
    requiresApproval: false, // OW-quote approval gating arrives with POS
    guardCode: 'ow_quote_approved',
  },
  { from: 'AWAITING_CUSTOMER_APPROVAL', to: 'AWAITING_PARTS', requiredPermission: 'job.transition' },
  { from: 'AWAITING_CUSTOMER_APPROVAL', to: 'CANCELLED', requiredPermission: 'job.transition' },
  { from: 'AWAITING_CUSTOMER_APPROVAL', to: 'RETURNED_UNREPAIRED', requiredPermission: 'job.transition' },
  { from: 'AWAITING_PARTS', to: 'IN_REPAIR', requiredPermission: 'job.transition.repair' },
  { from: 'IN_REPAIR', to: 'QC', requiredPermission: 'job.transition.repair' },
  { from: 'QC', to: 'READY', requiredPermission: 'job.transition.repair' },
  { from: 'QC', to: 'IN_REPAIR', requiredPermission: 'job.transition.repair' }, // rework
  { from: 'READY', to: 'DISPATCHED', requiredPermission: 'job.transition.dispatch' },
  { from: 'DISPATCHED', to: 'CLOSED', requiredPermission: 'job.transition.dispatch' },
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
      // Keep the dev admin's password aligned with SEED_ADMIN_PASSWORD:
      // re-running the seed after changing the env (or after an older seed
      // hashed a different default) must always leave a working login.
      passwordHash,
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

  // --- Chart of accounts (upsert by company_id + code, Task 0.6) -------------
  for (const a of CHART_OF_ACCOUNTS) {
    const account = await prisma.chartOfAccount.upsert({
      where: { companyId_code: { companyId: company.id, code: a.code } },
      update: { name: a.name, type: a.type, isActive: true },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: a.code,
        name: a.name,
        type: a.type,
      },
    });
    console.log(`account:        ${account.code} — ${account.name} [${account.type}]`);
  }

  // --- Default workflow (upsert states by company_id + code, then edges by
  // --- company_id + from + to, Task 1.2 §4.10/§5/E7) ------------------------
  const stateIdByCode = new Map<string, string>();
  for (const s of WORKFLOW_STATES) {
    const state = await prisma.workflowState.upsert({
      where: { companyId_code: { companyId: company.id, code: s.code } },
      update: {
        label: s.label,
        isInitial: s.isInitial ?? false,
        isTerminal: s.isTerminal ?? false,
        sortOrder: s.sortOrder,
        active: true,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        code: s.code,
        label: s.label,
        isInitial: s.isInitial ?? false,
        isTerminal: s.isTerminal ?? false,
        sortOrder: s.sortOrder,
      },
    });
    stateIdByCode.set(state.code, state.id);
    const flags = [
      state.isInitial ? 'initial' : null,
      state.isTerminal ? 'terminal' : null,
    ].filter(Boolean);
    console.log(
      `workflow state: ${state.code}${flags.length ? ` [${flags.join(', ')}]` : ''}`,
    );
  }

  for (const t of WORKFLOW_TRANSITIONS) {
    const fromStateId = stateIdByCode.get(t.from);
    const toStateId = stateIdByCode.get(t.to);
    if (!fromStateId || !toStateId) {
      throw new Error(`workflow seed: unknown state in edge ${t.from}→${t.to}`);
    }
    await prisma.workflowTransition.upsert({
      where: {
        companyId_fromStateId_toStateId: {
          companyId: company.id,
          fromStateId,
          toStateId,
        },
      },
      update: {
        requiredPermission: t.requiredPermission,
        requiresApproval: t.requiresApproval ?? false,
        guardCode: t.guardCode ?? null,
        deletedAt: null,
      },
      create: {
        id: randomUUID(),
        companyId: company.id,
        fromStateId,
        toStateId,
        requiredPermission: t.requiredPermission,
        requiresApproval: t.requiresApproval ?? false,
        guardCode: t.guardCode ?? null,
      },
    });
    console.log(
      `workflow edge:  ${t.from} → ${t.to}` +
        `${t.requiredPermission ? ` (${t.requiredPermission})` : ''}` +
        `${t.guardCode ? ` [guard: ${t.guardCode}]` : ''}`,
    );
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
