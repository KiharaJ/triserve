/**
 * Integration tests (Task 1.3, DESIGN.md §4.3/§5) for the job lifecycle API
 * against the REAL MySQL database over HTTP:
 *   - POST /jobs with a nested new customer+device → job_no matches
 *     /^DAR-2026-\d{6}$/, state=RECEIVED, received_at set, so_number
 *     scientific-notation input normalized;
 *   - a 2nd job same branch/year increments the sequence;
 *   - CONCURRENCY: 10 parallel creates → 10 unique sequential job_nos, the
 *     jobs.job_no unique constraint never violated;
 *   - POST /jobs/{id}/transition RECEIVED→DIAGNOSING works + writes a
 *     TRANSITION audit row; illegal RECEIVED→CLOSED → 422;
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
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

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
  state_code: string;
  received_at: string;
  ready_at: string | null;
  dispatched_at: string | null;
  dispatched_by: string | null;
  received_by_customer: string | null;
  waybill_no: string | null;
  assigned_engineer_id: string | null;
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
  allowed_next_transitions?: Array<{ to_state_code: string }>;
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

async function transition(
  token: string,
  jobId: string,
  toStateCode: string,
  expectStatus = 201,
): Promise<{ held: boolean; job: JobBody }> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/jobs/${jobId}/transition`)
    .set('Authorization', `Bearer ${token}`)
    .send({ to_state_code: toStateCode })
    .expect(expectStatus);
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
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.branch.deleteMany({ where: { companyId: companyBId } });
  await raw.company.deleteMany({ where: { id: companyBId } });
  await app.close();
  await raw.$disconnect();
});

describe('POST /jobs — intake + job_no generation (§4.3)', () => {
  it('creates a job with nested new customer+device; job_no format, RECEIVED, received_at, so_number normalized', async () => {
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
        imei_serial: '3.5100000000001E14',
        color: 'Black',
      },
    });

    expect(job.job_no).toMatch(new RegExp(`^DAR-${YEAR}-\\d{6}$`));
    expect(job.state_code).toBe('RECEIVED');
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
    expect(dev.imeiSerial).toBe('351000000000010');
  });

  it('a 2nd job in the same branch/year increments the sequence', async () => {
    const first = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Seq A`, phone: '0765111333' },
      device: { category: 'HHP', imei_serial: '351000000000027' },
    });
    const second = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Seq B`, phone: '0765111444' },
      device: { category: 'HHP', imei_serial: '351000000000035' },
    });
    const seqOf = (jn: string) => Number(jn.split('-')[2]);
    expect(seqOf(second.job_no)).toBe(seqOf(first.job_no) + 1);
  });

  it('reuses an existing customer by normalized phone (find-or-create)', async () => {
    const a = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Repeat`, phone: '0765 999 000' },
      device: { category: 'HHP', imei_serial: '351000000000043' },
    });
    const b = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Repeat`, phone: '+255765999000' },
      device: { category: 'HHP', imei_serial: '351000000000050' },
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
            imei_serial: `35200000000${String(i).padStart(4, '0')}`,
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
      device: { category: 'HHP', imei_serial: '351000000000060' },
    });
    // A second job for a DIFFERENT customer must not show up in the filter.
    await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} CustFilterOther`, phone: '0765333555' },
      device: { category: 'HHP', imei_serial: '351000000000078' },
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
  it('RECEIVED→DIAGNOSING allowed (advisor) + writes a TRANSITION audit row', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Diag`, phone: '0765440001' },
      device: { category: 'HHP', imei_serial: '353000000000019' },
    });

    const { held, job: after } = await transition(
      tokens.advisorDar,
      job.id,
      'DIAGNOSING',
    );
    expect(held).toBe(false);
    expect(after.state_code).toBe('DIAGNOSING');

    const audit = await raw.auditLog.findFirst({
      where: { entityType: 'Job', entityId: job.id, action: 'TRANSITION' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(ids.advisorDar);
    expect(
      (audit?.afterJson as { state_code?: string } | null)?.state_code,
    ).toBe('DIAGNOSING');
  });

  it('illegal RECEIVED→CLOSED is rejected with 422', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Illegal`, phone: '0765440002' },
      device: { category: 'HHP', imei_serial: '353000000000027' },
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
      customer: { name: `${TEST_PREFIX} Ready`, phone: '0765440003' },
      device: { category: 'HHP', imei_serial: '353000000000035' },
    });

    // admin holds every job.transition.* permission → walk to READY.
    await transition(tokens.admin, job.id, 'DIAGNOSING');
    await transition(tokens.admin, job.id, 'AWAITING_PARTS');
    await transition(tokens.admin, job.id, 'IN_REPAIR');
    await transition(tokens.admin, job.id, 'QC');
    const ready = await transition(tokens.admin, job.id, 'READY');
    expect(ready.job.state_code).toBe('READY');
    expect(ready.job.ready_at).toBeTruthy();

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

  it('a TECHNICIAN cannot dispatch (lacks job.transition.dispatch) → 403', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${createdJobIds[0]}/dispatch`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ received_by: 'x' })
      .expect(403);
  });

  it('GET /jobs/{id} exposes only legal+authorized allowed_next_transitions', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Allowed`, phone: '0765440004' },
      device: { category: 'HHP', imei_serial: '353000000000043' },
    });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const body = res.body as JobBody;
    const codes = (body.allowed_next_transitions ?? []).map(
      (t) => t.to_state_code,
    );
    // From RECEIVED an advisor (job.transition) may go to DIAGNOSING/CANCELLED.
    expect(codes.sort()).toEqual(['CANCELLED', 'DIAGNOSING']);
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
      device: { category: 'HHP', imei_serial: '354000000000018' },
    });
    const j2 = await createJob(tokens.admin, {
      branch_id: branchDar,
      assigned_engineer_id: ids.tech2,
      customer: { name: `${TEST_PREFIX} T2`, phone: '0765550002' },
      device: { category: 'HHP', imei_serial: '354000000000026' },
    });
    const jk = await createJob(tokens.advisorKrk, {
      branch_id: branchKrk,
      customer: { name: `${TEST_PREFIX} KRK`, phone: '0765550003' },
      device: { category: 'HHP', imei_serial: '354000000000034' },
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

describe('PATCH /jobs/{id} — mutable fields, never status', () => {
  it('updates fault/tech_report/engineer; cannot change status via PATCH', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Patch`, phone: '0765660001' },
      device: { category: 'HHP', imei_serial: '355000000000017' },
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
    expect(body.state_code).toBe('RECEIVED'); // unchanged
    expect(body.assigned_engineer_id).toBe(ids.tech1);

    // A stray status field is stripped by the whitelist pipe → no effect.
    await request(app.getHttpServer())
      .patch(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ state_code: 'CLOSED' })
      .expect(400);
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
        imei_serial: '356000000000019',
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
      device: { category: 'HHP', imei_serial: '356000000000027' },
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
      device: { category: 'HHP', imei_serial: '356000000000035' },
    });
    expect(job.coverage).toBe('FULL');
  });

  it('PATCHing warranty_status alone still moves coverage (a stale coverage would keep billing)', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      warranty_status: 'OW',
      customer: { name: `${TEST_PREFIX} Reruled`, phone: '0765770004' },
      device: { category: 'HHP', imei_serial: '356000000000043' },
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
      device: { category: 'HHP', imei_serial: '356000000000050' },
    });
    // Explicit coverage must NOT be flattened to FULL by the IW status.
    expect(job.coverage).toBe('LABOUR_ONLY');
  });

  it('a service code of the WRONG kind is rejected (ids are interchangeable UUIDs)', async () => {
    const job = await createJob(tokens.advisorDar, {
      branch_id: branchDar,
      customer: { name: `${TEST_PREFIX} Codes`, phone: '0765770006' },
      device: { category: 'HHP', imei_serial: '356000000000068' },
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
        serialNo: '356000000000084',
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
        imei_serial: '356000000000084',
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
        device: { category: 'HHP', imei_serial: '356000000000092' },
      },
      400,
    );
  });

  it('a later intake never overwrites a purchase date already on file', async () => {
    const imei = '356000000000076';
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
    expect(await raw.workflowState.count({ where: { companyId } })).toBe(11);
    expect(await raw.workflowTransition.count({ where: { companyId } })).toBe(
      16,
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
    await transition(tokens.advisorDar, job.id, 'DIAGNOSING');
    await transition(tokens.advisorDar, job.id, 'AWAITING_CUSTOMER_APPROVAL');
    return job.id;
  }

  it('OW quote gate: blocked → requested → approved → retried, single use', async () => {
    const jobId = await jobAwaitingQuote('0765880001', '357000000000010');

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
    const second = await jobAwaitingQuote('0765880002', '357000000000028');
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
      device: { category: 'HHP', imei_serial: '357000000000036' },
    });
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
      device: { category: 'HHP', imei_serial: '357000000000044' },
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
      device: { category: 'HHP', imei_serial: '357000000000051' },
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
      device: { category: 'HHP', imei_serial: '358000000000018' },
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
      device: { category: 'HHP', imei_serial: '358000000000026' },
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
        device: { category: 'HHP', imei_serial: '358000000000034' },
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
      device: { category: 'AC', imei_serial: '358000000000042' },
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
      device: { category: 'HHP', imei_serial: '358000000000059' },
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
