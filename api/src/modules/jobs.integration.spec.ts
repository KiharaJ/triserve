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
import { PrismaClient, type UserRole, type UserScope } from '@prisma/client';
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
    role: UserRole,
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
  await raw.job.deleteMany({
    where: { companyId: { in: [companyId, companyBId] } },
  });
  await raw.jobCounter.deleteMany({
    where: { companyId: { in: [companyId, companyBId] } },
  });
  await raw.device.deleteMany({
    where: { companyId: { in: [companyId, companyBId] } },
  });
  await raw.customer.deleteMany({
    where: { companyId: { in: [companyId, companyBId] } },
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
    // All jobs currently in the DB belong to this suite (cleaned in afterAll).
    const jobCount = await raw.job.count();
    expect(jobCount).toBe(createdJobIds.length);
    expect(jobCount).toBeGreaterThan(0);
  });
});
