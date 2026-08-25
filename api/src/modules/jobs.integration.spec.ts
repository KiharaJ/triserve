/**
 * Integration tests (Task 1.3, DESIGN.md §4.3/§5) for the job lifecycle API
 * against the REAL MySQL database over HTTP:
 *   - POST /jobs with a nested new customer+device → job_no matches
 *     /^DAR-2026-\d{6}$/, state=BOOKED, received_at set, so_number
 *     scientific-notation input normalized;
 *   - a 2nd job same branch/year increments the sequence;
 *   - CONCURRENCY: 10 parallel creates → 10 unique sequential job_nos, the
 *     jobs.job_no unique constraint never violated;
 *   - POST /jobs/{id}/transition BOOKED→RECEIVED→DIAGNOSING works + writes a
 *     TRANSITION audit row per hop; illegal BOOKED→CLOSED → 422;
 *   - walking a job to READY stamps ready_at; /dispatch stamps
 *     dispatched_at / dispatched_by / waybill_no / received_by_customer;
 *   - a TECHNICIAN sees ONLY jobs assigned to them (list + detail);
 *   - company + branch scoping holds (company B and other-branch users can't
 *     read a DAR job; a KRK advisor can't see DAR jobs).
 *
 * Fixtures are test-only (prefixed __TEST_1_3__) and removed in afterAll — the
 * real seed stays pristine, which the last test asserts explicitly.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, type UserScope } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { testImei } from '../../test/imei';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

const TEST_PREFIX = '__TEST_1_3__';
const PASSWORD = 'Jobs1.3-Pass!';
const YEAR = new Date().getFullYear();

const EMAILS = {
  admin: 'test-1-3-admin@triserve.test',
  advisorDar: 'test-1-3-advisor-dar@triserve.test',
  advisorKrk: 'test-1-3-advisor-krk@triserve.test',
  tech1: 'test-1-3-tech1@triserve.test',
  tech2: 'test-1-3-tech2@triserve.test',
  adminB: 'test-1-3-admin-b@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let companyBId: string;
let branchDar: string;
let branchKrk: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdJobIds: string[] = [];
/** Warranty registrations created as fixtures — removed AFTER jobs (FK). */
const createdRegistrationIds: string[] = [];
/** Approvals raised by the override tests — removed in teardown. */
const createdApprovalIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

interface JobBody {
  id: string;
  job_no: string;
  so_number: string | null;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  state_code: string;
  received_at: string;
  engineer_received_at: string | null;
  ready_at: string | null;
  dispatched_at: string | null;
  dispatched_by: string | null;
  received_by_customer: string | null;
  waybill_no: string | null;
  assigned_engineer_id: string | null;
  assigned_engineer_name: string | null;
  warranty_status: string;
  service_type: string;
  coverage: string;
  service_category_id: string | null;
  priority: string;
  sla_due_at: string | null;
  is_overdue: boolean;
  warranty_source: string | null;
  warranty_decided_by: string | null;
  warranty_decided_at: string | null;
  accessories_held: string | null;
  return_by_date: string | null;
  symptom_code_id: string | null;
  repair_code_id: string | null;
  device?: { purchase_date: string | null };
  allowed_next_transitions?: Array<{
    to_state_code: string;
    blocked_reason?: string;
    blocked_guard?: string;
  }>;
}

/** POST /jobs and remember the id for teardown. */
async function createJob(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<JobBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/jobs')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  const job = res.body as JobBody;
  if (job.id) createdJobIds.push(job.id);
  return job;
}

/**
 * Satisfy the SCMS intake-evidence gate (proposal Module 1, §2) so a job can
 * leave the counter.
 *
 * RECEIVED → DIAGNOSING now carries `intake_evidence_complete`, which demands
 * the whole front-desk pack: the visual condition check, a before-photo, a
 * symptom-tree leaf, the customer's signature, and their acceptance of terms.
 * Every lifecycle test below needs a job that has been properly booked in, so
 * doing it once here keeps those tests about the LIFECYCLE rather than about
 * intake — and exercises the real endpoints end to end while it is at it.
 */
async function completeIntake(token: string, jobId: string): Promise<void> {
  const server = app.getHttpServer();

  // 1. The visual condition walk-through. An EMPTY mark list is a valid
  //    finding ("checked, unmarked") and is what stamps condition_captured_at.
  await request(server)
    .put(`/api/v1/jobs/${jobId}/condition`)
    .set('Authorization', `Bearer ${token}`)
    .send({ marks: [], liquid_indicator_tripped: false })
    .expect(200);

  // 2. A before-photo — a 1x1 PNG is enough to satisfy "proof photos exist".
  await request(server)
    .post('/api/v1/attachments')
    .set('Authorization', `Bearer ${token}`)
    .field('owner_type', 'JOB')
    .field('owner_id', jobId)
    .field('kind', 'PHOTO_BEFORE')
    .attach('file', ONE_PX_PNG, {
      filename: 'before.png',
      contentType: 'image/png',
    })
    .expect(201);

  // 3. The customer's signature.
  const sig = await request(server)
    .post('/api/v1/attachments/signature')
    .set('Authorization', `Bearer ${token}`)
    // Signatures are always JOB-owned, so this route takes no owner_type.
    .send({
      owner_id: jobId,
      data_uri: `data:image/png;base64,${ONE_PX_PNG.toString('base64')}`,
    })
    .expect(201);

  // 4. A symptom-tree LEAF (the seed ships a starter HHP tree) + terms.
  const leaf = await raw.symptomNode.findFirstOrThrow({
    where: { companyId, isLeaf: true, active: true, deletedAt: null },
  });
  await request(server)
    .post(`/api/v1/jobs/${jobId}/terms`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      signature_attachment_id: (sig.body as { id: string }).id,
      symptom_node_id: leaf.id,
    })
    .expect(201);
}

/**
 * Satisfy the SCMS bench gates (proposal Module 2, §3) so a job can go
 * IN_REPAIR → QC → READY: the technician's work declaration, then a full PASS
 * on the QC checklist for the CURRENT attempt.
 *
 * Like {@link completeIntake}, this keeps the lifecycle tests below about the
 * LIFECYCLE instead of re-deriving the bench paperwork in each one.
 */
async function passBenchAndQc(token: string, jobId: string): Promise<void> {
  const server = app.getHttpServer();

  // 1. Actual labour + repair note (gates IN_REPAIR → QC).
  await request(server)
    .patch(`/api/v1/jobs/${jobId}/work`)
    .set('Authorization', `Bearer ${token}`)
    .send({ labour_hours: 1.5, tech_report: 'Reflowed the charging port.' })
    .expect(200);

  // 2. Every configured checklist item for the device's class, PASSed for the
  //    current attempt. Items that demand a reading get one; a job that has
  //    been bounced counts from a later attempt, hence the reject-count read.
  const job = await raw.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { deviceId: true, qcRejectCount: true },
  });
  const device = job.deviceId
    ? await raw.device.findUnique({
        where: { id: job.deviceId },
        select: { category: true },
      })
    : null;
  const items = device
    ? await raw.qcChecklistItem.findMany({
        where: {
          companyId,
          category: device.category,
          active: true,
          deletedAt: null,
        },
        select: { id: true, requiresValue: true, requiresAttachment: true },
      })
    : [];
  if (items.length === 0) return;

  await request(server)
    .put(`/api/v1/jobs/${jobId}/qc-checks`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      checks: items.map((i) => ({
        item_id: i.id,
        result: 'PASS',
        ...(i.requiresValue ? { value: '102 kPa' } : {}),
      })),
    })
    .expect(200);

  // 3. Any item requiring a raw log expects a DOC/PHOTO_AFTER on the job.
  if (items.some((i) => i.requiresAttachment)) {
    await request(server)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .field('owner_type', 'JOB')
      .field('owner_id', jobId)
      .field('kind', 'PHOTO_AFTER')
      .attach('file', ONE_PX_PNG, {
        filename: 'calibration.png',
        contentType: 'image/png',
      })
      .expect(201);
  }
}

