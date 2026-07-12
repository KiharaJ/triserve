/**
 * Integration tests (Task 4.1, DESIGN.md §4.7) for warranty claims against the
 * REAL MySQL database over HTTP:
 *   - POST /warranty-claims opens a DRAFT claim against a job: currency USD,
 *     status DRAFT, branch defaults to the job's branch, job_no echoed;
 *   - claim_amount_usd '0' → 400; an unknown job_id → 400;
 *   - a duplicate claim_no → 409;
 *   - PATCH edits a DRAFT (amount, labour_code, claim_no); recompute;
 *   - creating needs warranty.claim.create (a SERVICE_ADVISOR is 403);
 *   - reading needs warranty.claim.read (a SERVICE_ADVISOR is 403);
 *   - scoping: a KRK clerk can't see a DAR claim (404);
 *   - create writes a WarrantyClaim CREATE audit row.
 *
 * Fixtures are test-only (prefixed __TEST_4_1__) and removed in afterAll.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, type UserRole, type UserScope } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_4_1__';
const PASSWORD = 'Warranty4.1-Pass!';

const EMAILS = {
  admin: 'test-4-1-admin@triserve.test',
  clerkDar: 'test-4-1-clerk-dar@triserve.test',
  clerkKrk: 'test-4-1-clerk-krk@triserve.test',
  advisorDar: 'test-4-1-advisor-dar@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let branchKrk: string;
let jobDar: string;
let customerId: string;
let deviceId: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const acct: Record<string, string> = {}; // chart code → account id
const createdClaimIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

interface ClaimBody {
  id: string;
  branch_id: string;
  job_no: string;
  claim_no: string | null;
  currency: string;
  claim_amount_usd: string;
  reimbursed_amount_usd: string | null;
  status: string;
  submitted_at: string | null;
  paid_at: string | null;
  labour_code: string | null;
}

async function createClaim(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<ClaimBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/warranty-claims')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  const claim = res.body as ClaimBody;
  if (claim.id) createdClaimIds.push(claim.id);
  return claim;
}

async function submit(
  token: string,
  id: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<ClaimBody> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/warranty-claims/${id}/submit`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  return res.body as ClaimBody;
}

async function reconcile(
  token: string,
  id: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<ClaimBody> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/warranty-claims/${id}/reconcile`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  return res.body as ClaimBody;
}

/** The posted WARRANTY journal entries (with lines) for a claim. */
function entriesFor(claimId: string) {
  return raw.journalEntry.findMany({
    where: { sourceType: 'WARRANTY', sourceId: claimId },
    include: { lines: true },
  });
}

