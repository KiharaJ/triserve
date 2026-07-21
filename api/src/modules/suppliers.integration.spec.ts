/**
 * Integration tests (Task 2.5, DESIGN.md §4.4b) for the supplier master against
 * the REAL MySQL database over HTTP:
 *   - POST /suppliers creates a vendor; a duplicate name → 409; list/filter/get
 *     /patch work; default_currency upper-cased;
 *   - a part can point at a supplier (preferred_supplier_id), the part wire
 *     resolves preferred_supplier.name, and an unknown supplier → 400;
 *   - permissions: supplier.read to read, supplier.manage to write (a TECHNICIAN
 *     is 403 on create);
 *   - scoping: company B cannot see company A's supplier.
 *
 * Fixtures are test-only (prefixed __TEST_2_5__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_2_5__';
const PASSWORD = 'Supplier2.5-Pass!';

const EMAILS = {
  admin: 'test-2-5-admin@triserve.test',
  store: 'test-2-5-store@triserve.test',
  tech: 'test-2-5-tech@triserve.test',
  adminB: 'test-2-5-admin-b@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let companyBId: string;
let branchDar: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdSupplierIds: string[] = [];
const createdPartIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

interface SupplierBody {
  id: string;
  name: string;
  default_currency: string;
  lead_time_days: number | null;
}
interface PartBody {
  id: string;
  preferred_supplier_id: string | null;
  preferred_supplier: { id: string; name: string } | null;
}

async function createSupplier(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<SupplierBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/suppliers')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  const s = res.body as SupplierBody;
  if (s.id && expectStatus === 201) createdSupplierIds.push(s.id);
  return s;
}

async function createPart(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<PartBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/parts')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  const p = res.body as PartBody;
  if (p.id && expectStatus === 201) createdPartIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;

  const companyB = await raw.company.create({
    data: { name: `${TEST_PREFIX} Rival Co` },
  });
  companyBId = companyB.id;

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

  const [admin, store, tech, adminB] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', companyId, null),
    mk(EMAILS.store, 'STOREKEEPER', 'branch', companyId, branchDar),
    mk(EMAILS.tech, 'TECHNICIAN', 'branch', companyId, branchDar),
    mk(EMAILS.adminB, 'SUPER_ADMIN', 'group', companyBId, null),
  ]);
  ids.admin = admin.id;
  ids.store = store.id;
  ids.tech = tech.id;
  ids.adminB = adminB.id;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  tokens.admin = await login(EMAILS.admin);
  tokens.store = await login(EMAILS.store);
  tokens.tech = await login(EMAILS.tech);
  tokens.adminB = await login(EMAILS.adminB);
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  await raw.part.deleteMany({ where: { id: { in: createdPartIds } } });
  await raw.supplier.deleteMany({ where: { id: { in: createdSupplierIds } } });
  await raw.auditLog.deleteMany({
    where: {
      entityType: { in: ['Supplier', 'Part'] },
      entityId: { in: [...createdSupplierIds, ...createdPartIds] },
    },
  });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.company.delete({ where: { id: companyBId } });
  await raw.$disconnect();
  await app.close();
});

describe('Supplier master', () => {
  it('creates + rejects duplicate name; upper-cases currency; lists/patches', async () => {
    const s = await createSupplier(tokens.store, {
      name: `${TEST_PREFIX} Acme Parts`,
      contact_person: 'A. Buyer',
      default_currency: 'usd',
      lead_time_days: 14,
      payment_terms: '30 days',
    });
    expect(s.default_currency).toBe('USD');
    expect(s.lead_time_days).toBe(14);

    await createSupplier(
      tokens.store,
      { name: `${TEST_PREFIX} Acme Parts` },
      409,
    );

    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/suppliers/${s.id}`)
      .set('Authorization', `Bearer ${tokens.store}`)
      .send({ lead_time_days: 7 })
      .expect(200);
    expect((patched.body as SupplierBody).lead_time_days).toBe(7);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/suppliers?q=${TEST_PREFIX} Acme`)
      .set('Authorization', `Bearer ${tokens.store}`)
      .expect(200);
    expect(
      (list.body as { data: SupplierBody[] }).data.some((x) => x.id === s.id),
    ).toBe(true);
  });

  it('links a part to a supplier and resolves the name; rejects unknown', async () => {
    const s = await createSupplier(tokens.store, {
      name: `${TEST_PREFIX} Preferred Vendor`,
    });
    const part = await createPart(tokens.store, {
      part_number: `${TEST_PREFIX}-SUP-1`,
      description: 'part with supplier',
      category: 'HHP',
      preferred_supplier_id: s.id,
    });
    expect(part.preferred_supplier_id).toBe(s.id);
    expect(part.preferred_supplier?.name).toBe(
      `${TEST_PREFIX} Preferred Vendor`,
    );

    // Unknown supplier id → 400.
    await createPart(
      tokens.store,
      {
        part_number: `${TEST_PREFIX}-SUP-2`,
        description: 'bad supplier',
        category: 'HHP',
        preferred_supplier_id: '00000000-0000-4000-8000-000000000000',
      },
      400,
    );
  });
});

describe('Permissions + scoping', () => {
  it('a TECHNICIAN cannot create a supplier (no supplier.manage)', async () => {
    await createSupplier(tokens.tech, { name: `${TEST_PREFIX} Nope` }, 403);
  });

  it("company B cannot see company A's supplier", async () => {
    const s = await createSupplier(tokens.store, {
      name: `${TEST_PREFIX} A-only`,
    });
    await request(app.getHttpServer())
      .get(`/api/v1/suppliers/${s.id}`)
      .set('Authorization', `Bearer ${tokens.adminB}`)
      .expect(404);
  });
});
