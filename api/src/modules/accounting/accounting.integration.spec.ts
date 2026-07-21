/**
 * Integration tests (Task 0.6) proving the accounting foundation against
 * the REAL MySQL database:
 *   - THE SPEC TESTS: JournalService.post() writes a BALANCED entry +
 *     lines atomically (SUM(debit) == SUM(credit) verified in SQL); an
 *     UNBALANCED entry is rejected with 422 and writes NOTHING;
 *   - the manual-journal flow: POST /journal-entries validates up front
 *     and parks a PENDING MANUAL_JOURNAL approval (202, no ledger rows);
 *     posting a non-approved proposal is refused (409); after the manager
 *     approves, POST /journal-entries/{approvalId}/post writes the entry
 *     (201) exactly once (double-post → 409); rejected proposals can never
 *     post;
 *   - GET /accounts returns the 10 seeded starter accounts; GET
 *     /journal-entries returns the posted entry WITH lines in the standard
 *     pagination envelope; permissions (accounting.read / accounting.post)
 *     are enforced (403 for a BRANCH_MANAGER, 401 without a token);
 *   - pure normalizeJournalLines unit cases (line rules, currency rule).
 *
 * Fixtures are test-only (prefixed __TEST_0_6__) and removed in afterAll —
 * the real seed (Samsung ASC Group + 5 branches + 1 admin + 2 approval
 * rules + 10 accounts) stays pristine, which the last test asserts.
 */
import {
  INestApplication,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { runWithRequestContext } from '../../common/context/request-context';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  JournalService,
  normalizeJournalLines,
  type JournalEntryWire,
} from './journal.service';

// Jest does not load /api/.env; default to the local dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

const TEST_PREFIX = '__TEST_0_6__';
const PASSWORD = 'Accounting0.6-Pass!';

/** Raw (unextended) client for fixture setup/teardown and row assertions. */
const raw = new PrismaClient();
/** The DI-shape client: PrismaClient + company-scope + audit extensions. */
const scoped = new PrismaService();
/** Service under test, wired exactly as in the DI container. */
const service = new JournalService(
  scoped,
  new ApprovalsService(scoped, new AuditService(scoped), new PermissionResolverService(scoped)),
);

let companyId: string; // the SEEDED company (Samsung ASC Group)
let branchDar: string; // seeded DAR branch (HQ)
let accountant: { id: string; email: string }; // ACCOUNTANT — accounting.read/post
let manager: { id: string; email: string }; // BRANCH_MANAGER — approval.decide
/** code → account id of the SEEDED chart. */
const acct: Record<string, string> = {};

function accountantActor(): AuthUser {
  return {
    userId: accountant.id,
    sessionId: 'test-session',
    companyId,
    role: 'ACCOUNTANT',
    scope: 'group',
    homeBranchId: null,
  };
}

/** Mirror of the HTTP pipeline: request-context store + AuthGuard user. */
function asRequest<T>(user: AuthUser, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ user }, async () => await fn());
}

async function ledgerCounts(): Promise<{ entries: number; lines: number }> {
  const [entries, lines] = await Promise.all([
    raw.journalEntry.count(),
    raw.journalLine.count(),
  ]);
  return { entries, lines };
}

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;
  for (const a of await raw.chartOfAccount.findMany({ where: { companyId } })) {
    acct[a.code] = a.id;
  }

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const [acc, mgr] = await Promise.all([
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} Accountant`,
        email: 'test-0-6-accountant@triserve.test',
        passwordHash,
        role: 'ACCOUNTANT',
        scope: 'group',
      },
    }),
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} Manager`,
        email: 'test-0-6-manager@triserve.test',
        passwordHash,
        role: 'BRANCH_MANAGER',
        scope: 'branch',
        homeBranchId: branchDar,
      },
    }),
  ]);
  accountant = { id: acc.id, email: acc.email };
  manager = { id: mgr.id, email: mgr.email };
});