/** Create a claim and drive it to SUBMITTED. */
async function submittedClaim(amountUsd: string): Promise<string> {
  const claim = await createClaim(tokens.clerkDar, {
    job_id: jobDar,
    claim_amount_usd: amountUsd,
    labour_code: 'LEM',
  });
  await submit(tokens.clerkDar, claim.id, { claim_no: `SN-${claim.id.slice(0, 8)}` });
  return claim.id;
}

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;
  branchKrk = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'KRK' } })
  ).id;

  for (const a of await raw.chartOfAccount.findMany({
    where: { companyId, code: { in: ['1010', '1200', '4010'] } },
  })) {
    acct[a.code] = a.id;
  }

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mk = (
    email: string,
    role: UserRole,
    scope: UserScope,
    homeBranchId: string | null,
  ) =>
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} ${role}`,
        email,
        passwordHash,
        role,
        scope,
        homeBranchId,
      },
    });

  const [admin, clerkDar, clerkKrk, advisorDar] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', null),
    mk(EMAILS.clerkDar, 'WARRANTY_CLERK', 'branch', branchDar),
    mk(EMAILS.clerkKrk, 'WARRANTY_CLERK', 'branch', branchKrk),
    mk(EMAILS.advisorDar, 'SERVICE_ADVISOR', 'branch', branchDar),
  ]);
  ids.admin = admin.id;
  ids.clerkDar = clerkDar.id;
  ids.clerkKrk = clerkKrk.id;
  ids.advisorDar = advisorDar.id;

  // A job to attach claims to (customer + device + initial workflow state).
  customerId = (
    await raw.customer.create({
      data: { companyId, name: `${TEST_PREFIX} Customer` },
    })
  ).id;
  deviceId = (
    await raw.device.create({
      data: { companyId, customerId, category: 'HHP', model: 'A55' },
    })
  ).id;
  const initial = await raw.workflowState.findFirstOrThrow({
    where: { isInitial: true, active: true, deletedAt: null },
  });
  jobDar = (
    await raw.job.create({
      data: {
        companyId,
        jobNo: `${TEST_PREFIX}-DAR-1`,
        branchId: branchDar,
        customerId,
        deviceId,
        bookedById: clerkDar.id,
        warrantyStatus: 'IW',
        stateId: initial.id,
        receivedAt: new Date(),
      },
    })
  ).id;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  tokens.admin = await login(EMAILS.admin);
  tokens.clerkDar = await login(EMAILS.clerkDar);
  tokens.clerkKrk = await login(EMAILS.clerkKrk);
  tokens.advisorDar = await login(EMAILS.advisorDar);
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  // Reconcile (Task 4.2) posts journal entries (posted_by = a test clerk) —
  // remove them before the users they reference.
  const entries = await raw.journalEntry.findMany({
    where: { sourceType: 'WARRANTY', sourceId: { in: createdClaimIds } },
    select: { id: true },
  });
  const entryIds = entries.map((e) => e.id);
  await raw.journalLine.deleteMany({ where: { entryId: { in: entryIds } } });
  await raw.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await raw.warrantyClaim.deleteMany({ where: { id: { in: createdClaimIds } } });
  await raw.auditLog.deleteMany({
    where: { entityType: 'WarrantyClaim', entityId: { in: createdClaimIds } },
  });
  await raw.job.deleteMany({ where: { id: jobDar } });
  await raw.device.deleteMany({ where: { id: deviceId } });
  await raw.customer.deleteMany({ where: { id: customerId } });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await raw.$disconnect();
  await app.close();
});

describe('Create + edit', () => {
  it('opens a DRAFT claim against a job (USD, branch from job)', async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: jobDar,
      claim_amount_usd: '5768', // $57.68
      labour_code: 'LEM',
    });
    expect(claim.status).toBe('DRAFT');
    expect(claim.currency).toBe('USD');
    expect(claim.claim_amount_usd).toBe('5768');
    expect(claim.branch_id).toBe(branchDar); // defaulted from the job
    expect(claim.job_no).toBe(`${TEST_PREFIX}-DAR-1`);
    expect(claim.labour_code).toBe('LEM');

    // Edit the DRAFT: change amount + assign a Samsung claim number.
    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/warranty-claims/${claim.id}`)
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .send({ claim_amount_usd: '8607', claim_no: '691010338615' })
      .expect(200);
    const body = patched.body as ClaimBody;
    expect(body.claim_amount_usd).toBe('8607');
    expect(body.claim_no).toBe('691010338615');
  });

  it('rejects a zero amount and an unknown job', async () => {
    await createClaim(
      tokens.clerkDar,
      { job_id: jobDar, claim_amount_usd: '0' },
      400,
    );
    await createClaim(
      tokens.clerkDar,
      {
        job_id: '00000000-0000-4000-8000-000000000000',
        claim_amount_usd: '1000',
      },
      400,
    );
  });

  it('rejects a duplicate Samsung claim number (409)', async () => {
    await createClaim(tokens.clerkDar, {
      job_id: jobDar,
      claim_amount_usd: '1000',
      claim_no: `${TEST_PREFIX}-DUP`,
    });
    await createClaim(
      tokens.clerkDar,
      {
        job_id: jobDar,
        claim_amount_usd: '2000',
        claim_no: `${TEST_PREFIX}-DUP`,
      },
      409,
    );
  });
});