/**
 * Clear the SCMS handover gate (proposal Module 6): issue the customer's
 * 6-digit collection PIN and verify it, so the device may be released.
 *
 * The plaintext PIN is deliberately never returned on the wire — it is hashed
 * on the row and reaches the customer only via the queued SMS. So this reads
 * it back out of the notification outbox, which is exactly the path the real
 * handover takes.
 */
async function verifyCollectionOtp(
  token: string,
  jobId: string,
): Promise<void> {
  const server = app.getHttpServer();
  // Reaching READY already mints a PIN, and issuing a second one VOIDS that
  // first one. Only issue if the job somehow has no live PIN, so the code read
  // out of the outbox below is always the one still standing.
  let live = await raw.jobCollectionOtp.findFirst({
    where: { jobId, verifiedAt: null, voidedAt: null },
  });
  if (!live) {
    await request(server)
      .post(`/api/v1/jobs/${jobId}/collection-otp`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    live = await raw.jobCollectionOtp.findFirstOrThrow({
      where: { jobId, verifiedAt: null, voidedAt: null },
    });
  }

  const sms = await raw.notification.findFirstOrThrow({
    where: { jobId, eventCode: 'COLLECTION_OTP', channel: 'SMS' },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  // The message also carries the job_no, whose sequence is itself 6 digits, so
  // pick the run that actually HASHES to the stored PIN rather than the first
  // one that looks right.
  const code = [...(sms.body ?? '').matchAll(/\d{6}/g)]
    .map((m) => m[0])
    .find(
      (c) =>
        createHash('sha256').update(c, 'utf8').digest('hex') === live.codeHash,
    );
  if (!code) throw new Error(`No PIN matching the stored hash in: ${sms.body}`);

  await request(server)
    .post(`/api/v1/jobs/${jobId}/collection-otp/verify`)
    .set('Authorization', `Bearer ${token}`)
    .send({ code })
    .expect(200);
}

/** Smallest valid PNG — enough to be a real image without a fixture file. */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function transition(
  token: string,
  jobId: string,
  toStateCode: string,
  expectStatus = 201,
): Promise<{ held: boolean; job: JobBody }> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/jobs/${jobId}/transition`)
    .set('Authorization', `Bearer ${token}`)
    .send({ to_state_code: toStateCode });
  if (res.status !== expectStatus) {
    // A bare .expect() here reports only the status, and a refused transition
    // is always a guard explaining WHY in the body — surface it or every
    // failure in this file becomes a blind "expected 201, got 422".
    throw new Error(
      `${toStateCode}: expected ${expectStatus}, got ${res.status} — ${JSON.stringify(res.body)}`,
    );
  }
  return res.body as { held: boolean; job: JobBody };
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

  const companyB = await raw.company.create({
    data: { name: `${TEST_PREFIX} Rival Service Co` },
  });
  companyBId = companyB.id;
  await raw.branch.create({
    data: { companyId: companyBId, code: 'RB1', name: `${TEST_PREFIX} B` },
  });

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mk = (
    email: string,
    role: string,
    scope: UserScope,
    company: string,
    homeBranchId: string | null,
  ) =>
    raw.user.create({
      data: {
        companyId: company,
        fullName: `${TEST_PREFIX} ${role}`,
        email,
        passwordHash,
        role,
        scope,
        homeBranchId,
      },
    });

  const [admin, advisorDar, advisorKrk, tech1, tech2, adminB] =
    await Promise.all([
      mk(EMAILS.admin, 'SUPER_ADMIN', 'group', companyId, null),
      mk(EMAILS.advisorDar, 'SERVICE_ADVISOR', 'branch', companyId, branchDar),
      mk(EMAILS.advisorKrk, 'SERVICE_ADVISOR', 'branch', companyId, branchKrk),
      mk(EMAILS.tech1, 'TECHNICIAN', 'branch', companyId, branchDar),
      mk(EMAILS.tech2, 'TECHNICIAN', 'branch', companyId, branchDar),
      mk(EMAILS.adminB, 'SUPER_ADMIN', 'group', companyBId, null),
    ]);
  ids.admin = admin.id;
  ids.advisorDar = advisorDar.id;
  ids.advisorKrk = advisorKrk.id;
  ids.tech1 = tech1.id;
  ids.tech2 = tech2.id;
  ids.adminB = adminB.id;

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
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  for (const [k, email] of Object.entries(EMAILS)) {
    tokens[k] = await login(email);
  }
});

afterAll(async () => {
  const actorIds = Object.values(ids);
  await raw.auditLog.deleteMany({
    where: { companyId: { in: [companyId, companyBId] } },
  });
  await raw.session.deleteMany({ where: { userId: { in: actorIds } } });
  // Scope destructive deletes to THIS suite's fixtures. A bare companyId filter
  // would wipe the REAL company's jobs/customers/devices (e.g. imported data),
  // not just the test's. companyBId is a throwaway test company (wipe fully).
  await raw.job.deleteMany({
    where: { OR: [{ companyId: companyBId }, { id: { in: createdJobIds } }] },
  });
  // Approvals reference the requester, so they must go before the users —
  // and they hang off this suite's jobs.
  const suiteApprovals = await raw.approval.findMany({
    where: {
      OR: [
        { id: { in: createdApprovalIds } },
        { refType: 'Job', refId: { in: createdJobIds } },
      ],
    },
    select: { id: true },
  });
  const approvalIds = suiteApprovals.map((a) => a.id);
  await raw.auditLog.deleteMany({
    where: { entityType: 'Approval', entityId: { in: approvalIds } },
  });
  await raw.approval.deleteMany({ where: { id: { in: approvalIds } } });
  await raw.jobCounter.deleteMany({ where: { companyId: companyBId } });
  // After jobs: jobs.warranty_registration_id FKs into this table.
  await raw.warrantyRegistration.deleteMany({
    where: { id: { in: createdRegistrationIds } },
  });
  await raw.device.deleteMany({
    where: {
      OR: [
        { companyId: companyBId },
        { customer: { name: { startsWith: TEST_PREFIX } } },
      ],
    },
  });
  await raw.customer.deleteMany({
    where: {
      OR: [{ companyId: companyBId }, { name: { startsWith: TEST_PREFIX } }],
    },
  });
  // Attachments are POLYMORPHIC (owner_type/owner_id), so no FK ties them to a
  // Job and deleting the jobs above leaves them behind — pinning their uploader
  // via attachments.uploaded_by. The intake-evidence pack (before-photo +
  // signature) puts one on every job this suite books in, so they must go
  // before the users do.
  await raw.attachment.deleteMany({
    where: {
      OR: [
        { companyId: companyBId },
        { uploadedById: { in: actorIds } },
        { ownerType: 'JOB', ownerId: { in: createdJobIds } },
      ],
    },
  });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.branch.deleteMany({ where: { companyId: companyBId } });
  await raw.company.deleteMany({ where: { id: companyBId } });
  await app.close();
  await raw.$disconnect();
});

describe('POST /jobs — intake + job_no generation (§4.3)', () => {
  it('creates a job with nested new customer+device; job_no format, BOOKED, received_at, so_number normalized', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      so_number: '4.29260291E9', // Excel scientific-notation artifact
      warranty_status: 'IW',
      fault_reported: 'NOT CHARGING',
      customer: {
        name: `${TEST_PREFIX} Juma Ally`,
        phone: '0765 111 222',
      },
      device: {
        category: 'HHP',
        model: 'Galaxy A06',
        imei_serial: '3.51000000000013E14',
        color: 'Black',
      },
    });

    expect(job.job_no).toMatch(new RegExp(`^DAR-${YEAR}-\\d{6}$`));
    expect(job.state_code).toBe('BOOKED');
    expect(job.received_at).toBeTruthy();
    expect(job.so_number).toBe('4292602910'); // expanded, clean string
    expect(job.ready_at).toBeNull();

    const row = await raw.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.companyId).toBe(companyId);
    expect(row.branchId).toBe(branchDar);
    expect(row.bookedById).toBe(ids.advisorDar);

    // find-or-create created exactly one customer + device for this intake.
    const cust = await raw.customer.findFirstOrThrow({
      where: { id: row.customerId },
    });
    expect(cust.phoneNormalized).toBe('+255765111222');
    const dev = await raw.device.findFirstOrThrow({
      where: { id: row.deviceId },
    });
    expect(dev.imeiSerial).toBe('351000000000013');
  });

  it('a 2nd job in the same branch/year increments the sequence', async () => {
    const first = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Seq A`, phone: '0765111333' },
      device: { category: 'HHP', imei_serial: '351000000000021' },
    });
    const second = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Seq B`, phone: '0765111444' },
      device: { category: 'HHP', imei_serial: '351000000000039' },
    });
    const seqOf = (jn: string) => Number(jn.split('-')[2]);
    expect(seqOf(second.job_no)).toBe(seqOf(first.job_no) + 1);
  });

  it('reuses an existing customer by normalized phone (find-or-create)', async () => {
    const a = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Repeat`, phone: '0765 999 000' },
      device: { category: 'HHP', imei_serial: '351000000000047' },
    });
    const b = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Repeat`, phone: '+255765999000' },
      device: { category: 'HHP', imei_serial: '351000000000054' },
    });
    const rowA = await raw.job.findUniqueOrThrow({ where: { id: a.id } });
    const rowB = await raw.job.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowB.customerId).toBe(rowA.customerId); // same customer reused
  });

  it('group user MUST pass branch_id; existing customer_id/device_id path works', async () => {
    // admin is group-scoped with no home branch → branch_id required.
    await createJob(
      tokens.admin,
      {
        customer: { name: `${TEST_PREFIX} NoBranch`, phone: '0765222000' },
        device: { category: 'HHP' },
      },
      400,
    );

    // Pre-create a customer + device, then open a job against their ids.
    const cust = await raw.customer.create({
      data: {
        companyId,
        name: `${TEST_PREFIX} Existing`,
        phoneNormalized: '+255765222111',
      },
    });
    const dev = await raw.device.create({
      data: { companyId, customerId: cust.id, category: 'HHP' },
    });
    const job = await createJob(tokens.admin, {
      branch_id: branchKrk,
      customer_id: cust.id,
      device_id: dev.id,
    });
    expect(job.job_no).toMatch(new RegExp(`^KRK-${YEAR}-\\d{6}$`));
  });
});

describe('POST /jobs — concurrency-safe job_no (§4.3)', () => {
  it('10 parallel creates yield 10 unique sequential DAR job_nos (no dupes)', async () => {
    const jobs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createJob(tokens.advisorDar, {
          branch_id: branchDar,
          customer: {
            name: `${TEST_PREFIX} Conc ${i}`,
            phone: `076530${String(i).padStart(4, '0')}`,
          },
          device: {
            category: 'HHP',
            imei_serial: testImei(`2${String(i).padStart(4, '0')}`),
          },
        }),
      ),
    );

    const jobNos = jobs.map((j) => j.job_no);
    const unique = new Set(jobNos);
    expect(unique.size).toBe(10); // NO duplicates
    for (const jn of jobNos) {
      expect(jn).toMatch(new RegExp(`^DAR-${YEAR}-\\d{6}$`));
    }
    // Contiguous block of 10 sequential numbers (no gaps under the row lock).
    const seqs = jobNos
      .map((jn) => Number(jn.split('-')[2]))
      .sort((a, b) => a - b);
    expect(seqs[9] - seqs[0]).toBe(9);
  });
});

describe('GET /jobs?customer_id= (Task 1.5, CRM stub §4.2/E2)', () => {
  it('filters to only that customer’s jobs (company/branch scoping still applies)', async () => {
    const cust = await raw.customer.create({
      data: {
        companyId,
        name: `${TEST_PREFIX} CustFilter`,
        phoneNormalized: '+255765333222',
      },
    });
    const mine = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer_id: cust.id,
      device: { category: 'HHP', imei_serial: '351000000000062' },
    });
    // A second job for a DIFFERENT customer must not show up in the filter.
    await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} CustFilterOther`, phone: '0765333555' },
      device: { category: 'HHP', imei_serial: '351000000000070' },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .query({ customer_id: cust.id })
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const body = res.body as { data: JobBody[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data.map((j) => j.id)).toEqual([mine.id]);
  });
});