afterAll(async () => {
  // Purge ONLY this suite's leftovers (raw client bypasses the DI append-
  // only audit guard — that guard protects the app surface, not teardown).
  const userIds = [accountant?.id, manager?.id].filter(Boolean);
  const entries = await raw.journalEntry.findMany({
    where: { postedById: { in: userIds } },
    select: { id: true },
  });
  const entryIds = entries.map((e) => e.id);
  const approvals = await raw.approval.findMany({
    where: { requestedById: { in: userIds } },
    select: { id: true },
  });
  const approvalIds = approvals.map((a) => a.id);

  await raw.journalLine.deleteMany({ where: { entryId: { in: entryIds } } });
  await raw.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await raw.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: [...entryIds, ...approvalIds, ...userIds] } },
        { actorUserId: { in: userIds } },
      ],
    },
  });
  await raw.approval.deleteMany({ where: { id: { in: approvalIds } } });
  await raw.session.deleteMany({ where: { userId: { in: userIds } } });
  await raw.user.deleteMany({ where: { id: { in: userIds } } });
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('normalizeJournalLines (pure double-entry rules)', () => {
  const tzs = (
    accountId: string,
    side: 'debit' | 'credit',
    amount: string,
  ) => ({
    accountId,
    [side]: amount,
    currency: 'TZS',
  });

  it('accepts a balanced entry and normalizes money to bigint', () => {
    const lines = normalizeJournalLines([
      tzs('a', 'debit', '50000000'),
      tzs('b', 'credit', '50000000'),
    ]);
    expect(lines[0].debit).toBe(50000000n);
    expect(lines[0].credit).toBe(0n);
    expect(lines[1].credit).toBe(50000000n);
  });

  it('rejects an unbalanced entry (422)', () => {
    expect(() =>
      normalizeJournalLines([
        tzs('a', 'debit', '100'),
        tzs('b', 'credit', '99'),
      ]),
    ).toThrow(/double-entry rules violated/);
  });

  /** The 422's `details` list every violated rule — extract it. */
  const detailsOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      const body = (e as UnprocessableEntityException).getResponse() as {
        details?: string[];
      };
      return (body.details ?? []).join('; ');
    }
    throw new Error('expected normalizeJournalLines to throw');
  };

  it('rejects a line with BOTH debit and credit (or neither)', () => {
    expect(
      detailsOf(() =>
        normalizeJournalLines([
          { accountId: 'a', debit: '100', credit: '100', currency: 'TZS' },
          tzs('b', 'credit', '0'),
        ]),
      ),
    ).toMatch(/exactly one of debit\/credit/);
  });

  it('rejects mixed currencies (single-currency entries for now)', () => {
    expect(
      detailsOf(() =>
        normalizeJournalLines([
          { accountId: 'a', debit: '100', currency: 'TZS' },
          { accountId: 'b', credit: '100', currency: 'USD' },
        ]),
      ),
    ).toMatch(/share one currency/);
  });

  it('rejects fewer than 2 lines and zero-total entries', () => {
    expect(() => normalizeJournalLines([tzs('a', 'debit', '100')])).toThrow(
      /at least 2 lines/,
    );
    expect(() =>
      normalizeJournalLines([tzs('a', 'debit', '0'), tzs('b', 'credit', '0')]),
    ).toThrow(/double-entry rules violated/);
  });
});

