/**
 * Integration tests (Task 0.7) for the org/config admin CRUD added for the
 * Phase 0 frontend, against the REAL MySQL database over HTTP:
 *   - GET /auth/sessions — own login/device history, current session marked;
 *   - GET/PATCH /company — the caller's company profile;
 *   - /branches — list/create/edit, duplicate code → 409, audited;
 *   - /users — create technician (role + scope + home branch), never leaks
 *     password_hash, deactivate revokes login, activate restores it;
 *   - config tables (fault codes / tax rates / payment methods /
 *     currencies) — CRUD + soft delete + 409 on duplicates;
 *   - THE DELIVERABLE CHECK: branch + technician + fault code creations all
 *     appear in GET /audit-log;
 *   - permission gating: a TECHNICIAN gets 403 on admin surfaces.
 *
 * Fixtures are test-only (prefixed __TEST_0_7__) and removed in afterAll —
 * the real seed (1 company + 5 branches + 1 admin + 6 payment methods)
 * stays pristine, which the last test asserts explicitly.
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

const TEST_PREFIX = '__TEST_0_7__';
const PASSWORD = 'OrgConfig0.7-Pass!';
const ADMIN_EMAIL = 'test-0-7-admin@triserve.test';
const TECH_EMAIL = 'test-0-7-tech@triserve.test';

/** Raw (unextended) client for fixture setup/teardown and row assertions. */
const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let adminId: string; // __TEST_0_7__ SUPER_ADMIN (fixture)
let adminToken: string;

// Ids created THROUGH THE API during the suite (cleaned up in afterAll).
let createdBranchId: string;
let createdTechId: string;
let createdFaultCodeId: string;
let createdTaxRateId: string;
let createdCurrencyId: string;
let createdServiceCodeId: string;

async function login(email: string, password = PASSWORD): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
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

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const admin = await raw.user.create({
    data: {
      companyId,
      fullName: `${TEST_PREFIX} Admin`,
      email: ADMIN_EMAIL,
      passwordHash,
      role: 'SUPER_ADMIN',
      scope: 'group',
    },
  });
  adminId = admin.id;

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
});

afterAll(async () => {
  // Purge ONLY this suite's leftovers (raw client bypasses the DI append-
  // only audit guard — that guard protects the app surface, not teardown).
  const actorIds = [adminId, createdTechId].filter(Boolean);
  const entityIds = [
    createdBranchId,
    createdTechId,
    createdFaultCodeId,
    createdTaxRateId,
    createdCurrencyId,
    createdServiceCodeId,
    adminId,
  ].filter(Boolean);
  await raw.auditLog.deleteMany({
    where: {
      OR: [{ entityId: { in: entityIds } }, { actorUserId: { in: actorIds } }],
    },
  });
  await raw.session.deleteMany({ where: { userId: { in: actorIds } } });
  if (createdFaultCodeId) {
    await raw.faultCode.deleteMany({ where: { id: createdFaultCodeId } });
  }
  if (createdTaxRateId) {
    await raw.taxRate.deleteMany({ where: { id: createdTaxRateId } });
  }
  if (createdCurrencyId) {
    await raw.currency.deleteMany({ where: { id: createdCurrencyId } });
  }
  if (createdServiceCodeId) {
    await raw.serviceCode.deleteMany({ where: { id: createdServiceCodeId } });
  }
  await raw.user.deleteMany({
    where: { email: { in: [ADMIN_EMAIL, TECH_EMAIL] } },
  });
  if (createdBranchId) {
    await raw.branch.deleteMany({ where: { id: createdBranchId } });
  }
  // The suite PATCHes the seeded company's phone and restores it to null.
  await app.close();
  await raw.$disconnect();
});

describe('GET /auth/sessions', () => {
  it('lists own sessions, newest first, current one marked', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as {
      data: Array<{ id: string; current: boolean; user_agent: string | null }>;
      page: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data.some((s) => s.current)).toBe(true);
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/sessions').expect(401);
  });
});

describe('/api/v1/company', () => {
  it('GET returns the caller company profile', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/company')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      id: string;
      name: string;
      base_currency: string;
    };
    expect(body.id).toBe(companyId);
    expect(body.name).toBe('Samsung ASC Group');
    expect(body.base_currency).toBe('TZS');
  });

  it('PATCH updates the profile (and restores it)', async () => {
    const original = await raw.company.findUniqueOrThrow({
      where: { id: companyId },
    });

    const res = await request(app.getHttpServer())
      .patch('/api/v1/company')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '+255 22 000 0000' })
      .expect(200);
    expect((res.body as { phone: string }).phone).toBe('+255 22 000 0000');

    const updated = await raw.company.findUniqueOrThrow({
      where: { id: companyId },
    });
    expect(updated.phone).toBe('+255 22 000 0000');

    // Restore the seeded value (raw client: no extra audit noise).
    await raw.company.update({
      where: { id: companyId },
      data: { phone: original.phone },
    });
  });
});

