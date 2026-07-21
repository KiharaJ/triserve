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
import { PrismaClient, type UserScope } from '@prisma/client';
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
/** Extra jobs made by freshJob() — removed in teardown. */
const extraJobIds: string[] = [];
/** Approvals raised by the override tests — removed in teardown. */
const extraApprovalIds: string[] = [];
let initialStateId: string;
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
  samsung_ref_no: string | null;
  ticket_no: string | null;
  gspn_status: string | null;
  labour_amount_usd: string;
  parts_amount_usd: string;
  shipping_amount_usd: string;
  tax_amount_usd: string;
  lines: Array<{
    line_no: number;
    part_no: string;
    qty: number;
    unit_price_usd: string;
    amount_usd: string;
    description: string | null;
  }>;
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

/**
 * A NEW job on the same customer/device.
 *
 * A job may carry only one live claim (the DUPLICATE_WARRANTY_CLAIM guard),
 * so every test that opens a claim needs its own job. Same device on purpose,
 * so serial matching still sees them all.
 */
async function freshJob(): Promise<string> {
  const job = await raw.job.create({
    data: {
      companyId,
      jobNo: `${TEST_PREFIX}-DAR-${extraJobIds.length + 2}`,
      branchId: branchDar,
      customerId,
      deviceId,
      bookedById: ids.clerkDar,
      warrantyStatus: 'IW',
      stateId: initialStateId,
      receivedAt: new Date(),
    },
  });
  extraJobIds.push(job.id);
  return job.id;
}

/** Create a claim and drive it to SUBMITTED. */
async function submittedClaim(amountUsd: string): Promise<string> {
  const claim = await createClaim(tokens.clerkDar, {
    job_id: await freshJob(),
    claim_amount_usd: amountUsd,
    labour_code: 'LEM',
  });
  await submit(tokens.clerkDar, claim.id, {
    claim_no: `SN-${claim.id.slice(0, 8)}`,
  });
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
    role: string,
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
      data: {
        companyId,
        customerId,
        category: 'HHP',
        model: 'A55',
        // Claims are matched to jobs on SERIAL (GSPN masks the IMEI).
        imeiSerial: 'R83TESTSERIAL1',
      },
    })
  ).id;
  const initial = await raw.workflowState.findFirstOrThrow({
    where: { isInitial: true, active: true, deletedAt: null },
  });
  initialStateId = initial.id;
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
  // Every approval this suite raised — including the PENDING ones that were
  // deliberately never decided — hangs off one of its jobs.
  const suiteApprovals = await raw.approval.findMany({
    where: {
      OR: [
        { id: { in: extraApprovalIds } },
        { refType: 'Job', refId: { in: [jobDar, ...extraJobIds] } },
      ],
    },
    select: { id: true },
  });
  const approvalIds = suiteApprovals.map((a) => a.id);
  await raw.auditLog.deleteMany({
    where: { entityType: 'Approval', entityId: { in: approvalIds } },
  });
  await raw.approval.deleteMany({ where: { id: { in: approvalIds } } });
  // Lines first: warranty_claim_lines.claim_id FKs into the claims.
  await raw.warrantyClaimLine.deleteMany({
    where: { claimId: { in: createdClaimIds } },
  });
  await raw.warrantyClaim.deleteMany({
    where: { id: { in: createdClaimIds } },
  });
  await raw.auditLog.deleteMany({
    where: { entityType: 'WarrantyClaim', entityId: { in: createdClaimIds } },
  });
  await raw.job.deleteMany({ where: { id: { in: [jobDar, ...extraJobIds] } } });
  await raw.device.deleteMany({ where: { id: deviceId } });
  await raw.customer.deleteMany({ where: { id: customerId } });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.$disconnect();
  await app.close();
});

describe('Create + edit', () => {
  it('opens a DRAFT claim against a job (USD, branch from job)', async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: await freshJob(),
      claim_amount_usd: '5768', // $57.68
      labour_code: 'LEM',
    });
    expect(claim.status).toBe('DRAFT');
    expect(claim.currency).toBe('USD');
    expect(claim.claim_amount_usd).toBe('5768');
    expect(claim.branch_id).toBe(branchDar); // defaulted from the job
    // freshJob() numbers sequentially from -2; the exact number is incidental.
    expect(claim.job_no).toMatch(new RegExp(`^${TEST_PREFIX}-DAR-\\d+$`));
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
      { job_id: await freshJob(), claim_amount_usd: '0' },
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
      job_id: await freshJob(),
      claim_amount_usd: '1000',
      claim_no: `${TEST_PREFIX}-DUP`,
    });
    await createClaim(
      tokens.clerkDar,
      {
        job_id: await freshJob(),
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
      { job_id: await freshJob(), claim_amount_usd: '1000' },
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
      job_id: await freshJob(),
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
      job_id: await freshJob(),
      claim_amount_usd: '4200',
    });
    const audit = await raw.auditLog.findFirst({
      where: {
        entityType: 'WarrantyClaim',
        entityId: claim.id,
        action: 'CREATE',
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(ids.clerkDar);
  });
});