describe('Authorization + scoping', () => {
  it('needs warranty.claim.create — a SERVICE_ADVISOR is 403', async () => {
    await createClaim(
      tokens.advisorDar,
      { job_id: jobDar, claim_amount_usd: '1000' },
      403,
    );
  });

  it('needs warranty.claim.read — a SERVICE_ADVISOR is 403', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/warranty-claims')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(403);
  });

  it("a KRK clerk can't see a DAR claim (404)", async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: jobDar,
      claim_amount_usd: '1234',
    });
    await request(app.getHttpServer())
      .get(`/api/v1/warranty-claims/${claim.id}`)
      .set('Authorization', `Bearer ${tokens.clerkKrk}`)
      .expect(404);
    // …but the DAR clerk can.
    await request(app.getHttpServer())
      .get(`/api/v1/warranty-claims/${claim.id}`)
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .expect(200);
  });

  it('writes a CREATE audit row', async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: jobDar,
      claim_amount_usd: '4200',
    });
    const audit = await raw.auditLog.findFirst({
      where: { entityType: 'WarrantyClaim', entityId: claim.id, action: 'CREATE' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(ids.clerkDar);
  });
});

describe('Submit → reconcile lifecycle + postings (Task 4.2)', () => {
  it('submits a DRAFT with a claim number → SUBMITTED', async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: jobDar,
      claim_amount_usd: '8607',
      labour_code: 'FEM',
    });
    const submitted = await submit(tokens.clerkDar, claim.id, {
      claim_no: '691010338615-A',
    });
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.claim_no).toBe('691010338615-A');
    expect(submitted.submitted_at).not.toBeNull();
  });

  it('refuses to submit a DRAFT with no claim number (400)', async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: jobDar,
      claim_amount_usd: '1000',
    });
    await submit(tokens.clerkDar, claim.id, {}, 400);
  });

  it('APPROVED posts Dr AR–Samsung / Cr Warranty Revenue (USD, balanced)', async () => {
    const id = await submittedClaim('10000'); // $100.00
    const approved = await reconcile(tokens.clerkDar, id, { outcome: 'APPROVED' });
    expect(approved.status).toBe('APPROVED');

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    const lines = entries[0].lines;
    expect(lines).toHaveLength(2);
    const byAccount = new Map(lines.map((l) => [l.accountId, l]));
    expect(byAccount.get(acct['1200'])!.debit).toBe(10_000n); // Dr AR–Samsung
    expect(byAccount.get(acct['4010'])!.credit).toBe(10_000n); // Cr Warranty Rev
    const debit = lines.reduce((s, l) => s + l.debit, 0n);
    const credit = lines.reduce((s, l) => s + l.credit, 0n);
    expect(debit).toBe(credit);
  });

  it('PAID posts Dr Bank / Cr AR–Samsung and records the reimbursement', async () => {
    const id = await submittedClaim('10000');
    await reconcile(tokens.clerkDar, id, { outcome: 'APPROVED' });
    const paid = await reconcile(tokens.clerkDar, id, {
      outcome: 'PAID',
      reimbursed_amount_usd: '9500', // Samsung short-pays $95
    });
    expect(paid.status).toBe('PAID');
    expect(paid.reimbursed_amount_usd).toBe('9500');
    expect(paid.paid_at).not.toBeNull();

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(2); // approval + reimbursement
    const reimb = entries.find((e) => /reimbursed/i.test(e.memo ?? ''));
    const byAccount = new Map(reimb!.lines.map((l) => [l.accountId, l]));
    expect(byAccount.get(acct['1010'])!.debit).toBe(9_500n); // Dr Bank
    expect(byAccount.get(acct['1200'])!.credit).toBe(9_500n); // Cr AR–Samsung
  });

  it('REJECTED posts nothing', async () => {
    const id = await submittedClaim('5000');
    const rejected = await reconcile(tokens.clerkDar, id, { outcome: 'REJECTED' });
    expect(rejected.status).toBe('REJECTED');
    expect(await entriesFor(id)).toHaveLength(0);
  });

  it('rejects illegal transitions (409)', async () => {
    // PAID straight from SUBMITTED (must be APPROVED first).
    const id = await submittedClaim('5000');
    await reconcile(tokens.clerkDar, id, { outcome: 'PAID' }, 409);
    // reconcile a DRAFT.
    const draft = await createClaim(tokens.clerkDar, {
      job_id: jobDar,
      claim_amount_usd: '5000',
    });
    await reconcile(tokens.clerkDar, draft.id, { outcome: 'APPROVED' }, 409);
  });

  it('submit/reconcile need their permissions — a SERVICE_ADVISOR is 403', async () => {
    const id = await submittedClaim('5000');
    await reconcile(tokens.advisorDar, id, { outcome: 'APPROVED' }, 403);
    const draft = await createClaim(tokens.clerkDar, {
      job_id: jobDar,
      claim_amount_usd: '5000',
    });
    await submit(tokens.advisorDar, draft.id, { claim_no: 'X-1' }, 403);
  });
});