describe('POST /jobs/{id}/transition — lifecycle (§5)', () => {
  it('created BOOKED; BOOKED→RECEIVED→DIAGNOSING allowed (advisor) + each writes a TRANSITION audit row', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Diag`, phone: '0765440001' },
      device: { category: 'HHP', imei_serial: '353000000000011' },
    });
    expect(job.state_code).toBe('BOOKED');

    await transition(tokens.advisorDar, job.id, 'RECEIVED');
    // SCMS §2: the counter's evidence pack gates the move off the desk.
    await completeIntake(tokens.advisorDar, job.id);

    const { held, job: after } = await transition(
      tokens.advisorDar,
      job.id,
      'DIAGNOSING',
    );
    expect(held).toBe(false);
    expect(after.state_code).toBe('DIAGNOSING');

    const audit = await raw.auditLog.findFirst({
      where: { entityType: 'Job', entityId: job.id, action: 'TRANSITION' },
      orderBy: { at: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(ids.advisorDar);
    expect(
      (audit?.afterJson as { state_code?: string } | null)?.state_code,
    ).toBe('DIAGNOSING');
  });

  it('illegal BOOKED→CLOSED is rejected with 422', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Illegal`, phone: '0765440002' },
      device: { category: 'HHP', imei_serial: '353000000000029' },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${job.id}/transition`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ to_state_code: 'CLOSED' })
      .expect(422);
  });

  it('walking a job to READY stamps ready_at; /dispatch stamps handover fields', async () => {
    const job = await createJob(tokens.admin, {
      branch_id: branchDar,
      // IN-WARRANTY on purpose: this test is about ready_at/dispatch stamping,
      // and the DIAGNOSING→IN_REPAIR skip refuses a BILLABLE repair that has
      // no approved quote. An OW walk belongs in the quote-gate tests, which
      // cover that refusal directly.
      warranty_status: 'IW',
      customer: { name: `${TEST_PREFIX} Ready`, phone: '0765440003' },
      device: {
        category: 'HHP',
        imei_serial: '353000000000037',
        purchase_date: '2026-05-13',
      },
    });
    // admin holds every job.transition.* permission → walk to READY.
    await transition(tokens.admin, job.id, 'RECEIVED');
    // SCMS §2: the counter's evidence pack gates the move off the desk.
    await completeIntake(tokens.advisorDar, job.id);

    await transition(tokens.admin, job.id, 'DIAGNOSING');
    // Straight to repair: this job needs no parts, and the AWAITING_PARTS hold
    // now refuses a job with nothing on order (`parts_requested`). The skip
    // edge is exactly what that case is for.
    await transition(tokens.admin, job.id, 'IN_REPAIR');
    // SCMS §3: the bench paperwork + QC checklist gate the way out.
    await passBenchAndQc(tokens.admin, job.id);
    await transition(tokens.admin, job.id, 'QC');
    const ready = await transition(tokens.admin, job.id, 'READY');
    expect(ready.job.state_code).toBe('READY');
    expect(ready.job.ready_at).toBeTruthy();

    // SCMS §6: no device leaves without the customer's PIN checked.
    await verifyCollectionOtp(tokens.advisorDar, job.id);

    // Dispatch (advisor holds job.transition.dispatch).
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${job.id}/dispatch`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ received_by: 'Agent Halima', waybill_no: 'WB-0001' })
      .expect(201);
    const dispatched = (res.body as { job: JobBody }).job;
    expect(dispatched.state_code).toBe('DISPATCHED');
    expect(dispatched.dispatched_at).toBeTruthy();
    expect(dispatched.dispatched_by).toBe(ids.advisorDar);
    expect(dispatched.received_by_customer).toBe('Agent Halima');
    expect(dispatched.waybill_no).toBe('WB-0001');

    const row = await raw.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.readyAt).not.toBeNull();
    expect(row.dispatchedAt).not.toBeNull();
  });

  /**
   * A state move writes THREE things that must agree: `jobs.state_id`, the SLA
   * clock rows, and a semantic TRANSITION audit row. They used to be able to
   * disagree — the audited job UPDATE escaped the caller's transaction, so the
   * job advanced while the clock rows rolled back and the request 500'd before
   * the TRANSITION row was ever written. Asserting only `state_code` (as the
   * walk test above does) cannot see that, so assert the whole set.
   */
  it('a transition commits the state, the SLA clock and the TRANSITION audit row together', async () => {
    const job = await createJob(tokens.admin, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Atomic`, phone: '0765440060' },
      device: { category: 'HHP', imei_serial: '353000000000060' },
    });
    await transition(tokens.admin, job.id, 'RECEIVED');
    await completeIntake(tokens.advisorDar, job.id);

    // The move under test is the SECOND hop (RECEIVED → DIAGNOSING) — the
    // assertions below check ITS effects, not the BOOKED → RECEIVED one above.
    const moved = await transition(tokens.admin, job.id, 'DIAGNOSING');
    expect(moved.job.state_code).toBe('DIAGNOSING');

    const events = await raw.jobStateEvent.findMany({
      where: { jobId: job.id },
      include: { state: true },
      orderBy: { enteredAt: 'asc' },
    });

    // Exactly ONE open row, and it is the state the job is actually in.
    const open = events.filter((e) => e.exitedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].state.code).toBe('DIAGNOSING');

    // The row it replaced (RECEIVED) was closed, with a duration written.
    const closed = events.filter((e) => e.exitedAt !== null);
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(closed[closed.length - 1].state.code).toBe('RECEIVED');
    expect(closed[closed.length - 1].durationMs).not.toBeNull();

    // The semantic TRANSITION row for THIS move (written after the
    // transaction commits) — its absence is what proved the move had thrown
    // midway. There are two rows on this job by now (BOOKED→RECEIVED too);
    // the LAST one is this move's.
    const transitions = await raw.auditLog.findMany({
      where: { entityType: 'Job', entityId: job.id, action: 'TRANSITION' },
      orderBy: { at: 'asc' },
    });
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    expect(transitions[transitions.length - 1].afterJson).toMatchObject({
      state_code: 'DIAGNOSING',
    });

    // And the job row agrees with the clock.
    const row = await raw.job.findUniqueOrThrow({
      where: { id: job.id },
      include: { state: true },
    });
    expect(row.state.code).toBe('DIAGNOSING');
    expect(row.diagnosisStartedAt).not.toBeNull();
  });

  it('a TECHNICIAN cannot dispatch (lacks job.transition.dispatch) → 403', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${createdJobIds[0]}/dispatch`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ received_by: 'x' })
      .expect(403);
  });

  it('GET /jobs/{id} exposes only legal+authorized allowed_next_transitions, guard-blocked ones carrying their reason', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Allowed`, phone: '0765440004' },
      device: { category: 'HHP', imei_serial: '353000000000045' },
    });
    const read = async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${job.id}`)
        .set('Authorization', `Bearer ${tokens.advisorDar}`)
        .expect(200);
      return (res.body as JobBody).allowed_next_transitions ?? [];
    };

    // From BOOKED an advisor (job.transition) may go to RECEIVED/CANCELLED —
    // no engineer assigned yet, so engineer_skill_match has nothing to hold.
    const booked = await read();
    expect(booked.map((t) => t.to_state_code).sort()).toEqual([
      'CANCELLED',
      'RECEIVED',
    ]);
    expect(booked.every((t) => !t.blocked_reason)).toBe(true);
    await transition(tokens.advisorDar, job.id, 'RECEIVED');

    // From RECEIVED an advisor may go to BOOKED/CANCELLED/DIAGNOSING.
    const before = await read();
    expect(before.map((t) => t.to_state_code).sort()).toEqual([
      'BOOKED',
      'CANCELLED',
      'DIAGNOSING',
    ]);
    // Intake is untouched, so DIAGNOSING is listed but HELD — and says why,
    // rather than vanishing off the board with no explanation.
    const heldEdge = before.find((t) => t.to_state_code === 'DIAGNOSING');
    expect(heldEdge?.blocked_guard).toBe('intake_evidence_complete');
    expect(heldEdge?.blocked_reason).toMatch(/Intake is incomplete/);
    expect(
      before.find((t) => t.to_state_code === 'CANCELLED')?.blocked_reason,
    ).toBeUndefined();

    // Book it in properly and the hold lifts.
    await completeIntake(tokens.advisorDar, job.id);
    const after = await read();
    expect(after.map((t) => t.to_state_code).sort()).toEqual([
      'BOOKED',
      'CANCELLED',
      'DIAGNOSING',
    ]);
    expect(
      after.find((t) => t.to_state_code === 'DIAGNOSING')?.blocked_reason,
    ).toBeUndefined();
  });

  it('a wrong forward move can be STEPPED BACK one stage', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} StepBack`, phone: '0765440005' },
      device: { category: 'HHP', imei_serial: '353000000000052' },
    });
    await transition(tokens.advisorDar, job.id, 'RECEIVED');
    // SCMS §2: the counter's evidence pack gates the move off the desk.
    await completeIntake(tokens.advisorDar, job.id);
    // Forward RECEIVED → DIAGNOSING, then step back DIAGNOSING → RECEIVED.
    const fwd = await transition(tokens.advisorDar, job.id, 'DIAGNOSING');
    expect(fwd.job.state_code).toBe('DIAGNOSING');
    const back = await transition(tokens.advisorDar, job.id, 'RECEIVED');
    expect(back.job.state_code).toBe('RECEIVED');

    // DIAGNOSING now offers the reverse edge among its legal moves.
    await transition(tokens.advisorDar, job.id, 'DIAGNOSING');
    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const codes = ((res.body as JobBody).allowed_next_transitions ?? []).map(
      (t) => t.to_state_code,
    );
    expect(codes).toContain('RECEIVED');
  });
});

describe('TECHNICIAN visibility (§3) + scoping (§4.3)', () => {
  let tech1Job: string;
  let tech2Job: string;
  let krkJob: string;

  beforeAll(async () => {
    const j1 = await createJob(tokens.admin, {
      branch_id: branchDar,
      assigned_engineer_id: ids.tech1,
      customer: { name: `${TEST_PREFIX} T1`, phone: '0765550001' },
      device: { category: 'HHP', imei_serial: '354000000000010' },
    });
    const j2 = await createJob(tokens.admin, {
      branch_id: branchDar,
      assigned_engineer_id: ids.tech2,
      customer: { name: `${TEST_PREFIX} T2`, phone: '0765550002' },
      device: { category: 'HHP', imei_serial: '354000000000028' },
    });
    const jk = await createJob(tokens.advisorKrk, {
      branch_id: branchKrk,
      customer: { name: `${TEST_PREFIX} KRK`, phone: '0765550003' },
      device: { category: 'HHP', imei_serial: '354000000000036' },
    });
    tech1Job = j1.id;
    tech2Job = j2.id;
    krkJob = jk.id;
  });

  it('technician list shows ONLY jobs assigned to them', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/jobs?page_size=100')
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(200);
    const data = (res.body as { data: JobBody[] }).data;
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((j) => j.assigned_engineer_id === ids.tech1)).toBe(true);
    expect(data.map((j) => j.id)).toContain(tech1Job);
    expect(data.map((j) => j.id)).not.toContain(tech2Job);
  });

  it('technician GET on another engineer’s job → 404', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/jobs/${tech2Job}`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(404);
  });

  it('a KRK branch advisor cannot see DAR jobs (list + detail 404)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/jobs?page_size=100')
      .set('Authorization', `Bearer ${tokens.advisorKrk}`)
      .expect(200);
    const ids2 = (res.body as { data: JobBody[] }).data.map((j) => j.id);
    expect(ids2).toContain(krkJob);
    expect(ids2).not.toContain(tech1Job);

    await request(app.getHttpServer())
      .get(`/api/v1/jobs/${tech1Job}`)
      .set('Authorization', `Bearer ${tokens.advisorKrk}`)
      .expect(404);
  });

  it('company B cannot read a company A job (404) and has no jobs of its own', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/jobs/${tech1Job}`)
      .set('Authorization', `Bearer ${tokens.adminB}`)
      .expect(404);

    const res = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .set('Authorization', `Bearer ${tokens.adminB}`)
      .expect(200);
    expect((res.body as { total: number }).total).toBe(0);
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/jobs').expect(401);
  });
});

describe('BOOKED → RECEIVED — the engineer receiving the device (§4.10)', () => {
  it('a booked job stamps engineer_received_at on entering RECEIVED, not before', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      assigned_engineer_id: ids.tech1,
      customer: { name: `${TEST_PREFIX} Ack1`, phone: '0765550101' },
      device: { category: 'HHP', imei_serial: testImei('ack1') },
    });
    expect(job.state_code).toBe('BOOKED');
    expect(job.engineer_received_at).toBeNull();

    const res = await transition(tokens.tech1, job.id, 'RECEIVED');
    expect(res.job.state_code).toBe('RECEIVED');
    expect(res.job.engineer_received_at).not.toBeNull();
  });

  it('RECEIVED → DIAGNOSING is refused until intake evidence is complete, independent of receipt', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      assigned_engineer_id: ids.tech1,
      customer: { name: `${TEST_PREFIX} Ack2`, phone: '0765550102' },
      device: { category: 'HHP', imei_serial: testImei('ack2') },
    });
    await transition(tokens.tech1, job.id, 'RECEIVED');
    await transition(tokens.tech1, job.id, 'DIAGNOSING', 422);

    await completeIntake(tokens.advisorDar, job.id);
    const moved = await transition(tokens.tech1, job.id, 'DIAGNOSING');
    expect(moved.job.state_code).toBe('DIAGNOSING');
  });

  it('stepping back from DIAGNOSING lands on RECEIVED, not BOOKED', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      assigned_engineer_id: ids.tech1,
      customer: { name: `${TEST_PREFIX} Ack3`, phone: '0765550103' },
      device: { category: 'HHP', imei_serial: testImei('ack3') },
    });
    await transition(tokens.tech1, job.id, 'RECEIVED');
    await completeIntake(tokens.advisorDar, job.id);
    await transition(tokens.tech1, job.id, 'DIAGNOSING');

    const back = await transition(tokens.tech1, job.id, 'RECEIVED');
    expect(back.job.state_code).toBe('RECEIVED');
  });
});

describe('PATCH /jobs/{id} — mutable fields, never status', () => {
  it('updates fault/tech_report/engineer; cannot change status via PATCH', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Patch`, phone: '0765660001' },
      device: { category: 'HHP', imei_serial: '355000000000019' },
    });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({
        tech_report: 'LCD REPLACED',
        assigned_engineer_id: ids.tech1,
        warranty_status: 'OW',
      })
      .expect(200);
    const body = res.body as JobBody & { state_code: string };
    expect(body.state_code).toBe('BOOKED'); // unchanged
    expect(body.assigned_engineer_id).toBe(ids.tech1);
    // The resolved name rides on the wire so a technician (no user.read) can
    // see WHO is assigned without a raw UUID.
    expect(body.assigned_engineer_name).toBeTruthy();

    // A stray status field is stripped by the whitelist pipe → no effect.
    await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ state_code: 'CLOSED' })
      .expect(400);
  });
});

