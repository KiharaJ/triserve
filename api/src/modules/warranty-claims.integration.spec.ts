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
  status: string;
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