describe('JournalService.post (THE SPEC TESTS)', () => {
  it('balanced entry → entry + lines persisted atomically, SUM(debit)==SUM(credit), audited', async () => {
    const entry = await asRequest(accountantActor(), () =>
      service.post({
        branchId: branchDar,
        entryDate: '2026-07-09',
        sourceType: 'ADJUSTMENT',
        memo: `${TEST_PREFIX} opening cash vs equity`,
        lines: [
          { accountId: acct['1000'], debit: '250000000', currency: 'TZS' },
          { accountId: acct['3000'], credit: '250000000', currency: 'TZS' },
        ],
      }),
    );

    expect(entry.company_id).toBe(companyId);
    expect(entry.branch_id).toBe(branchDar);
    expect(entry.entry_date).toBe('2026-07-09');
    expect(entry.source_type).toBe('ADJUSTMENT');
    expect(entry.posted_by).toBe(accountant.id);
    expect(entry.lines).toHaveLength(2);

    // Rows really are in MySQL and balance in SQL terms.
    const lines = await raw.journalLine.findMany({
      where: { entryId: entry.id },
    });
    expect(lines).toHaveLength(2);
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0n);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0n);
    expect(totalDebit).toBe(250000000n);
    expect(totalDebit).toBe(totalCredit);

    // The posting was audited (CREATE on the entry, same transaction).
    const audit = await raw.auditLog.findFirst({
      where: { entityId: entry.id, action: 'CREATE' },
    });
    expect(audit?.entityType).toBe('JournalEntry');
    expect(audit?.actorUserId).toBe(accountant.id);
  });

  it('unbalanced entry → 422 rejected, NOTHING written', async () => {
    const before = await ledgerCounts();
    await expect(
      asRequest(accountantActor(), () =>
        service.post({
          entryDate: '2026-07-09',
          sourceType: 'ADJUSTMENT',
          lines: [
            { accountId: acct['1000'], debit: '100000', currency: 'TZS' },
            { accountId: acct['3000'], credit: '99999', currency: 'TZS' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("unknown account → 400 rejected, NOTHING written (other company's ids can't be posted to)", async () => {
    const before = await ledgerCounts();
    await expect(
      asRequest(accountantActor(), () =>
        service.post({
          entryDate: '2026-07-09',
          sourceType: 'ADJUSTMENT',
          lines: [
            {
              accountId: '00000000-0000-4000-8000-000000000000',
              debit: '100',
              currency: 'TZS',
            },
            { accountId: acct['3000'], credit: '100', currency: 'TZS' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await ledgerCounts()).toEqual(before);
  });
});

describe('manual journal via approval + endpoints (end-to-end)', () => {
  let app: INestApplication<App>;
  let accountantToken: string;
  let managerToken: string;
  let approvalId: string;
  let postedEntry: JournalEntryWire;

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  const balancedBody = () => ({
    entry_date: '2026-07-01',
    branch_id: branchDar,
    memo: `${TEST_PREFIX} write off petty cash vs equity`,
    reason: `${TEST_PREFIX} month-end manual adjustment`,
    lines: [
      { account_id: acct['3000'], debit: '7500000', currency: 'TZS' },
      { account_id: acct['1000'], credit: 7500000, currency: 'TZS' }, // number accepted too
    ],
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter()); // same as main.ts
    await app.init();

    accountantToken = await login(accountant.email);
    managerToken = await login(manager.email);
  });

  afterAll(async () => {
    await app.close();
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/accounts').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/journal-entries')
      .expect(401);
  });

  it('GET /accounts returns the 10 seeded starter accounts (accounting.read)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/accounts')
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);

    const body = res.body as {
      data: Array<{ code: string; type: string; company_id: string }>;
      page: number;
      page_size: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.total).toBe(10);
    expect(body.data.map((a) => a.code)).toEqual([
      '1000',
      '1010',
      '1200',
      '1300',
      '2000',
      '2100',
      '3000',
      '4000',
      '4010',
      '5000',
    ]);
    const types = Object.fromEntries(body.data.map((a) => [a.code, a.type]));
    expect(types['1000']).toBe('ASSET');
    expect(types['2100']).toBe('LIABILITY');
    expect(types['3000']).toBe('EQUITY');
    expect(types['4010']).toBe('REVENUE');
    expect(types['5000']).toBe('EXPENSE');
    for (const a of body.data) expect(a.company_id).toBe(companyId);
  });

  it("a BRANCH_MANAGER (no 'accounting.read') gets 403 on GET /accounts", async () => {
    await request(app.getHttpServer())
      .get('/api/v1/accounts')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
  });

  it('POST /journal-entries with an UNBALANCED payload → 422, NO approval created', async () => {
    const before = await raw.approval.count({
      where: { type: 'MANUAL_JOURNAL' },
    });
    const body = balancedBody();
    body.lines[1] = {
      account_id: acct['1000'],
      credit: 7499999,
      currency: 'TZS',
    };
    const res = await request(app.getHttpServer())
      .post('/api/v1/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send(body)
      .expect(422);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'UNPROCESSABLE_ENTITY',
    );
    expect(
      await raw.approval.count({ where: { type: 'MANUAL_JOURNAL' } }),
    ).toBe(before);
  });

  it('POST /journal-entries refuses any source_type but MANUAL (400)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send({ ...balancedBody(), source_type: 'PAYMENT' })
      .expect(400);
  });

  it("a BRANCH_MANAGER (no 'accounting.post') cannot propose (403)", async () => {
    await request(app.getHttpServer())
      .post('/api/v1/journal-entries')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(balancedBody())
      .expect(403);
  });

  it('POST /journal-entries (balanced) → 202 PENDING MANUAL_JOURNAL approval, NO ledger rows', async () => {
    const before = await ledgerCounts();
    const res = await request(app.getHttpServer())
      .post('/api/v1/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send(balancedBody())
      .expect(202);

    const body = res.body as {
      id: string;
      type: string;
      status: string;
      ref_type: string;
      ref_id: string | null;
      requested_by: string;
      payload_json: { lines: unknown[] };
    };
    approvalId = body.id;
    expect(body.type).toBe('MANUAL_JOURNAL');
    expect(body.status).toBe('PENDING');
    expect(body.ref_type).toBe('JournalEntry');
    expect(body.ref_id).toBeNull();
    expect(body.requested_by).toBe(accountant.id);
    expect(body.payload_json.lines).toHaveLength(2);

    expect(await ledgerCounts()).toEqual(before); // nothing posted yet
  });

  it('a NON-APPROVED proposal cannot be posted → 409, still no ledger rows', async () => {
    const before = await ledgerCounts();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/journal-entries/${approvalId}/post`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(409);
    expect((res.body as { error: { message: string } }).error.message).toMatch(
      /still PENDING/,
    );
    expect(await ledgerCounts()).toEqual(before);
  });

  it('manager approves (generic approvals endpoint), then POST …/post writes the balanced entry', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'month-end adjustment verified' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/journal-entries/${approvalId}/post`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(201);

    postedEntry = res.body as JournalEntryWire;
    expect(postedEntry.source_type).toBe('MANUAL');
    expect(postedEntry.source_id).toBe(approvalId); // provenance entry → approval
    expect(postedEntry.entry_date).toBe('2026-07-01');
    expect(postedEntry.posted_by).toBe(accountant.id);
    expect(postedEntry.lines).toHaveLength(2);

    // Balanced in the DB; approval back-references the entry (consumed).
    const lines = await raw.journalLine.findMany({
      where: { entryId: postedEntry.id },
    });
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0n);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0n);
    expect(totalDebit).toBe(7500000n);
    expect(totalDebit).toBe(totalCredit);
    const approval = await raw.approval.findUniqueOrThrow({
      where: { id: approvalId },
    });
    expect(approval.refId).toBe(postedEntry.id);
  });

  it('the same approval cannot be posted TWICE → 409', async () => {
    const before = await ledgerCounts();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/journal-entries/${approvalId}/post`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(409);
    expect((res.body as { error: { message: string } }).error.message).toMatch(
      /Already posted/,
    );
    expect(await ledgerCounts()).toEqual(before);
  });

  it('a REJECTED proposal can never be posted', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send({ ...balancedBody(), reason: `${TEST_PREFIX} to be rejected` })
      .expect(202);
    const rejectedId = (res.body as { id: string }).id;

    await request(app.getHttpServer())
      .post(`/api/v1/approvals/${rejectedId}/reject`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'not evidenced' })
      .expect(200);

    const before = await ledgerCounts();
    await request(app.getHttpServer())
      .post(`/api/v1/journal-entries/${rejectedId}/post`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(409);
    expect(await ledgerCounts()).toEqual(before);
  });

  it('GET /journal-entries returns the posted entry WITH lines in the pagination envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/journal-entries')
      .query({ source_type: 'MANUAL', from: '2026-07-01', to: '2026-07-31' })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);

    const body = res.body as {
      data: JournalEntryWire[];
      page: number;
      page_size: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.total).toBeGreaterThanOrEqual(1);
    const mine = body.data.find((e) => e.id === postedEntry.id);
    expect(mine).toBeDefined();
    expect(mine!.lines).toHaveLength(2);
    expect(mine!.lines.map((l) => l.currency)).toEqual(['TZS', 'TZS']);
    for (const e of body.data) {
      expect(e.company_id).toBe(companyId);
      expect(e.source_type).toBe('MANUAL');
    }
  });

  it('GET /journal-entries paginates (page_size=1) and date-filters exclude the entry', async () => {
    const paged = await request(app.getHttpServer())
      .get('/api/v1/journal-entries')
      .query({ page_size: 1, page: 1 })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect((paged.body as { data: unknown[] }).data).toHaveLength(1);

    const none = await request(app.getHttpServer())
      .get('/api/v1/journal-entries')
      .query({ source_type: 'MANUAL', from: '2030-01-01' })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    expect((none.body as { total: number }).total).toBe(0);
  });
});

describe('real seed data stays intact', () => {
  it('Samsung ASC Group + 5 branches + 1 super admin + 2 rules + 10 accounts, un-duplicated', async () => {
    const samsung = await raw.company.findMany({
      where: { name: 'Samsung ASC Group' },
    });
    expect(samsung.length).toBe(1);
    const branchCount = await raw.branch.count({
      where: {
        companyId: samsung[0].id,
        NOT: { name: { startsWith: '__TEST_' } },
      },
    });
    expect(branchCount).toBe(5);
    const adminCount = await raw.user.count({
      where: { companyId: samsung[0].id, role: 'SUPER_ADMIN' },
    });
    expect(adminCount).toBe(1);
    const rules = await raw.approvalRule.count({
      where: { companyId: samsung[0].id },
    });
    expect(rules).toBe(2);
    const accounts = await raw.chartOfAccount.findMany({
      where: { companyId: samsung[0].id },
      orderBy: { code: 'asc' },
    });
    expect(accounts.map((a) => a.code)).toEqual([
      '1000',
      '1010',
      '1200',
      '1300',
      '2000',
      '2100',
      '3000',
      '4000',
      '4010',
      '5000',
    ]);
  });
});