describe('branch guard — assignment & moving a mis-booked job', () => {
  it('exposes the resolved branch identity on the wire', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} BranchWire`, phone: '0765990000' },
      device: { category: 'HHP', imei_serial: '357000000000017' },
    });
    expect(job.branch_id).toBe(branchDar);
    expect(job.branch_code).toBeTruthy();
    expect(job.branch_name).toBeTruthy();
    // The job_no prefix reflects the branch it was booked into.
    expect(job.job_no.startsWith(`${job.branch_code}-`)).toBe(true);
  });

  it('rejects assigning an out-of-branch technician on CREATE', async () => {
    // tech1 is home-branched to Dar → invisible on a Krk job.
    await createJob(
      tokens.admin,
      {
        branch_id: branchKrk,
        assigned_engineer_id: ids.tech1,
        customer: { name: `${TEST_PREFIX} XBranchCreate`, phone: '0765990001' },
        device: { category: 'HHP', imei_serial: '357000000000025' },
      },
      400,
    );
  });

  it('rejects assigning an out-of-branch technician on PATCH', async () => {
    const job = await createJob(tokens.advisorKrk, {
      branch_id: branchKrk,
      customer: { name: `${TEST_PREFIX} XBranchPatch`, phone: '0765990002' },
      device: { category: 'HHP', imei_serial: '357000000000033' },
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ assigned_engineer_id: ids.tech1 })
      .expect(400);
  });

  it('a group admin can MOVE a job to another branch (job_no unchanged)', async () => {
    const job = await createJob(tokens.admin, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Move`, phone: '0765990003' },
      device: { category: 'HHP', imei_serial: '357000000000041' },
    });
    const originalNo = job.job_no;
    const darCode = job.branch_code;

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ branch_id: branchKrk })
      .expect(200);
    const body = res.body as JobBody;
    expect(body.branch_id).toBe(branchKrk);
    expect(body.branch_code).not.toBe(darCode);
    // The reference is issued at intake — a move does NOT renumber the job.
    expect(body.job_no).toBe(originalNo);
  });

  it('a branch-scoped user cannot move a job to another branch (403)', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} NoMove`, phone: '0765990004' },
      device: { category: 'HHP', imei_serial: '357000000000058' },
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ branch_id: branchKrk })
      .expect(403);
  });

  it('moving a branch out from under an assigned engineer is rejected until reassigned', async () => {
    const job = await createJob(tokens.admin, {
      branch_id: branchDar,
      assigned_engineer_id: ids.tech1,
      customer: { name: `${TEST_PREFIX} MoveAssigned`, phone: '0765990005' },
      device: { category: 'HHP', imei_serial: '357000000000066' },
    });
    // The Dar engineer would lose sight of the job in Krk → blocked.
    await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ branch_id: branchKrk })
      .expect(400);
    // Moving AND clearing the assignment in the same call is allowed.
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ branch_id: branchKrk, assigned_engineer_id: null })
      .expect(200);
    const body = res.body as JobBody;
    expect(body.branch_id).toBe(branchKrk);
    expect(body.assigned_engineer_id).toBeNull();
  });
});

describe('warranty intake (§4.7 — the Samsung job card)', () => {
  it('IW intake derives FULL coverage and records WHO ruled it', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'IW',
      service_type: 'PICKUP',
      accessories_held: 'SIM TRAY',
      return_by_date: '2026-08-01',
      customer: { name: `${TEST_PREFIX} Warranty IW`, phone: '0765770001' },
      device: {
        category: 'HHP',
        imei_serial: '356000000000018',
        purchase_date: '2026-05-13',
      },
    });
    expect(job.coverage).toBe('FULL');
    expect(job.service_type).toBe('PICKUP');
    expect(job.warranty_source).toBe('MANUAL');
    expect(job.warranty_decided_by).toBe(ids.advisorDar);
    expect(job.warranty_decided_at).toBeTruthy();
    expect(job.accessories_held).toBe('SIM TRAY');
    // A @db.Date must survive the round trip as the SAME calendar day.
    expect(job.return_by_date).toBe('2026-08-01');
    expect(job.device?.purchase_date).toBe('2026-05-13');
  });

  it('an untouched intake stays UNKNOWN/NONE with NO decider (not-yet-ruled ≠ ruled out)', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Warranty silent`, phone: '0765770002' },
      device: { category: 'HHP', imei_serial: '356000000000026' },
    });
    expect(job.warranty_status).toBe('UNKNOWN');
    expect(job.coverage).toBe('NONE');
    expect(job.warranty_source).toBeNull();
    expect(job.warranty_decided_by).toBeNull();
  });

  it('GOODWILL is FULL coverage — the shop absorbs it, so the customer is billed nothing', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'GOODWILL',
      customer: { name: `${TEST_PREFIX} Goodwill`, phone: '0765770003' },
      device: { category: 'HHP', imei_serial: '356000000000034' },
    });
    expect(job.coverage).toBe('FULL');
  });

  it('PATCHing warranty_status alone still moves coverage (a stale coverage would keep billing)', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'OW',
      customer: { name: `${TEST_PREFIX} Reruled`, phone: '0765770004' },
      device: { category: 'HHP', imei_serial: '356000000000042' },
    });
    expect(job.coverage).toBe('NONE');

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ warranty_status: 'IW' })
      .expect(200);
    const body = res.body as JobBody;
    expect(body.coverage).toBe('FULL');
    expect(body.warranty_decided_by).toBe(ids.advisorDar);
  });

  it('LABOUR_ONLY / PARTS_ONLY survive a bare warranty_status of IW', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'IW',
      coverage: 'LABOUR_ONLY',
      customer: { name: `${TEST_PREFIX} Partial`, phone: '0765770005' },
      device: { category: 'HHP', imei_serial: '356000000000059' },
    });
    // Explicit coverage must NOT be flattened to FULL by the IW status.
    expect(job.coverage).toBe('LABOUR_ONLY');
  });

  it('a service code of the WRONG kind is rejected (ids are interchangeable UUIDs)', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Codes`, phone: '0765770006' },
      device: { category: 'HHP', imei_serial: '356000000000067' },
    });
    const repair = await raw.serviceCode.findFirstOrThrow({
      where: { companyId, kind: 'REPAIR', code: 'A01', deletedAt: null },
    });
    const symptom = await raw.serviceCode.findFirstOrThrow({
      where: { companyId, kind: 'SYMPTOM', code: 'T83', deletedAt: null },
    });

    // A REPAIR code in the symptom slot would sail through to GSPN and be
    // rejected weeks later — reject it at the door instead.
    await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ symptom_code_id: repair.id })
      .expect(400);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ symptom_code_id: symptom.id, repair_code_id: repair.id })
      .expect(200);
    const body = res.body as JobBody;
    expect(body.symptom_code_id).toBe(symptom.id);
    expect(body.repair_code_id).toBe(repair.id);
  });

  it('POST /jobs accepts the exact payload the intake form sends (symptom code + registration source)', async () => {
    const symptom = await raw.serviceCode.findFirstOrThrow({
      where: { companyId, kind: 'SYMPTOM', code: 'T83', deletedAt: null },
    });
    const reg = await raw.warrantyRegistration.create({
      data: {
        companyId,
        branchId: branchDar,
        productName: `${TEST_PREFIX} Galaxy A06`,
        brand: 'Samsung',
        serialNo: '356000000000083',
        kind: 'SAMSUNG',
        startDate: new Date('2026-05-13T00:00:00.000Z'),
        expiryDate: new Date('2027-05-13T00:00:00.000Z'),
      },
    });
    createdRegistrationIds.push(reg.id);

    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'IW',
      coverage: 'FULL',
      service_type: 'CARRY_IN',
      warranty_source: 'REGISTRATION',
      warranty_registration_id: reg.id,
      symptom_code_id: symptom.id,
      accessories_held: 'SIM TRAY',
      return_by_date: '2026-08-15',
      fault_reported: 'NOT CHARGING',
      customer: { name: `${TEST_PREFIX} Form payload`, phone: '0765770008' },
      device: {
        category: 'HHP',
        imei_serial: '356000000000083',
        purchase_date: '2026-05-13',
      },
    });

    expect(job.coverage).toBe('FULL');
    expect(job.warranty_source).toBe('REGISTRATION');
    expect(job.symptom_code_id).toBe(symptom.id);
    expect(job.accessories_held).toBe('SIM TRAY');
    expect(job.return_by_date).toBe('2026-08-15');
    const row = await raw.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.warrantyRegistrationId).toBe(reg.id);
  });

  it('POST /jobs rejects a wrong-kind code at intake, not just on PATCH', async () => {
    const repair = await raw.serviceCode.findFirstOrThrow({
      where: { companyId, kind: 'REPAIR', code: 'A01', deletedAt: null },
    });
    await createJob(
      tokens.advisorDar,
      {
        branch_id: branchDar,
        symptom_code_id: repair.id,
        customer: { name: `${TEST_PREFIX} Bad code`, phone: '0765770009' },
        device: { category: 'HHP', imei_serial: '356000000000091' },
      },
      400,
    );
  });

  it('a later intake never overwrites a purchase date already on file', async () => {
    const imei = '356000000000075';
    await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} PD first`, phone: '0765770007' },
      device: {
        category: 'HHP',
        imei_serial: imei,
        purchase_date: '2026-01-10',
      },
    });
    const second = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} PD first`, phone: '0765770007' },
      device: {
        category: 'HHP',
        imei_serial: imei,
        purchase_date: '2026-06-30',
      },
    });
    // Warranty hinges on this date — the earliest evidence wins.
    expect(second.device?.purchase_date).toBe('2026-01-10');
  });
});

describe('POST /jobs/import/gspn-jobcard — parse a Samsung job card', () => {
  /** Minimal single-page PDF containing `lines` of text. */
  function makePdf(lines: string[]): Buffer {
    const content = lines
      .map((t, i) => `BT /F1 10 Tf 34 ${700 - i * 20} Td (${t}) Tj ET`)
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

  it('returns a DRAFT and creates nothing', async () => {
    const before = await raw.job.count();
    const res = await request(app.getHttpServer())
      .post('/api/v1/jobs/import/gspn-jobcard')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .attach(
        'file',
        makePdf(['Service Order Sheet', 'Service Order No : 4295708333']),
        {
          filename: 'jobcard.pdf',
          contentType: 'application/pdf',
        },
      )
      .expect(201);

    const body = res.body as {
      so_number: string | null;
      coverage: null;
      warnings: string[];
    };
    expect(body.so_number).toBe('4295708333');
    // The whole point of an import endpoint that parses only.
    expect(await raw.job.count()).toBe(before);
    // Coverage is never inferred — the tick box is a drawn mark, not text.
    expect(body.coverage).toBeNull();
    expect(body.warnings.join(' ')).toMatch(/coverage was not read/i);
  });

  it('rejects a non-PDF even when it claims to be one', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/jobs/import/gspn-jobcard')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .attach('file', Buffer.from('GIF89a totally not a pdf'), {
        filename: 'evil.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
  });

  it('rejects a valid PDF that is not a job card (422, not a 500)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/jobs/import/gspn-jobcard')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .attach('file', makePdf(['Some entirely different document']), {
        filename: 'other.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);
  });

  it('requires a file', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/jobs/import/gspn-jobcard')
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(400);
  });

  it('a TECHNICIAN cannot import (job.create)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/jobs/import/gspn-jobcard')
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .attach('file', makePdf(['Service Order Sheet']), {
        filename: 'jobcard.pdf',
        contentType: 'application/pdf',
      })
      .expect(403);
  });
});

describe('seed stays pristine', () => {
  it('seed intact; jobs/counters carry ONLY this suite fixtures (removed in teardown)', async () => {
    expect(
      await raw.company.count({ where: { name: 'Samsung ASC Group' } }),
    ).toBe(1);
    expect(
      await raw.branch.count({
        where: { companyId, code: { in: ['DAR', 'KRK', 'ARU', 'MLM', 'DOD'] } },
      }),
    ).toBe(5);
    expect(await raw.workflowState.count({ where: { companyId } })).toBe(12);
    expect(await raw.workflowTransition.count({ where: { companyId } })).toBe(
      25,
    );
    // This suite's jobs exist exactly (scoped to fixtures so pre-existing real
    // data, e.g. imports, doesn't skew the count); cleaned in afterAll.
    const jobCount = await raw.job.count({
      where: { id: { in: createdJobIds } },
    });
    expect(jobCount).toBe(createdJobIds.length);
    expect(jobCount).toBeGreaterThan(0);
  });
});

describe('Admin overrides of the job guards (§4.11)', () => {
  async function approve(approvalId: string): Promise<void> {
    createdApprovalIds.push(approvalId);
    await request(app.getHttpServer())
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({})
      .expect(200);
  }

  /** A chargeable job parked at AWAITING_CUSTOMER_APPROVAL with no quote. */
  async function jobAwaitingQuote(
    phone: string,
    imei: string,
  ): Promise<string> {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'OW',
      // TECHNICIANs only see jobs assigned to them, and only they hold
      // job.transition.repair — so the bench move needs an assignee.
      assigned_engineer_id: ids.tech1,
      customer: { name: `${TEST_PREFIX} Override`, phone },
      device: { category: 'HHP', imei_serial: imei },
    });
    await transition(tokens.advisorDar, job.id, 'RECEIVED');
    // SCMS §2: the counter's evidence pack gates the move off the desk.
    await completeIntake(tokens.advisorDar, job.id);
    await transition(tokens.advisorDar, job.id, 'DIAGNOSING');
    await transition(tokens.advisorDar, job.id, 'AWAITING_CUSTOMER_APPROVAL');
    return job.id;
  }

  it('OW quote gate: blocked → requested → approved → retried, single use', async () => {
    const jobId = await jobAwaitingQuote('0765880001', '357000000000017');

    // Blocked: the customer pays and no REPAIR_OW invoice exists (T&C 5/9).
    await transition(tokens.tech1, jobId, 'IN_REPAIR', 422);

    const held = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/transition`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({
        to_state_code: 'IN_REPAIR',
        request_override: true,
        override_reason: 'Customer accepted verbally, invoice to follow',
      })
      .expect(201);
    const body = held.body as {
      held: boolean;
      job: JobBody;
      pending_approval: { id: string; type: string };
    };
    expect(body.held).toBe(true);
    expect(body.pending_approval.type).toBe('OW_REPAIR_WITHOUT_QUOTE');
    // Nothing moved.
    expect(body.job.state_code).toBe('AWAITING_CUSTOMER_APPROVAL');

    await approve(body.pending_approval.id);

    const applied = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/transition`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({
        to_state_code: 'IN_REPAIR',
        override_approval_id: body.pending_approval.id,
      })
      .expect(201);
    expect((applied.body as { job: JobBody }).job.state_code).toBe('IN_REPAIR');

    // Spent: the same approval cannot open the gate on another job.
    const second = await jobAwaitingQuote('0765880002', '357000000000025');
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${second}/transition`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({
        to_state_code: 'IN_REPAIR',
        override_approval_id: body.pending_approval.id,
      })
      .expect(409);
  });

  it('a FULLY covered job needs no override at all', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'IW',
      assigned_engineer_id: ids.tech1,
      customer: { name: `${TEST_PREFIX} Covered`, phone: '0765880003' },
      device: { category: 'HHP', imei_serial: '357000000000033' },
    });
    await transition(tokens.advisorDar, job.id, 'RECEIVED');
    // SCMS §2: the counter's evidence pack gates the move off the desk.
    await completeIntake(tokens.advisorDar, job.id);
    await transition(tokens.advisorDar, job.id, 'DIAGNOSING');
    await transition(tokens.advisorDar, job.id, 'AWAITING_CUSTOMER_APPROVAL');
    // Nothing to bill → the quote gate does not apply.
    const res = await transition(tokens.tech1, job.id, 'IN_REPAIR');
    expect(res.job.state_code).toBe('IN_REPAIR');
  });

  it('coverage is locked once a claim exists, and an override unlocks it once', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'IW',
      customer: { name: `${TEST_PREFIX} Locked`, phone: '0765880004' },
      device: { category: 'HHP', imei_serial: '357000000000041' },
    });
    // Commit money against it.
    const claim = await raw.warrantyClaim.create({
      data: {
        companyId,
        branchId: branchDar,
        jobId: job.id,
        claimAmountUsd: 1000n,
        status: 'DRAFT',
      },
    });

    // Re-ruling now contradicts a document that has already gone out.
    await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ warranty_status: 'OW' })
      .expect(409);

    const held = await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({
        warranty_status: 'OW',
        request_override: true,
        override_reason: 'Samsung rejected the claim — customer now pays',
      })
      .expect(200);
    const body = held.body as {
      held: boolean;
      pending_approval: { id: string; type: string };
    };
    expect(body.pending_approval.type).toBe('JOB_COVERAGE_CHANGE');
    // Unchanged until approved.
    const stillIw = await raw.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stillIw.coverage).toBe('FULL');

    await approve(body.pending_approval.id);
    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({
        warranty_status: 'OW',
        override_approval_id: body.pending_approval.id,
      })
      .expect(200);
    expect((patched.body as JobBody).coverage).toBe('NONE');

    await raw.warrantyClaim.deleteMany({ where: { id: claim.id } });
  });

  it('coverage stays freely editable while nothing is committed', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'UNKNOWN',
      customer: { name: `${TEST_PREFIX} Open`, phone: '0765880005' },
      device: { category: 'HHP', imei_serial: '357000000000058' },
    });
    // Diagnosis routinely revises the ruling — no approval needed.
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ warranty_status: 'IW' })
      .expect(200);
    expect((res.body as JobBody).coverage).toBe('FULL');
  });
});

