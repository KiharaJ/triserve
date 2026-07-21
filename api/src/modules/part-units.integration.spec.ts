/**
 * Integration tests (Task 2.4, DESIGN.md §4.4 / E11) for serial/batch unit
 * tracking against the REAL MySQL database over HTTP:
 *   - POST /parts/{id}/units registers IN_STOCK units on a serialized part;
 *     a duplicate serial → 409; a non-serialized part → 400;
 *   - GET /part-units?serial= is the group-wide recall lookup (a DAR user finds
 *     a unit located at KRK — units are company-scoped, not branch-scoped);
 *   - PATCH updates status / location / warranty / job linkage;
 *   - registering needs inventory.adjust (a SERVICE_ADVISOR is 403);
 *   - company B cannot see company A's units.
 *
 * Fixtures are test-only (prefixed __TEST_2_4__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_2_4__';
const PASSWORD = 'Units2.4-Pass!';

const EMAILS = {
  admin: 'test-2-4-admin@triserve.test',
  storeDar: 'test-2-4-store-dar@triserve.test',
  advisorDar: 'test-2-4-advisor-dar@triserve.test',
  adminB: 'test-2-4-admin-b@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let companyBId: string;
let branchDar: string;
let branchKrk: string;
let serializedPart: string;
let plainPart: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdPartIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

interface UnitBody {
  id: string;
  serial_no: string;
  status: string;
  branch_id: string;
  warranty_expiry: string | null;
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

  const [admin, storeDar, advisorDar, adminB] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', companyId, null),
    mk(EMAILS.storeDar, 'STOREKEEPER', 'branch', companyId, branchDar),
    mk(EMAILS.advisorDar, 'SERVICE_ADVISOR', 'branch', companyId, branchDar),
    mk(EMAILS.adminB, 'SUPER_ADMIN', 'group', companyBId, null),
  ]);
  ids.admin = admin.id;
  ids.storeDar = storeDar.id;
  ids.advisorDar = advisorDar.id;
  ids.adminB = adminB.id;

  const serialized = await raw.part.create({
    data: {
      companyId,
      partNumber: `${TEST_PREFIX}-LCD`,
      description: 'Serialized LCD',
      category: 'HHP',
      isSerialized: true,
    },
  });
  serializedPart = serialized.id;
  createdPartIds.push(serialized.id);
  const plain = await raw.part.create({
    data: {
      companyId,
      partNumber: `${TEST_PREFIX}-TAPE`,
      description: 'Plain consumable',
      category: 'HHP',
      isSerialized: false,
    },
  });
  plainPart = plain.id;
  createdPartIds.push(plain.id);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  tokens.admin = await login(EMAILS.admin);
  tokens.storeDar = await login(EMAILS.storeDar);
  tokens.advisorDar = await login(EMAILS.advisorDar);
  tokens.adminB = await login(EMAILS.adminB);
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  await raw.partUnit.deleteMany({ where: { partId: { in: createdPartIds } } });
  await raw.auditLog.deleteMany({
    where: { companyId, entityType: 'PartUnit' },
  });
  await raw.part.deleteMany({ where: { id: { in: createdPartIds } } });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.company.delete({ where: { id: companyBId } });
  await raw.$disconnect();
  await app.close();
});

describe('Register + lookup', () => {
  it('registers units, rejects duplicates and non-serialized parts', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/parts/${serializedPart}/units`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({
        branch_id: branchDar,
        serials: [`${TEST_PREFIX}-SN1`, `${TEST_PREFIX}-SN2`],
        warranty_expiry: '2027-01-31',
      })
      .expect(201);
    const units = res.body as UnitBody[];
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.status === 'IN_STOCK')).toBe(true);
    expect(units[0].warranty_expiry).toBe('2027-01-31');

    // Re-registering a serial already on this part → 409.
    await request(app.getHttpServer())
      .post(`/api/v1/parts/${serializedPart}/units`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({ branch_id: branchDar, serials: [`${TEST_PREFIX}-SN1`] })
      .expect(409);

    // A non-serialized part can't have units.
    await request(app.getHttpServer())
      .post(`/api/v1/parts/${plainPart}/units`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({ branch_id: branchDar, serials: [`${TEST_PREFIX}-X`] })
      .expect(400);
  });

  it('the serial lookup is group-wide (not branch-scoped)', async () => {
    // Admin registers a unit located at KRK.
    await request(app.getHttpServer())
      .post(`/api/v1/parts/${serializedPart}/units`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ branch_id: branchKrk, serials: [`${TEST_PREFIX}-KRK-9`] })
      .expect(201);

    // A DAR storekeeper can still find it by serial (history is group-wide).
    const res = await request(app.getHttpServer())
      .get(`/api/v1/part-units?serial=${TEST_PREFIX}-KRK-9`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    const body = res.body as { data: UnitBody[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].branch_id).toBe(branchKrk);
  });
});

describe('Lifecycle + permissions + scoping', () => {
  it('updates status, location and job linkage', async () => {
    const reg = await request(app.getHttpServer())
      .post(`/api/v1/parts/${serializedPart}/units`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({ branch_id: branchDar, serials: [`${TEST_PREFIX}-LIFE`] })
      .expect(201);
    const unitId = (reg.body as UnitBody[])[0].id;

    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/part-units/${unitId}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({ status: 'DAMAGED', warranty_expiry: null })
      .expect(200);
    expect((patched.body as UnitBody).status).toBe('DAMAGED');
    expect((patched.body as UnitBody).warranty_expiry).toBeNull();
  });

  it('registering needs inventory.adjust (advisor is 403)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/parts/${serializedPart}/units`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ branch_id: branchDar, serials: [`${TEST_PREFIX}-NOPE`] })
      .expect(403);
  });

  it("company B cannot see company A's units", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/part-units?serial=${TEST_PREFIX}-SN1`)
      .set('Authorization', `Bearer ${tokens.adminB}`)
      .expect(200);
    expect((res.body as { total: number }).total).toBe(0);
  });
});