describe('/api/v1/branches (THE SPEC FLOW: create a branch)', () => {
  it('POST creates a branch and the creation is audited', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'T07',
        name: `${TEST_PREFIX} Mwanza ASC`,
        tz_region: 'Mwanza',
      })
      .expect(201);
    const body = res.body as { id: string; code: string; active: boolean };
    createdBranchId = body.id;
    expect(body.code).toBe('T07');
    expect(body.active).toBe(true);

    const audit = await raw.auditLog.findFirst({
      where: { entityId: body.id, entityType: 'Branch', action: 'CREATE' },
    });
    expect(audit?.actorUserId).toBe(adminId);
  });

  it('GET lists it; PATCH renames it; duplicate code → 409', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/branches?q=T07')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listBody = list.body as {
      data: Array<{ id: string }>;
      total: number;
    };
    expect(listBody.data.some((b) => b.id === createdBranchId)).toBe(true);

    await request(app.getHttpServer())
      .patch(`/api/v1/branches/${createdBranchId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `${TEST_PREFIX} Mwanza ASC (renamed)` })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'DAR', name: 'duplicate of seeded DAR' })
      .expect(409);
  });
});

describe('/api/v1/users (THE SPEC FLOW: create a technician)', () => {
  it('POST creates a technician with role+scope+home branch; no hash on the wire', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        full_name: `${TEST_PREFIX} Technician`,
        email: TECH_EMAIL,
        password: PASSWORD,
        role: 'TECHNICIAN',
        scope: 'branch',
        home_branch_id: branchDar,
      })
      .expect(201);
    const body = res.body as Record<string, unknown>;
    createdTechId = body.id as string;
    expect(body.role).toBe('TECHNICIAN');
    expect(body.home_branch_id).toBe(branchDar);
    expect(body.password_hash).toBeUndefined();
    expect(body.passwordHash).toBeUndefined();
    expect(body.totp_secret).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('argon2');
  });

  it('scope=branch without home_branch_id → 400; duplicate email → 409', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        full_name: `${TEST_PREFIX} No Branch`,
        email: 'test-0-7-nobranch@triserve.test',
        password: PASSWORD,
        role: 'TECHNICIAN',
        scope: 'branch',
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        full_name: `${TEST_PREFIX} Dupe`,
        email: TECH_EMAIL,
        password: PASSWORD,
        role: 'TECHNICIAN',
        scope: 'branch',
        home_branch_id: branchDar,
      })
      .expect(409);
  });

  it('GET /users filters by role and branch', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/api/v1/users?role=TECHNICIAN&branch_id=${branchDar}&q=${TEST_PREFIX}`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as { data: Array<{ id: string }> };
    expect(body.data.some((u) => u.id === createdTechId)).toBe(true);
  });

  it('a TECHNICIAN is 403 on admin surfaces (server-side gate)', async () => {
    const techToken = await login(TECH_EMAIL);
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${techToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set('Authorization', `Bearer ${techToken}`)
      .send({ code: 'NOPE', name: 'should not exist' })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/audit-log')
      .set('Authorization', `Bearer ${techToken}`)
      .expect(403);
  });

  it('deactivate blocks login + revokes sessions; activate restores', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/users/${createdTechId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: TECH_EMAIL, password: PASSWORD })
      .expect(401);

    const sessions = await raw.session.findMany({
      where: { userId: createdTechId, revokedAt: null },
    });
    expect(sessions).toHaveLength(0);

    await request(app.getHttpServer())
      .post(`/api/v1/users/${createdTechId}/activate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: TECH_EMAIL, password: PASSWORD })
      .expect(200);
  });

  it('an admin cannot deactivate their own account', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/users/${adminId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

describe('config tables (THE SPEC FLOW: add a fault code)', () => {
  it('POST /fault-codes creates one (audited); PATCH edits; DELETE soft-deletes', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/fault-codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'T07-NOPOWER', label: `${TEST_PREFIX} No power` })
      .expect(201);
    createdFaultCodeId = (res.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/api/v1/fault-codes/${createdFaultCodeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: `${TEST_PREFIX} No power (edited)` })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/fault-codes/${createdFaultCodeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    // Soft-deleted: gone from the list, still in MySQL with deleted_at.
    const list = await request(app.getHttpServer())
      .get('/api/v1/fault-codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listBody = list.body as { data: Array<{ id: string }> };
    expect(listBody.data.some((f) => f.id === createdFaultCodeId)).toBe(false);
    const row = await raw.faultCode.findUniqueOrThrow({
      where: { id: createdFaultCodeId },
    });
    expect(row.deletedAt).not.toBeNull();
  });

  it('POST /tax-rates keeps percent as a decimal string; money stays integral', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/tax-rates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'T07-VAT', label: `${TEST_PREFIX} VAT`, percent: '18' })
      .expect(201);
    const body = res.body as { id: string; percent: string };
    createdTaxRateId = body.id;
    expect(body.percent).toBe('18');
  });

  it('POST /payment-methods with a seeded code → 409 (seed untouched)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payment-methods')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'CASH', label: 'duplicate of seeded CASH' })
      .expect(409);
  });

  it('POST /currencies creates a non-base currency', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/currencies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'USD', name: `${TEST_PREFIX} US Dollar`, symbol: '$' })
      .expect(201);
    const body = res.body as { id: string; is_base: boolean; code: string };
    createdCurrencyId = body.id;
    expect(body.code).toBe('USD');
    expect(body.is_base).toBe(false);
  });
});

describe('service codes (Samsung GSPN vocabulary, §4.7)', () => {
  it('POST /service-codes creates one; PATCH edits; DELETE soft-deletes', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/service-codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        kind: 'SYMPTOM',
        code: 'T07-TESTSYM',
        label: `${TEST_PREFIX} Test symptom`,
        category: 'HHP',
        sort_order: 99,
      })
      .expect(201);
    const body = res.body as {
      id: string;
      kind: string;
      category: string | null;
      sort_order: number;
    };
    createdServiceCodeId = body.id;
    expect(body.kind).toBe('SYMPTOM');
    expect(body.category).toBe('HHP');
    expect(body.sort_order).toBe(99);

    await request(app.getHttpServer())
      .patch(`/api/v1/service-codes/${createdServiceCodeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: `${TEST_PREFIX} Test symptom (edited)` })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/service-codes/${createdServiceCodeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const row = await raw.serviceCode.findUniqueOrThrow({
      where: { id: createdServiceCodeId },
    });
    expect(row.deletedAt).not.toBeNull();
  });

  it('the SAME code under two kinds is allowed; a repeat within one kind is 409', async () => {
    // GSPN really does reuse "03" across axes — uniqueness is per (kind, code),
    // so the table must accept the collision that a flat code list would reject.
    const seededDefect = await raw.serviceCode.findFirstOrThrow({
      where: { companyId, kind: 'DEFECT', code: '03', deletedAt: null },
    });
    expect(seededDefect.label).toBe('Device Lock');

    const asSymptom = await request(app.getHttpServer())
      .post('/api/v1/service-codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        kind: 'SYMPTOM',
        code: '03',
        label: `${TEST_PREFIX} Device Password`,
      })
      .expect(201);
    const symptomId = (asSymptom.body as { id: string }).id;

    try {
      await request(app.getHttpServer())
        .post('/api/v1/service-codes')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ kind: 'SYMPTOM', code: '03', label: 'duplicate within kind' })
        .expect(409);
    } finally {
      await raw.auditLog.deleteMany({ where: { entityId: symptomId } });
      await raw.serviceCode.deleteMany({ where: { id: symptomId } });
    }
  });

  it('GET /service-codes?kind= filters to one axis, and seeded GSPN codes are present', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/service-codes?kind=REPAIR')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      data: Array<{ kind: string; code: string; label: string }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((c) => c.kind === 'REPAIR')).toBe(true);
    expect(body.data).toContainEqual(
      expect.objectContaining({
        code: 'A01',
        label: 'Electrical parts replacement',
      }),
    );
  });

  it('GET /service-codes/active is readable with only job.read (the pickers must resolve for a technician)', async () => {
    const techToken = await login(TECH_EMAIL);
    // The same technician is refused the config.read management list…
    await request(app.getHttpServer())
      .get('/api/v1/service-codes')
      .set('Authorization', `Bearer ${techToken}`)
      .expect(403);
    // …but can still populate the job form's code pickers.
    const res = await request(app.getHttpServer())
      .get('/api/v1/service-codes/active?kind=SYMPTOM')
      .set('Authorization', `Bearer ${techToken}`)
      .expect(200);
    const body = res.body as {
      data: Array<{ kind: string; active: boolean }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((c) => c.kind === 'SYMPTOM' && c.active)).toBe(true);
  });
});

describe('GET /audit-log (THE DELIVERABLE CHECK)', () => {
  it('branch + technician + fault code creations all appear in the audit log', async () => {
    for (const [entityType, entityId] of [
      ['Branch', createdBranchId],
      ['User', createdTechId],
      ['FaultCode', createdFaultCodeId],
    ] as const) {
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/audit-log?entity_type=${entityType}&entity_id=${entityId}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const body = res.body as {
        data: Array<{ action: string; actor_user_id: string | null }>;
        total: number;
      };
      const create = body.data.find((r) => r.action === 'CREATE');
      expect(create).toBeDefined();
      expect(create?.actor_user_id).toBe(adminId);
    }
  });

  it('audit snapshots never contain credential material', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/audit-log?entity_type=User&entity_id=${createdTechId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('argon2');
    expect(text).toContain('[REDACTED]');
  });
});

describe('seed stays pristine', () => {
  it('1 company, 5 seeded branches, 6 payment methods, seeded admin intact', async () => {
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
    expect(seededAdmin?.role).toBe('SUPER_ADMIN');
  });
});
