/**
 * Integration test (Phase 5 / E15) for the operations report against the REAL
 * MySQL database over HTTP. A single job is created in an ISOLATED past window
 * (2019) so the assertions don't mix with live/imported jobs.
 * Fixtures are test-only (prefixed __TEST_5_3__) and removed in afterAll.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_5_3__';
const PASSWORD = 'Ops5.3-Pass!';
const EMAIL = 'test-5-3-admin@triserve.test';
const FROM = '2019-01-01';
const TO = '2019-12-31';

const raw = new PrismaClient();
let app: INestApplication<App>;
let companyId: string;
let branchId: string;
let adminId: string;
let customerId: string;
let deviceId: string;
let jobId: string;
let token: string;

beforeAll(async () => {
  companyId = (
    await raw.company.findFirstOrThrow({ where: { name: 'Samsung ASC Group' } })
  ).id;
  branchId = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  adminId = (
    await raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} admin`,
        email: EMAIL,
        passwordHash,
        role: 'SUPER_ADMIN',
        scope: 'group',
        homeBranchId: null,
      },
    })
  ).id;
  customerId = (
    await raw.customer.create({ data: { companyId, name: `${TEST_PREFIX} Cust` } })
  ).id;
  deviceId = (
    await raw.device.create({
      data: { companyId, customerId, category: 'HHP', model: 'ZZTESTMODEL' },
    })
  ).id;
  const initial = await raw.workflowState.findFirstOrThrow({
    where: { isInitial: true, active: true, deletedAt: null },
  });
  jobId = (
    await raw.job.create({
      data: {
        companyId,
        jobNo: `${TEST_PREFIX}-J1`,
        branchId,
        customerId,
        deviceId,
        bookedById: adminId,
        stateId: initial.id,
        receivedAt: new Date('2019-06-15'),
      },
    })
  ).id;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  token = (
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200)
  ).body.access_token;
});

afterAll(async () => {
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.device.deleteMany({ where: { id: deviceId } });
  await raw.customer.deleteMany({ where: { id: customerId } });
  await raw.session.deleteMany({ where: { userId: adminId } });
  await raw.user.deleteMany({ where: { id: adminId } });
  await raw.$disconnect();
  await app.close();
});

describe('Operations report', () => {
  it('aggregates the isolated period: totals, top models, state mix', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/operations?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as {
      totals: { total_jobs: number; active_jobs: number };
      top_models: { model: string; count: number }[];
      by_state: { code: string; count: number }[];
      technicians: unknown[];
    };
    expect(body.totals.total_jobs).toBe(1);
    expect(body.totals.active_jobs).toBe(1);
    expect(body.top_models).toEqual([{ model: 'ZZTESTMODEL', count: 1 }]);
    expect(body.by_state.find((s) => s.code === 'RECEIVED')!.count).toBe(1);
    expect(body.technicians).toHaveLength(0); // no engineer assigned
  });
});