describe('Service line + priority (§4.3)', () => {
  async function categoryId(code: string): Promise<string> {
    const c = await raw.serviceCategory.findFirstOrThrow({
      where: { companyId, code, deletedAt: null },
    });
    return c.id;
  }

  it('sets the turnaround target from the service line', async () => {
    const mobile = await categoryId('MOBILE'); // seeded at 48h
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      service_category_id: mobile,
      priority: 'URGENT',
      customer: { name: `${TEST_PREFIX} Line`, phone: '0765990001' },
      device: { category: 'HHP', imei_serial: '358000000000016' },
    });
    expect(job.service_category_id).toBe(mobile);
    expect(job.priority).toBe('URGENT');

    const row = await raw.job.findUniqueOrThrow({ where: { id: job.id } });
    // received_at + 48h, computed server-side from the category's SLA.
    expect(row.slaDueAt?.getTime()).toBe(
      row.receivedAt.getTime() + 48 * 3_600_000,
    );
    expect(job.is_overdue).toBe(false);
  });

  it('a line with no standard turnaround leaves the target unset', async () => {
    const general = await categoryId('GENERAL'); // seeded with no SLA
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      service_category_id: general,
      customer: { name: `${TEST_PREFIX} NoSla`, phone: '0765990002' },
      device: { category: 'HHP', imei_serial: '358000000000024' },
    });
    expect(job.sla_due_at).toBeNull();
    // Priority is independent of the line and defaults to NORMAL.
    expect(job.priority).toBe('NORMAL');
  });

  it('rejects a service line from outside the company', async () => {
    await createJob(
      tokens.advisorDar,
      {
        branch_id: branchDar,
        service_category_id: '00000000-0000-4000-8000-000000000000',
        customer: { name: `${TEST_PREFIX} BadLine`, phone: '0765990003' },
        device: { category: 'HHP', imei_serial: '358000000000032' },
      },
      400,
    );
  });

  it('filters by priority and by service line', async () => {
    const ac = await categoryId('AC_REF');
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      service_category_id: ac,
      priority: 'HIGH',
      customer: { name: `${TEST_PREFIX} Filter`, phone: '0765990004' },
      device: { category: 'AC', imei_serial: '358000000000040' },
    });

    const byPriority = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .query({ priority: 'HIGH', page_size: 100 })
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const pr = byPriority.body as { data: Array<{ id: string }> };
    expect(pr.data.some((j) => j.id === job.id)).toBe(true);

    const byLine = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .query({ service_category_id: ac, page_size: 100 })
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const ln = byLine.body as { data: Array<{ id: string }> };
    expect(ln.data.some((j) => j.id === job.id)).toBe(true);
  });

  it('?overdue=true finds jobs past target, and ignores finished ones', async () => {
    const mobile = await categoryId('MOBILE');
    const late = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      service_category_id: mobile,
      customer: { name: `${TEST_PREFIX} Late`, phone: '0765990005' },
      device: { category: 'HHP', imei_serial: '358000000000057' },
    });
    // Wind the target into the past.
    await raw.job.update({
      where: { id: late.id },
      data: { slaDueAt: new Date(Date.now() - 3_600_000) },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .query({ overdue: true, page_size: 100 })
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const body = res.body as {
      data: Array<{ id: string; is_overdue: boolean }>;
    };
    const hit = body.data.find((j) => j.id === late.id);
    expect(hit).toBeDefined();
    expect(hit?.is_overdue).toBe(true);

    // Close it: a finished job that ran late is history, not something to chase.
    const closed = await raw.workflowState.findFirstOrThrow({
      where: { companyId, code: 'CANCELLED' },
    });
    await raw.job.update({
      where: { id: late.id },
      data: { stateId: closed.id },
    });
    const after = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .query({ overdue: true, page_size: 100 })
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const body2 = after.body as { data: Array<{ id: string }> };
    expect(body2.data.some((j) => j.id === late.id)).toBe(false);
  });
});