describe('Submit → reconcile lifecycle + postings (Task 4.2)', () => {
  it('submits a DRAFT with a claim number → SUBMITTED', async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: await freshJob(),
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
      job_id: await freshJob(),
      claim_amount_usd: '1000',
    });
    await submit(tokens.clerkDar, claim.id, {}, 400);
  });

  it('APPROVED posts Dr AR–Samsung / Cr Warranty Revenue (USD, balanced)', async () => {
    const id = await submittedClaim('10000'); // $100.00
    const approved = await reconcile(tokens.clerkDar, id, {
      outcome: 'APPROVED',
    });
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
    const rejected = await reconcile(tokens.clerkDar, id, {
      outcome: 'REJECTED',
    });
    expect(rejected.status).toBe('REJECTED');
    expect(await entriesFor(id)).toHaveLength(0);
  });

  it('rejects illegal transitions (409)', async () => {
    // PAID straight from SUBMITTED (must be APPROVED first).
    const id = await submittedClaim('5000');
    await reconcile(tokens.clerkDar, id, { outcome: 'PAID' }, 409);
    // reconcile a DRAFT.
    const draft = await createClaim(tokens.clerkDar, {
      job_id: await freshJob(),
      claim_amount_usd: '5000',
    });
    await reconcile(tokens.clerkDar, draft.id, { outcome: 'APPROVED' }, 409);
  });

  it('submit/reconcile need their permissions — a SERVICE_ADVISOR is 403', async () => {
    const id = await submittedClaim('5000');
    await reconcile(tokens.advisorDar, id, { outcome: 'APPROVED' }, 403);
    const draft = await createClaim(tokens.clerkDar, {
      job_id: await freshJob(),
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

/**
 * GSPN publishes no export at all for claim DETAIL (the codes, the cost split,
 * the part lines) — only the printed PDF carries it, so it is read directly.
 */
describe('GSPN claim-detail PDF import (§4.7)', () => {
  /** Minimal single-page PDF containing `lines` of text. */
  function makePdf(lines: string[]): Buffer {
    const content = lines
      .map((t, i) => `BT /F1 10 Tf 31 ${700 - i * 20} Td (${t}) Tj ET`)
      .join('\n');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefStart = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
  }

  it('returns a DRAFT and creates no claim', async () => {
    const before = await raw.warrantyClaim.count();
    const res = await request(app.getHttpServer())
      .post('/api/v1/warranty-claims/import/gspn-pdf')
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .attach(
        'file',
        makePdf([
          'Warranty Claim Detail',
          'ASC Claim No 4294486119',
          'Samsung Ref. No 691010405931',
        ]),
        { filename: 'claim.pdf', contentType: 'application/pdf' },
      )
      .expect(201);

    const body = res.body as { claim_no: string; samsung_ref_no: string };
    expect(body.claim_no).toBe('4294486119');
    expect(body.samsung_ref_no).toBe('691010405931');
    // Matching a claim to one of our jobs is a human call — nothing is saved.
    expect(await raw.warrantyClaim.count()).toBe(before);
  });

  it('rejects a non-PDF even when it claims to be one', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/warranty-claims/import/gspn-pdf')
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .attach('file', Buffer.from('not a pdf at all'), {
        filename: 'evil.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
  });

  it('rejects a job card uploaded to the claim endpoint (422)', async () => {
    // Both are GSPN PDFs; only the heading tells them apart.
    await request(app.getHttpServer())
      .post('/api/v1/warranty-claims/import/gspn-pdf')
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .attach('file', makePdf(['Service Order Sheet', 'Customer Name X']), {
        filename: 'jobcard.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);
  });

  it('requires warranty.claim.create', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/warranty-claims/import/gspn-pdf')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .attach('file', makePdf(['Warranty Claim Detail']), {
        filename: 'claim.pdf',
        contentType: 'application/pdf',
      })
      .expect(403);
  });
});

describe('Claim detail: the cost split + part lines (§4.7)', () => {
  it('persists the GSPN references, the split and the part lines', async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: await freshJob(),
      claim_amount_usd: '4030',
      labour_amount_usd: '1652',
      parts_amount_usd: '1283',
      shipping_amount_usd: '1095',
      tax_amount_usd: '0',
      samsung_ref_no: '691010405931',
      ticket_no: '4294486119',
      gspn_status: '20-Data closed',
      repair_received_at: '2026-05-21T00:00:00.000Z',
      completed_at: '2026-05-25T00:00:00.000Z',
      lines: [
        {
          part_no: 'GH81-26450A',
          description: 'SVC JDM-ASSY SUB PBA_COMMON_A065;SM-A065',
          qty: 1,
          unit_price_usd: '1283',
        },
      ],
    });

    expect(claim.samsung_ref_no).toBe('691010405931');
    expect(claim.gspn_status).toBe('20-Data closed');
    expect(claim.labour_amount_usd).toBe('1652');
    expect(claim.shipping_amount_usd).toBe('1095');
    expect(claim.lines).toHaveLength(1);
    expect(claim.lines[0]).toMatchObject({
      line_no: 1,
      part_no: 'GH81-26450A',
      qty: 1,
      // Omitted on input → qty × unit price.
      amount_usd: '1283',
    });

    const rows = await raw.warrantyClaimLine.findMany({
      where: { claimId: claim.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(companyId);
  });

  it('rejects a split that does not sum to the claim total', async () => {
    // A total that disagrees with its own parts makes a short payment
    // un-attributable, which is the entire reason the split is stored.
    await createClaim(
      tokens.clerkDar,
      {
        job_id: await freshJob(),
        claim_amount_usd: '4030',
        labour_amount_usd: '9999',
        parts_amount_usd: '1283',
      },
      400,
    );
  });

  it('still accepts a claim stating only a total (hand-raised)', async () => {
    const claim = await createClaim(tokens.clerkDar, {
      job_id: await freshJob(),
      claim_amount_usd: '5000',
    });
    // Unsplit is legal; the components read as zero.
    expect(claim.labour_amount_usd).toBe('0');
    expect(claim.lines).toEqual([]);
  });

  it('rejects a line pointing at a part outside the catalogue', async () => {
    await createClaim(
      tokens.clerkDar,
      {
        job_id: await freshJob(),
        claim_amount_usd: '1000',
        lines: [
          {
            part_no: 'GH81-FAKE',
            part_id: '00000000-0000-4000-8000-000000000000',
            unit_price_usd: '1000',
          },
        ],
      },
      400,
    );
  });
});

describe('GET /warranty-claims/match — find the job a claim belongs to', () => {
  it('matches on serial and reports jobs already claimed', async () => {
    const jobId = await freshJob();
    const claim = await createClaim(tokens.clerkDar, {
      job_id: jobId,
      claim_amount_usd: '1500',
    });
    const res = await request(app.getHttpServer())
      .get('/api/v1/warranty-claims/match')
      .query({ serial: 'R83TESTSERIAL1' })
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .expect(200);

    const body = res.body as Array<{
      job_id: string;
      job_no: string;
      existing_claim_ids: string[];
      coverage: string;
    }>;
    const hit = body.find((m) => m.job_id === jobId);
    expect(hit).toBeDefined();
    // Filing a second claim on an already-claimed job is nearly always a
    // mistake — the caller has to be able to see that.
    expect(hit?.existing_claim_ids).toContain(claim.id);
  });

  it('normalises a messily typed serial', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/warranty-claims/match')
      .query({ serial: ' r83-test serial1 ' })
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .expect(200);
    expect((res.body as unknown[]).length).toBeGreaterThan(0);
  });

  it('hides jobs from another branch (a suggestion must respect scope)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/warranty-claims/match')
      .query({ serial: 'R83TESTSERIAL1' })
      .set('Authorization', `Bearer ${tokens.clerkKrk}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('an unknown serial returns nothing rather than erroring', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/warranty-claims/match')
      .query({ serial: 'NOSUCHSERIAL' })
      .set('Authorization', `Bearer ${tokens.clerkDar}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });
});

describe('Admin overrides of the claim guards (§4.11)', () => {
  /** Approve a PENDING approval as the group admin. */
  async function approve(approvalId: string): Promise<void> {
    extraApprovalIds.push(approvalId);
    await request(app.getHttpServer())
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({})
      .expect(200);
  }

  it('duplicate claim: blocked → requested → approved → retried → single use', async () => {
    const jobId = await freshJob();
    await createClaim(tokens.clerkDar, {
      job_id: jobId,
      claim_amount_usd: '1000',
    });

    // 1. Blocked, with no override asked for.
    await createClaim(
      tokens.clerkDar,
      { job_id: jobId, claim_amount_usd: '2000' },
      409,
    );

    // 2. Ask for an override — nothing is created.
    const before = await raw.warrantyClaim.count({ where: { jobId } });
    const held = (await createClaim(
      tokens.clerkDar,
      {
        job_id: jobId,
        claim_amount_usd: '2000',
        request_override: true,
        override_reason: 'Samsung split this repair across two claims',
      },
      201,
    )) as unknown as {
      held: boolean;
      pending_approval: { id: string; type: string };
    };
    expect(held.held).toBe(true);
    expect(held.pending_approval.type).toBe('DUPLICATE_WARRANTY_CLAIM');
    expect(await raw.warrantyClaim.count({ where: { jobId } })).toBe(before);

    // 3. Approve, then retry the SAME request carrying the approval.
    await approve(held.pending_approval.id);
    const claim = await createClaim(tokens.clerkDar, {
      job_id: jobId,
      claim_amount_usd: '2000',
      override_approval_id: held.pending_approval.id,
    });
    expect(claim.id).toBeTruthy();

    // 4. The override is SPENT — replaying it would turn one "yes" into
    //    standing permission.
    await createClaim(
      tokens.clerkDar,
      {
        job_id: jobId,
        claim_amount_usd: '3000',
        override_approval_id: held.pending_approval.id,
      },
      409,
    );
  });

  it('split mismatch: an approved override lets the odd split through', async () => {
    const jobId = await freshJob();
    const held = (await createClaim(
      tokens.clerkDar,
      {
        job_id: jobId,
        claim_amount_usd: '4030',
        labour_amount_usd: '1652',
        parts_amount_usd: '1283',
        // Deliberately short — Samsung's own paperwork disagreed.
        shipping_amount_usd: '1000',
        request_override: true,
        override_reason: 'GSPN printed a shipping figure that does not add up',
      },
      201,
    )) as unknown as { pending_approval: { id: string; type: string } };
    expect(held.pending_approval.type).toBe('CLAIM_SPLIT_MISMATCH');

    await approve(held.pending_approval.id);
    const claim = await createClaim(tokens.clerkDar, {
      job_id: jobId,
      claim_amount_usd: '4030',
      labour_amount_usd: '1652',
      parts_amount_usd: '1283',
      shipping_amount_usd: '1000',
      override_approval_id: held.pending_approval.id,
    });
    // Stored as filed, mismatch and all — the approver owns that decision.
    expect(claim.claim_amount_usd).toBe('4030');
    expect(claim.shipping_amount_usd).toBe('1000');
  });

  it('a PENDING override cannot be spent', async () => {
    const jobId = await freshJob();
    await createClaim(tokens.clerkDar, {
      job_id: jobId,
      claim_amount_usd: '1000',
    });
    const held = (await createClaim(
      tokens.clerkDar,
      {
        job_id: jobId,
        claim_amount_usd: '2000',
        request_override: true,
        override_reason: 'second claim needed',
      },
      201,
    )) as unknown as { pending_approval: { id: string } };

    // Not decided yet → refused.
    await createClaim(
      tokens.clerkDar,
      {
        job_id: jobId,
        claim_amount_usd: '2000',
        override_approval_id: held.pending_approval.id,
      },
      409,
    );
  });

  it('an override for one guard cannot be spent on another', async () => {
    const jobId = await freshJob();
    await createClaim(tokens.clerkDar, {
      job_id: jobId,
      claim_amount_usd: '1000',
    });
    const held = (await createClaim(
      tokens.clerkDar,
      {
        job_id: jobId,
        claim_amount_usd: '2000',
        request_override: true,
        override_reason: 'duplicate is intended',
      },
      201,
    )) as unknown as { pending_approval: { id: string } };
    await approve(held.pending_approval.id);

    // That approval authorises a DUPLICATE, not a bad split — and the split
    // guard is what a fresh job would hit.
    await createClaim(
      tokens.clerkDar,
      {
        job_id: await freshJob(),
        claim_amount_usd: '4030',
        labour_amount_usd: '1',
        override_approval_id: held.pending_approval.id,
      },
      400,
    );
  });

  it('requesting an override without a reason is refused', async () => {
    const jobId = await freshJob();
    await createClaim(tokens.clerkDar, {
      job_id: jobId,
      claim_amount_usd: '1000',
    });
    await createClaim(
      tokens.clerkDar,
      { job_id: jobId, claim_amount_usd: '2000', request_override: true },
      400,
    );
  });

  it('an override offered when nothing is blocking is refused, not burned', async () => {
    const jobId = await freshJob();
    await createClaim(tokens.clerkDar, {
      job_id: jobId,
      claim_amount_usd: '1000',
    });
    const held = (await createClaim(
      tokens.clerkDar,
      {
        job_id: jobId,
        claim_amount_usd: '2000',
        request_override: true,
        override_reason: 'deliberate second claim',
      },
      201,
    )) as unknown as { pending_approval: { id: string } };
    await approve(held.pending_approval.id);

    // A clean job needs no override — spending one here would waste it.
    await createClaim(
      tokens.clerkDar,
      {
        job_id: await freshJob(),
        claim_amount_usd: '1000',
        override_approval_id: held.pending_approval.id,
      },
      400,
    );
    const row = await raw.approval.findUniqueOrThrow({
      where: { id: held.pending_approval.id },
    });
    expect(row.consumedAt).toBeNull();
  });
});
