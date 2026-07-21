/**
 * Integration tests (Task 1.1, DESIGN.md §4.2) for the CRM foundations —
 * customers, devices, models — against the REAL MySQL database over HTTP:
 *   - POST /models (admin-gated), duplicate (company,brand,model_code) → 409;
 *   - POST /customers normalizes phones on save ('0765 447 211' and
 *     '7.53848445E8' both stored canonical '+255…');
 *   - GET /customers?q= finds the SAME customer by name and by EVERY messy
 *     phone format ('0765447211', '+255765447211', '255 765 447211',
 *     '0765 447 211', '7.53848445E8');
 *   - POST /devices links customer + model; scientific-notation IMEI stored
 *     clean; GET /devices?imei= matches any input form;
 *   - GET /customers/{id}/devices returns the customer's devices;
 *   - company scoping holds: company B cannot read company A's customer or
 *     device, by id or via list/search; forged cross-tenant FKs rejected;
 *   - front-desk roles (SERVICE_ADVISOR) can create customers/devices but
 *     NOT models; creations are audited.
 *
 * Fixtures are test-only (prefixed __TEST_1_1__) and removed in afterAll —
 * the real seed stays pristine, which the last test asserts explicitly.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

// Jest does not load /api/.env; default to the local dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

const TEST_PREFIX = '__TEST_1_1__';
const PASSWORD = 'Crm1.1-Pass!';
const ADMIN_EMAIL = 'test-1-1-admin@triserve.test';
const ADVISOR_EMAIL = 'test-1-1-advisor@triserve.test';
const ADMIN_B_EMAIL = 'test-1-1-admin-b@triserve.test';

/** Raw (unextended) client for fixture setup/teardown and row assertions. */
const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string; // seeded "Samsung ASC Group"
let companyBId: string; // __TEST_1_1__ second tenant
let branchDar: string;
let branchKrk: string;
let adminId: string;
let advisorId: string;
let adminBId: string;
let adminToken: string;
let advisorToken: string;
let adminBToken: string;

// Ids created THROUGH THE API during the suite (cleaned up in afterAll).
let modelId: string;
let customerId: string;
let customer2Id: string;
let customerBId: string; // company B's customer
let deviceId: string;

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
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

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const [admin, advisor, adminB] = await Promise.all([
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} Admin`,
        email: ADMIN_EMAIL,
        passwordHash,
        role: 'SUPER_ADMIN',
        scope: 'group',
      },
    }),
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} Advisor`,
        email: ADVISOR_EMAIL,
        passwordHash,
        role: 'SERVICE_ADVISOR',
        scope: 'branch',
        homeBranchId: branchDar,
      },
    }),
    raw.user.create({
      data: {
        companyId: companyBId,
        fullName: `${TEST_PREFIX} Admin B`,
        email: ADMIN_B_EMAIL,
        passwordHash,
        role: 'SUPER_ADMIN',
        scope: 'group',
      },
    }),
  ]);
  adminId = admin.id;
  advisorId = advisor.id;
  adminBId = adminB.id;

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
  app.useGlobalFilters(new AllExceptionsFilter()); // same as main.ts
  await app.init();

  adminToken = await login(ADMIN_EMAIL);
  advisorToken = await login(ADVISOR_EMAIL);
  adminBToken = await login(ADMIN_B_EMAIL);
});

afterAll(async () => {
  // Purge ONLY this suite's leftovers (raw client bypasses the DI append-
  // only audit guard — that guard protects the app surface, not teardown).
  const actorIds = [adminId, advisorId, adminBId].filter(Boolean);
  const entityIds = [
    modelId,
    customerId,
    customer2Id,
    customerBId,
    deviceId,
    adminId,
    advisorId,
    adminBId,
    companyBId,
  ].filter(Boolean);
  await raw.auditLog.deleteMany({
    where: {
      OR: [{ entityId: { in: entityIds } }, { actorUserId: { in: actorIds } }],
    },
  });
  await raw.session.deleteMany({ where: { userId: { in: actorIds } } });
  // Scope deletes to THIS suite's fixtures — a bare companyId filter would wipe
  // the real company's customers/devices/models (e.g. imported data).
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
  await raw.deviceModel.deleteMany({
    where: {
      OR: [
        { companyId: companyBId },
        { modelCode: { startsWith: TEST_PREFIX } },
      ],
    },
  });
  await raw.user.deleteMany({
    where: { email: { in: [ADMIN_EMAIL, ADVISOR_EMAIL, ADMIN_B_EMAIL] } },
  });
  await raw.company.deleteMany({ where: { id: companyBId } });
  await app.close();
  await raw.$disconnect();
});