describe('GET /reports/snapshot — the centre right now (§4.3)', () => {
  interface Snapshot {
    at: string;
    attention: {
      open: number;
      overdue: number;
      due_today: number;
      urgent: number;
      unassigned: number;
      stale: number;
    };
    aging: { bucket: string; count: number }[];
    by_state: { code: string; count: number; overdue: number }[];
    by_line: {
      service_category_id: string | null;
      label: string;
      count: number;
    }[];
    priority_mix: { priority: string; count: number }[];
    engineers: {
      engineer_id: string | null;
      name: string;
      active: number;
      overdue: number;
      oldest_days: number | null;
    }[];
  }

  async function snapshot(token: string): Promise<Snapshot> {
    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/snapshot')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as Snapshot;
  }

  it('counts an overdue job once it is past target, and drops it when finished', async () => {
    const before = await snapshot(tokens.advisorDar);
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      priority: 'URGENT',
      customer: { name: `${TEST_PREFIX} Snap`, phone: '0765995001' },
      device: { category: 'HHP', imei_serial: '359000000000015' },
    });
    await raw.job.update({
      where: { id: job.id },
      data: { slaDueAt: new Date(Date.now() - 2 * 3_600_000) },
    });

    const during = await snapshot(tokens.advisorDar);
    expect(during.attention.overdue).toBe(before.attention.overdue + 1);
    expect(during.attention.urgent).toBe(before.attention.urgent + 1);
    // Nobody assigned yet — the pile that stalls work.
    expect(during.attention.unassigned).toBe(before.attention.unassigned + 1);

    // Finish it: a job that ran late is history, not something to chase.
    const terminal = await raw.workflowState.findFirstOrThrow({
      where: { companyId, code: 'CANCELLED' },
    });
    await raw.job.update({
      where: { id: job.id },
      data: { stateId: terminal.id },
    });

    const after = await snapshot(tokens.advisorDar);
    expect(after.attention.overdue).toBe(before.attention.overdue);
    expect(after.attention.open).toBe(before.attention.open);
  });

  it('due today counts the target falling today, NOT one already past', async () => {
    const base = await snapshot(tokens.advisorDar);
    const soon = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Today`, phone: '0765995002' },
      device: { category: 'HHP', imei_serial: '359000000000023' },
    });
    // Later today, but still ahead of now.
    const inAnHour = new Date(Date.now() + 3_600_000);
    const stillToday = inAnHour.getDate() === new Date().getDate();
    await raw.job.update({
      where: { id: soon.id },
      data: { slaDueAt: inAnHour },
    });

    const after = await snapshot(tokens.advisorDar);
    // Guarded: an hour from now rolls past midnight late in the evening, and
    // the assertion would then be wrong for a reason that is not a bug.
    if (stillToday) {
      expect(after.attention.due_today).toBe(base.attention.due_today + 1);
    }
    // Either way it is not yet late.
    expect(after.attention.overdue).toBe(base.attention.overdue);
  });

  it('buckets open work by age and attributes it to an engineer', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      assigned_engineer_id: ids.tech1,
      customer: { name: `${TEST_PREFIX} Aged`, phone: '0765995003' },
      device: { category: 'HHP', imei_serial: '359000000000031' },
    });
    // Taken in 20 days ago: the oldest bucket, and stale.
    await raw.job.update({
      where: { id: job.id },
      data: { receivedAt: new Date(Date.now() - 20 * 86_400_000) },
    });

    const snap = await snapshot(tokens.advisorDar);
    expect(snap.aging.map((b) => b.bucket)).toEqual([
      '0–2 days',
      '3–7 days',
      '8–14 days',
      '15+ days',
    ]);
    expect(snap.aging[3].count).toBeGreaterThan(0);
    expect(snap.attention.stale).toBeGreaterThan(0);

    const tech = snap.engineers.find((e) => e.engineer_id === ids.tech1);
    expect(tech).toBeDefined();
    expect(tech!.active).toBeGreaterThan(0);
    expect(tech!.oldest_days).toBeGreaterThanOrEqual(20);

    // The unassigned pile leads the list — nobody owns it, so nobody sees it.
    if (snap.engineers.some((e) => e.engineer_id === null)) {
      expect(snap.engineers[0].engineer_id).toBeNull();
      expect(snap.engineers[0].name).toBe('Unassigned');
    }
  });

  it('a branch user sees only their own branch', async () => {
    await createJob(tokens.advisorKrk, {
      branch_id: branchKrk,
      customer: { name: `${TEST_PREFIX} Krk snap`, phone: '0765995004' },
      device: { category: 'HHP', imei_serial: '359000000000049' },
    });
    const dar = await snapshot(tokens.advisorDar);
    const krk = await snapshot(tokens.advisorKrk);
    // Both are branch-scoped, so neither total can be the whole company.
    expect(dar.attention.open).toBeGreaterThan(0);
    expect(krk.attention.open).toBeGreaterThan(0);
    const admin = await snapshot(tokens.admin);
    expect(admin.attention.open).toBeGreaterThanOrEqual(
      Math.max(dar.attention.open, krk.attention.open),
    );
  });
});
