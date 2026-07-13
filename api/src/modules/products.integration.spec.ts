/**
 * Integration tests (retail products) against the REAL MySQL database over HTTP:
 *   - create a product with a default warranty; SKU unique per company;
 *   - a duplicate SKU → 409; search by name/brand/type;
 *   - create needs part.manage (a SERVICE_ADVISOR is 403).
 * Fixtures are test-only (prefixed __TEST_P1__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_P1__';
const PASSWORD = 'Prod-P1-Pass!';
const EMAILS = {
  admin: 'test-p1-admin@triserve.test',
  advisor: 'test-p1-advisor@triserve.test',
};

const raw = new PrismaClient();
let app: INestApplication<App>;
let companyId: string;
let branchId: string;
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

async function createProduct(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/products')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  if (res.body?.id) createdIds.push(res.body.id);
  return res.body;
}

beforeAll(async () => {
  companyId = (
    await raw.company.findFirstOrThrow({ where: { name: 'Samsung ASC Group' } })
  ).id;
  branchId = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mk = (email: string, role: UserRole, scope: UserScope) =>
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} ${role}`,
        email,
        passwordHash,
        role,
        scope,
        homeBranchId: scope === 'branch' ? branchId : null,
      },
    });
  await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group'),
    mk(EMAILS.advisor, 'SERVICE_ADVISOR', 'branch'),
  ]);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  tokens.admin = await login(EMAILS.admin);
  tokens.advisor = await login(EMAILS.advisor);
});

afterAll(async () => {
  await raw.product.deleteMany({ where: { id: { in: createdIds } } });
  await raw.session.deleteMany({
    where: { user: { email: { in: Object.values(EMAILS) } } },
  });
  await raw.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await raw.$disconnect();
  await app.close();
});

describe('Products catalogue', () => {
  it('creates a retail product with a default warranty', async () => {
    const p = await createProduct(tokens.admin, {
      sku: `${TEST_PREFIX}-TV1`,
      name: `${TEST_PREFIX} Hisense 55 TV`,
      brand: 'Hisense',
      device_type: 'TV',
      sell_price_tzs: '85000000',
      stock_qty: 5,
      default_warranty_months: 12,
      default_warranty_kind: 'STORE',
    });
    expect(p.sku).toBe(`${TEST_PREFIX}-TV1`);
    expect(p.sell_price_tzs).toBe('85000000');
    expect(p.category).toBe('OTHER'); // defaulted
    expect(p.default_warranty_months).toBe(12);
    expect(p.default_warranty_kind).toBe('STORE');
    expect(p.stock_qty).toBe(5);
  });

  it('rejects a duplicate SKU (409)', async () => {
    await createProduct(tokens.admin, {
      sku: `${TEST_PREFIX}-DUP`,
      name: `${TEST_PREFIX} A`,
    });
    await createProduct(
      tokens.admin,
      { sku: `${TEST_PREFIX}-DUP`, name: `${TEST_PREFIX} B` },
      409,
    );
  });

  it('searches by brand/type', async () => {
    await createProduct(tokens.admin, {
      sku: `${TEST_PREFIX}-BIKE`,
      name: `${TEST_PREFIX} Activa`,
      brand: 'Honda',
      device_type: 'Two-Wheeler',
    });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/products?q=${encodeURIComponent('Honda')}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(200);
    const rows = (res.body as { data: { brand: string }[] }).data;
    expect(rows.some((r) => r.brand === 'Honda')).toBe(true);
  });

  it('create needs part.manage — a SERVICE_ADVISOR is 403', async () => {
    await createProduct(
      tokens.advisor,
      { sku: `${TEST_PREFIX}-NO`, name: `${TEST_PREFIX} nope` },
      403,
    );
  });
});