describe('/api/v1/models (§4.2 lookup)', () => {
  it('POST creates a model (admin); duplicate (brand, model_code) → 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_code: `${TEST_PREFIX}-A05`, category: 'HHP' })
      .expect(201);
    const body = res.body as {
      id: string;
      brand: string;
      category: string;
      active: boolean;
    };
    modelId = body.id;
    expect(body.brand).toBe('Samsung'); // default
    expect(body.category).toBe('HHP');
    expect(body.active).toBe(true);

    await request(app.getHttpServer())
      .post('/api/v1/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_code: `${TEST_PREFIX}-A05`, category: 'HHP' })
      .expect(409);
  });

  it('GET lists it (advisor can read); POST as advisor → 403 (admin-gated)', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/v1/models?q=${TEST_PREFIX}`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);
    const body = list.body as { data: Array<{ id: string }>; total: number };
    expect(body.data.some((m) => m.id === modelId)).toBe(true);

    await request(app.getHttpServer())
      .post('/api/v1/models')
      .set('Authorization', `Bearer ${advisorToken}`)
      .send({ model_code: `${TEST_PREFIX}-NOPE`, category: 'HHP' })
      .expect(403);
  });

  it('invalid category is rejected (native ENUM contract)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/models')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ model_code: `${TEST_PREFIX}-BAD`, category: 'PHONE' })
      .expect(400);
  });
});

describe('/api/v1/customers (front-desk flow, §6.1 step 1)', () => {
  it('POST (as SERVICE_ADVISOR) normalizes phone AND alt_phone on save', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${advisorToken}`)
      .send({
        name: `${TEST_PREFIX} Asha Mrisho`,
        phone: '0765 447 211',
        alt_phone: '7.53848445E8', // Excel scientific-notation artifact
        location: 'Mbezi Beach',
        preferred_branch_id: branchDar,
        preferred_language: 'SW',
        rating: 4,
      })
      .expect(201);
    const body = res.body as Record<string, unknown>;
    customerId = body.id as string;
    expect(body.phone).toBe('0765 447 211'); // raw preserved
    expect(body.phone_normalized).toBe('+255765447211');
    expect(body.preferred_language).toBe('SW');

    const row = await raw.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    expect(row.phoneNormalized).toBe('+255765447211');
    expect(row.altPhone).toBe('7.53848445E8');
    expect(row.altPhoneNormalized).toBe('+255753848445');
    expect(row.companyId).toBe(companyId);
  });

  it('every messy phone format finds the SAME customer via ?q=', async () => {
    const forms = [
      '0765447211',
      '+255765447211',
      '255 765 447211',
      '0765 447 211',
      '7.53848445E8',
    ];
    // The first four are forms of the primary phone; the last is the Excel
    // artifact stored as alt_phone — all must resolve to this one customer.
    for (const q of forms) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/customers?q=${encodeURIComponent(q)}`)
        .set('Authorization', `Bearer ${advisorToken}`)
        .expect(200);
      const body = res.body as { data: Array<{ id: string }>; total: number };
      expect(body.data.map((c) => c.id)).toContain(customerId);
    }
  });

  it('search by name also finds them; paginated envelope is standard', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers?q=${encodeURIComponent('Asha Mrisho')}`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);
    const body = res.body as {
      data: Array<{ id: string }>;
      page: number;
      page_size: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.data.map((c) => c.id)).toContain(customerId);
  });

  it('?branch_id= filters by preferred branch', async () => {
    // NB: as the group-scoped admin — a scope='branch' advisor can only
    // reference their OWN branch (Branch reads are pinned by the scope
    // extension), so a DAR advisor cannot set KRK as a preferred branch.
    const res2 = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `${TEST_PREFIX} Dealer Kariakoo`,
        phone: '0712000001',
        is_dealer: true,
        dealer_name: 'Kariakoo Phones Ltd',
        preferred_branch_id: branchKrk,
      })
      .expect(201);
    customer2Id = (res2.body as { id: string }).id;

    const krk = await request(app.getHttpServer())
      .get(`/api/v1/customers?branch_id=${branchKrk}&q=${TEST_PREFIX}`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);
    const krkBody = krk.body as { data: Array<{ id: string }> };
    expect(krkBody.data.map((c) => c.id)).toContain(customer2Id);
    expect(krkBody.data.map((c) => c.id)).not.toContain(customerId);
  });

  it('GET /customers/{id} returns it; PATCH re-normalizes a changed phone', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${customerId}`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .send({ phone: '255 765 447 999' })
      .expect(200);
    expect((res.body as { phone_normalized: string }).phone_normalized).toBe(
      '+255765447999',
    );
  });

  it('preferred_branch_id from ANOTHER company → 400 (scope-pinned FK check)', async () => {
    const branchB = await raw.branch.create({
      data: {
        companyId: companyBId,
        code: 'TB1',
        name: `${TEST_PREFIX} B branch`,
      },
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/customers/${customerId}`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .send({ preferred_branch_id: branchB.id })
      .expect(400);
    await raw.branch.delete({ where: { id: branchB.id } });
  });
});