async function claimNoOf(id: string): Promise<string> {
  const c = await raw.warrantyClaim.findUnique({
    where: { id },
    select: { claimNo: true },
  });
  return c!.claimNo!;
}

describe('GSPN CSV bridge (E13, Task 4.3)', () => {
  it('exports SUBMITTED claims as CSV', async () => {
    const id = await submittedClaim('7500'); // $75.00
    const cno = await claimNoOf(id);
    const res = await request(app.getHttpServer())
      .get('/api/v1/warranty-claims/export')
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/csv/);
    expect(res.text).toContain('claim_no,job_no,imei_serial');
    expect(res.text).toContain(cno);
    expect(res.text).toContain('75.00');
  });

  it('imports a reconciliation CSV → applies matches, reports the rest', async () => {
    const id = await submittedClaim('10000');
    const cno = await claimNoOf(id);
    const csv = [
      'claim_no,outcome,reimbursed_usd',
      `${cno},APPROVED,`,
      'NO-SUCH-CLAIM,APPROVED,',
      'BAD-ROW,WHATEVER,',
    ].join('\n');
    const res = await request(app.getHttpServer())
      .post('/api/v1/warranty-claims/import')
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .send({ csv })
      .expect(201);
    const report = res.body as {
      total: number;
      applied: number;
      errors: { claim_no: string; reason: string }[];
    };
    expect(report.total).toBe(3);
    expect(report.applied).toBe(1);
    expect(report.errors).toHaveLength(2);
    expect(report.errors.map((e) => e.claim_no)).toEqual(
      expect.arrayContaining(['NO-SUCH-CLAIM', 'BAD-ROW']),
    );
    const after = await raw.warrantyClaim.findUnique({ where: { id } });
    expect(after!.status).toBe('APPROVED');
  });

  it('imports PAID with a reimbursed dollar amount → records it (cents)', async () => {
    const id = await submittedClaim('10000');
    const cno = await claimNoOf(id);
    await request(app.getHttpServer())
      .post('/api/v1/warranty-claims/import')
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .send({ csv: `claim_no,outcome,reimbursed_usd\n${cno},APPROVED,` })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/api/v1/warranty-claims/import')
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .send({ csv: `claim_no,outcome,reimbursed_usd\n${cno},PAID,95.00` })
      .expect(201);
    expect((res.body as { applied: number }).applied).toBe(1);
    const after = await raw.warrantyClaim.findUnique({ where: { id } });
    expect(after!.status).toBe('PAID');
    expect(after!.reimbursedAmountUsd).toBe(9_500n);
  });

  it('import needs warranty.claim.reconcile — a SERVICE_ADVISOR is 403', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/warranty-claims/import')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ csv: 'claim_no,outcome\nX,APPROVED' })
      .expect(403);
  });
});
