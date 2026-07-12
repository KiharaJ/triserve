/**
 * Integration tests (Phase 5 / E2, Task 5.1) for the Customer 360 profile
 * against the REAL MySQL database over HTTP. GET /customers/{id}/profile
 * assembles devices + jobs + invoices + warranty and COMPUTES lifetime spend
 * (Σ payments) and outstanding balance (Σ unpaid invoice balance) — never
 * stored. Fixtures are test-only (prefixed __TEST_5_1__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_5_1__';
const PASSWORD = 'Profile5.1-Pass!';
const EMAIL = 'test-5-1-admin@triserve.test';

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchId: string;
let adminId: string;
let customerId: string;
let deviceId: string;
let jobId: string;
let invoiceId: string;
let token: string;

interface ProfileBody {
  customer: { id: string; name: string };
  stats: {
    total_jobs: number;
    active_jobs: number;
    total_devices: number;
    total_invoices: number;
    lifetime_spend: { currency: string; amount: string }[];
    outstanding: { currency: string; amount: string }[];
    last_visit: string | null;
    first_seen: string | null;
  };
  devices: unknown[];
  jobs: unknown[];
  invoices: { invoice_no: string; balance: string; status: string }[];
}

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
    await raw.customer.create({
      data: { companyId, name: `${TEST_PREFIX} Profile Cust`, phone: '0765000111' },
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
  jobId = (
    await raw.job.create({
      data: {
        companyId,
        jobNo: `${TEST_PREFIX}-JOB-1`,
        branchId,
        customerId,
        deviceId,
        bookedById: adminId,
        warrantyStatus: 'OW',
        stateId: initial.id,
        receivedAt: new Date('2026-06-01'),
      },
    })
  ).id;
  // A PARTIAL invoice: total 100000, paid 40000 → spend 40000, outstanding 60000.
  invoiceId = (
    await raw.invoice.create({
      data: {
        companyId,
        invoiceNo: `INV-${TEST_PREFIX}-1`,
        branchId,
        customerId,
        type: 'REPAIR_OW',
        currency: 'TZS',
        subtotal: 100_000n,
        total: 100_000n,
        status: 'PARTIAL',
        soldById: adminId,
        payments: {
          create: [
            {
              companyId,
              branchId,
              method: 'CASH',
              amount: 40_000n,
              currency: 'TZS',
              receivedById: adminId,
            },
          ],
        },
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

  token = (
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200)
  ).body.access_token;
});

afterAll(async () => {
  await raw.payment.deleteMany({ where: { invoiceId } });
  await raw.invoice.deleteMany({ where: { id: invoiceId } });
  await raw.job.deleteMany({ where: { id: jobId } });
  await raw.device.deleteMany({ where: { id: deviceId } });
  await raw.customer.deleteMany({ where: { id: customerId } });
  await raw.auditLog.deleteMany({ where: { actorUserId: adminId } });
  await raw.session.deleteMany({ where: { userId: adminId } });
  await raw.user.deleteMany({ where: { id: adminId } });
  await raw.$disconnect();
  await app.close();
});

describe('Customer 360 profile', () => {
  it('assembles devices/jobs/invoices and computes spend + outstanding', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}/profile`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as ProfileBody;

    expect(body.customer.id).toBe(customerId);
    expect(body.stats.total_jobs).toBe(1);
    expect(body.stats.active_jobs).toBe(1); // RECEIVED is non-terminal
    expect(body.stats.total_devices).toBe(1);
    expect(body.stats.total_invoices).toBe(1);
    expect(body.stats.lifetime_spend).toEqual([
      { currency: 'TZS', amount: '40000' },
    ]);
    expect(body.stats.outstanding).toEqual([
      { currency: 'TZS', amount: '60000' },
    ]);
    expect(body.stats.first_seen).not.toBeNull();
    expect(body.stats.last_visit).not.toBeNull();
    expect(body.jobs).toHaveLength(1);
    expect(body.invoices[0].balance).toBe('60000');
  });

  it('404s for an unknown customer', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/customers/00000000-0000-4000-8000-000000000000/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