describe('/api/v1/devices (§4.2/E3)', () => {
  it('POST creates a device linked to customer + model; sci-notation IMEI stored clean', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${advisorToken}`)
      .send({
        customer_id: customerId,
        model: 'Galaxy A05',
        model_id: modelId,
        category: 'HHP',
        imei_serial: '3.51234567891234E14',
        color: 'Black',
      })
      .expect(201);
    const body = res.body as Record<string, unknown>;
    deviceId = body.id as string;
    expect(body.brand).toBe('Samsung'); // default
    expect(body.customer_id).toBe(customerId);
    expect(body.model_id).toBe(modelId);
    expect(body.imei_serial).toBe('351234567891234'); // expanded + cleaned

    const row = await raw.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(row.companyId).toBe(companyId);
    expect(row.imeiSerial).toBe('351234567891234');
  });

  it('GET /devices?imei= finds it from spaced/dashed/sci-notation input', async () => {
    for (const imei of [
      '351234567891234',
      '351234 5678-91234',
      '3.51234567891234E14',
    ]) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/devices?imei=${encodeURIComponent(imei)}`)
        .set('Authorization', `Bearer ${advisorToken}`)
        .expect(200);
      const body = res.body as { data: Array<{ id: string }>; total: number };
      expect(body.data.map((d) => d.id)).toContain(deviceId);
    }
  });

  it('GET /devices/{id}; PATCH updates it', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/devices/${deviceId}`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/devices/${deviceId}`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .send({ color: 'Awesome Lime' })
      .expect(200);
    expect((res.body as { color: string }).color).toBe('Awesome Lime');
  });

  it('GET /customers/{id}/devices returns the customer devices', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}/devices`)
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);
    const body = res.body as { data: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0].id).toBe(deviceId);
  });

  it('unknown model_id / customer_id → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${advisorToken}`)
      .send({
        customer_id: '00000000-0000-4000-8000-000000000000',
        category: 'HHP',
      })
      .expect(400);
  });
});

describe('company scoping holds (0.3 pattern, on CRM tables)', () => {
  it('company B cannot read company A customer/device by id (404), nor via search', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}`)
      .set('Authorization', `Bearer ${adminBToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/devices/${deviceId}`)
      .set('Authorization', `Bearer ${adminBToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customerId}/devices`)
      .set('Authorization', `Bearer ${adminBToken}`)
      .expect(404);

    const search = await request(app.getHttpServer())
      .get('/api/v1/customers?q=%2B255765447999')
      .set('Authorization', `Bearer ${adminBToken}`)
      .expect(200);
    expect((search.body as { total: number }).total).toBe(0);
  });

  it("company B's customers stay invisible to company A", async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({ name: `${TEST_PREFIX} B-Customer`, phone: '0765447211' })
      .expect(201);
    customerBId = (res.body as { id: string }).id;
    const rowB = await raw.customer.findUniqueOrThrow({
      where: { id: customerBId },
    });
    expect(rowB.companyId).toBe(companyBId); // pinned to B despite same phone

    // Company A searching the same number NEVER sees B's customer.
    const search = await request(app.getHttpServer())
      .get('/api/v1/customers?q=0765447211')
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);
    const ids = (search.body as { data: Array<{ id: string }> }).data.map(
      (c) => c.id,
    );
    expect(ids).not.toContain(customerBId);
  });

  it('company B cannot attach a device to company A customer (forged FK → 400)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({ customer_id: customerId, category: 'HHP' })
      .expect(400);
  });

  it('company B cannot PATCH company A customer (404)', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/customers/${customerId}`)
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({ name: 'hijacked' })
      .expect(404);
  });
});

describe('permission gating + audit trail', () => {
  it('customer/device/model creations are all audited with the right actor', async () => {
    for (const [entityType, entityId, actor] of [
      ['Customer', customerId, advisorId],
      ['Device', deviceId, advisorId],
      ['DeviceModel', modelId, adminId],
    ] as const) {
      const audit = await raw.auditLog.findFirst({
        where: { entityType, entityId, action: 'CREATE' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actorUserId).toBe(actor);
      expect(audit?.companyId).toBe(companyId);
    }
  });

  it('401 without a token on every new surface', async () => {
    for (const path of ['customers', 'devices', 'models']) {
      await request(app.getHttpServer()).get(`/api/v1/${path}`).expect(401);
    }
  });
});

describe('seed stays pristine', () => {
  it('seed intact; CRM tables carry ONLY this suite fixtures (removed in teardown)', async () => {
    expect(
      await raw.company.count({ where: { name: 'Samsung ASC Group' } }),
    ).toBe(1);
    expect(
      await raw.branch.count({
        where: { companyId, code: { in: ['DAR', 'KRK', 'ARU', 'MLM', 'DOD'] } },
      }),
    ).toBe(5);
    expect(
      await raw.paymentMethod.count({ where: { companyId, deletedAt: null } }),
    ).toBe(6);
    const seededAdmin = await raw.user.findUnique({
      where: { email: 'admin@tristate.co.tz' },
    });
    expect(seededAdmin?.active).toBe(true);

    // This suite's fixtures exist exactly (scoped by the test prefix so
    // pre-existing real data, e.g. imports, doesn't skew it); purged in afterAll.
    expect(
      await raw.customer.count({ where: { name: { startsWith: TEST_PREFIX } } }),
    ).toBe(3); // A×2 + B×1
    expect(
      await raw.device.count({
        where: { customer: { name: { startsWith: TEST_PREFIX } } },
      }),
    ).toBe(1);
    expect(
      await raw.deviceModel.count({
        where: { modelCode: { startsWith: TEST_PREFIX } },
      }),
    ).toBe(1);
  });
});
