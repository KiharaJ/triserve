/**
 * Integration tests (retail warranties) for warranty registrations against the
 * REAL MySQL database over HTTP:
 *   - create with months → expiry auto-computed, status ACTIVE, serial normalized;
 *   - create with a past expiry → effective status EXPIRED;
 *   - create with neither expiry_date nor months → 400;
 *   - lookup by serial finds it; an unknown serial → null;
 *   - PATCH status VOID → VOID;
 *   - create needs invoice.create (a TECHNICIAN is 403).
 * Fixtures are test-only (prefixed __TEST_R1__) and removed in afterAll.
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
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

const TEST_PREFIX = '__TEST_R1__';
const PASSWORD = 'WReg-R1-Pass!';
const EMAILS = {
  advisor: 'test-r1-advisor@triserve.test',
  tech: 'test-r1-tech@triserve.test',
};

const raw = new PrismaClient();
let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
const tokens: Record<string, string> = {};
const createdIds: string[] = [];

async function login(email: string): Promise<string> {
  return (
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200)
  ).body.access_token;
}

interface RegBody {
  id: string;
  product_name: string;
  serial_no: string | null;
  expiry_date: string;
  status: string;
  is_expired: boolean;
}

async function create(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<RegBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/warranty-registrations')
    .set('Authorization', `Bearer ${token}`)
    .send({ branch_id: branchDar, ...body })
    .expect(expectStatus);
  const b = res.body as RegBody;
  if (b.id) createdIds.push(b.id);
  return b;
}

beforeAll(async () => {
  companyId = (
    await raw.company.findFirstOrThrow({ where: { name: 'Samsung ASC Group' } })
  ).id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mk = (email: string, role: string, scope: UserScope) =>
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} ${role}`,
        email,
        passwordHash,
        role,
        scope,
        homeBranchId: branchDar,
      },
    });
  await Promise.all([
    mk(EMAILS.advisor, 'SERVICE_ADVISOR', 'branch'),
    mk(EMAILS.tech, 'TECHNICIAN', 'branch'),
  ]);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  tokens.advisor = await login(EMAILS.advisor);
  tokens.tech = await login(EMAILS.tech);
});

afterAll(async () => {
  await raw.warrantyRegistration.deleteMany({ where: { id: { in: createdIds } } });
  await raw.auditLog.deleteMany({
    where: { entityType: 'WarrantyRegistration', entityId: { in: createdIds } },
  });
  await raw.session.deleteMany({
    where: { user: { email: { in: Object.values(EMAILS) } } },
  });
  await raw.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await raw.$disconnect();
  await app.close();
});

describe('Warranty registrations', () => {
  it('creates with months → auto expiry, ACTIVE, normalized serial', async () => {
    const reg = await create(tokens.advisor, {
      product_name: `${TEST_PREFIX} Hisense TV`,
      brand: 'Hisense',
      kind: 'STORE',
      start_date: '2026-07-01',
      months: 12,
      serial_no: 'HS 1234-5678',
    });
    expect(reg.expiry_date).toBe('2027-07-01');
    expect(reg.status).toBe('ACTIVE');
    expect(reg.is_expired).toBe(false);
    expect(reg.serial_no).toBe('HS12345678'); // separators stripped
  });

  it('reports EXPIRED when the expiry is in the past', async () => {
    const reg = await create(tokens.advisor, {
      product_name: `${TEST_PREFIX} Old TV`,
      kind: 'MANUFACTURER',
      start_date: '2020-01-01',
      expiry_date: '2021-01-01',
    });
    expect(reg.status).toBe('EXPIRED');
    expect(reg.is_expired).toBe(true);
  });

  it('rejects a registration with no expiry_date and no months (400)', async () => {
    await create(
      tokens.advisor,
      { product_name: `${TEST_PREFIX} X`, kind: 'STORE', start_date: '2026-07-01' },
      400,
    );
  });

  it('looks up an active warranty by serial; unknown serial → null', async () => {
    await create(tokens.advisor, {
      product_name: `${TEST_PREFIX} LG Fridge`,
      brand: 'LG',
      kind: 'MANUFACTURER',
      start_date: '2026-01-01',
      months: 24,
      serial_no: 'LG-FRIDGE-4242',
    });
    const hit = await request(app.getHttpServer())
      .get('/api/v1/warranty-registrations/lookup?serial=LGFRIDGE4242')
      .set('Authorization', `Bearer ${tokens.advisor}`)
      .expect(200);
    expect((hit.body as RegBody).product_name).toContain('LG Fridge');

    const miss = await request(app.getHttpServer())
      .get('/api/v1/warranty-registrations/lookup?serial=NOPE-000')
      .set('Authorization', `Bearer ${tokens.advisor}`)
      .expect(200);
    expect(miss.body).toEqual({});
  });

  it('voids via PATCH', async () => {
    const reg = await create(tokens.advisor, {
      product_name: `${TEST_PREFIX} Void me`,
      kind: 'STORE',
      start_date: '2026-07-01',
      months: 6,
    });
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/warranty-registrations/${reg.id}`)
      .set('Authorization', `Bearer ${tokens.advisor}`)
      .send({ status: 'VOID' })
      .expect(200);
    expect((res.body as RegBody).status).toBe('VOID');
  });

  it('create needs invoice.create — a TECHNICIAN is 403', async () => {
    await create(
      tokens.tech,
      { product_name: `${TEST_PREFIX} nope`, kind: 'STORE', start_date: '2026-07-01', months: 6 },
      403,
    );
  });
});
