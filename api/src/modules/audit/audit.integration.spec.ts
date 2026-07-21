/**
 * Integration tests (Task 0.4) proving the append-only audit log against
 * the REAL MySQL database:
 *   - THE SPEC TEST: creating then updating a branch inside a request
 *     context writes exactly two audit rows (CREATE + UPDATE) with correct
 *     before/after snapshots, actor, company, ip and user_agent;
 *   - deletes are audited with before-state;
 *   - mutation + audit row are ATOMIC (a failed update leaves no audit row);
 *   - secrets (password hashes) are redacted from snapshots;
 *   - system writes (no request context) still audit with actor NULL;
 *   - audit_log is append-only through the DI client (update/delete throw);
 *   - GET /api/v1/audit-log works end-to-end: 401 unauthenticated, 403 for
 *     a role without 'audit.read', paginated + filtered rows for an
 *     ACCOUNTANT, company-scoped.
 *
 * Fixtures are test-only (prefixed __TEST_0_4__) and removed in afterAll —
 * the real seed (Samsung ASC Group + 5 branches + 1 admin) stays pristine,
 * which the last test asserts explicitly.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { runWithRequestContext } from '../../common/context/request-context';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { AuditLogEntry } from './audit.service';

// Jest does not load /api/.env; default to the local dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

const TEST_PREFIX = '__TEST_0_4__';
const TEST_IP = '203.0.113.77';
const TEST_UA = 'jest-0.4-audit-suite';
const PASSWORD = 'Audit0.4-Pass!';

/** Raw (unextended) client for fixture setup/teardown and row assertions. */
const raw = new PrismaClient();
/** The DI-shape client: PrismaClient + company-scope + audit extensions. */
const scoped = new PrismaService();

let companyId: string; // the SEEDED company (Samsung ASC Group)
let accountant: { id: string; email: string }; // has 'audit.read'
let technician: { id: string; email: string }; // does NOT have 'audit.read'
/** Every entity id the suite mutates — audit rows are purged by these. */
const touchedEntityIds: string[] = [];

function actor(userId: string): AuthUser {
  return {
    userId,
    sessionId: 'test-session',
    companyId,
    role: 'ACCOUNTANT',
    scope: 'group',
    homeBranchId: null,
  };
}

/** Mirror of the HTTP pipeline: middleware store (ip/ua) + AuthGuard user. */
function asRequest<T>(user: AuthUser, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { user, ip: TEST_IP, userAgent: TEST_UA },
    async () => await fn(),
  );
}

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const [acc, tech] = await Promise.all([
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} Accountant`,
        email: 'test-0-4-accountant@triserve.test',
        passwordHash,
        role: 'ACCOUNTANT',
        scope: 'group',
      },
    }),
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} Technician`,
        email: 'test-0-4-technician@triserve.test',
        passwordHash,
        role: 'TECHNICIAN',
        scope: 'group',
      },
    }),
  ]);
  accountant = { id: acc.id, email: acc.email };
  technician = { id: tech.id, email: tech.email };
});

afterAll(async () => {
  // Purge ONLY this suite's leftovers (raw client bypasses the DI append-
  // only guard — that guard protects the app surface, not test teardown).
  const userIds = [accountant?.id, technician?.id].filter(Boolean);
  await raw.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: [...touchedEntityIds, ...userIds] } },
        { actorUserId: { in: userIds } },
      ],
    },
  });
  await raw.session.deleteMany({ where: { userId: { in: userIds } } });
  await raw.branch.deleteMany({
    where: { companyId, name: { startsWith: TEST_PREFIX } },
  });
  await raw.user.deleteMany({ where: { id: { in: userIds } } });
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('audit extension — automatic interception (THE SPEC TEST)', () => {
  it('branch CREATE then UPDATE writes exactly two audit rows with correct before/after and actor', async () => {
    const created = await asRequest(actor(accountant.id), () =>
      scoped.branch.create({
        data: { companyId, code: 'ZT4', name: `${TEST_PREFIX} Audit Branch` },
      }),
    );
    touchedEntityIds.push(created.id);

    await asRequest(actor(accountant.id), () =>
      scoped.branch.update({
        where: { id: created.id },
        data: { name: `${TEST_PREFIX} Audit Branch (renamed)`, phone: '0755' },
      }),
    );

    const rows = await raw.auditLog.findMany({
      where: { entityId: created.id },
      orderBy: { at: 'asc' },
    });
    expect(rows).toHaveLength(2); // exactly two — CREATE + UPDATE

    const [createRow, updateRow] = rows;

    // --- CREATE row ---------------------------------------------------
    expect(createRow.action).toBe('CREATE');
    expect(createRow.entityType).toBe('Branch');
    expect(createRow.entityId).toBe(created.id);
    expect(createRow.companyId).toBe(companyId);
    expect(createRow.branchId).toBe(created.id); // a Branch is its own branch
    expect(createRow.actorUserId).toBe(accountant.id);
    expect(createRow.ip).toBe(TEST_IP);
    expect(createRow.userAgent).toBe(TEST_UA);
    expect(createRow.beforeJson).toBeNull();
    const after = createRow.afterJson as Record<string, unknown>;
    expect(after.name).toBe(`${TEST_PREFIX} Audit Branch`);
    expect(after.code).toBe('ZT4');
    expect(after.companyId).toBe(companyId);

    // --- UPDATE row ---------------------------------------------------
    expect(updateRow.action).toBe('UPDATE');
    expect(updateRow.actorUserId).toBe(accountant.id);
    expect(updateRow.companyId).toBe(companyId);
    const before2 = updateRow.beforeJson as Record<string, unknown>;
    const after2 = updateRow.afterJson as Record<string, unknown>;
    expect(before2.name).toBe(`${TEST_PREFIX} Audit Branch`);
    expect(before2.phone).toBeNull();
    expect(after2.name).toBe(`${TEST_PREFIX} Audit Branch (renamed)`);
    expect(after2.phone).toBe('0755');
  });

  it('branch DELETE writes a third row: before populated, after null', async () => {
    const branch = await asRequest(actor(accountant.id), () =>
      scoped.branch.create({
        data: { companyId, code: 'ZT5', name: `${TEST_PREFIX} To Delete` },
      }),
    );
    touchedEntityIds.push(branch.id);

    await asRequest(actor(accountant.id), () =>
      scoped.branch.delete({ where: { id: branch.id } }),
    );

    const rows = await raw.auditLog.findMany({
      where: { entityId: branch.id },
      orderBy: { at: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'DELETE']);
    const del = rows[1];
    expect((del.beforeJson as Record<string, unknown>).name).toBe(
      `${TEST_PREFIX} To Delete`,
    );
    expect(del.afterJson).toBeNull();
    expect(del.actorUserId).toBe(accountant.id);
  });

  it('mutation + audit row are atomic: a FAILED update leaves no audit row', async () => {
    const branch = await asRequest(actor(accountant.id), () =>
      scoped.branch.create({
        data: { companyId, code: 'ZT6', name: `${TEST_PREFIX} Atomicity` },
      }),
    );
    touchedEntityIds.push(branch.id);

    // 'DAR' already exists in the seeded company → unique(companyId, code)
    // violation → the whole tx (update + would-be audit row) rolls back.
    await expect(
      asRequest(actor(accountant.id), () =>
        scoped.branch.update({
          where: { id: branch.id },
          data: { code: 'DAR' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });

    const rows = await raw.auditLog.findMany({
      where: { entityId: branch.id },
    });
    expect(rows.map((r) => r.action)).toEqual(['CREATE']); // no UPDATE row
    const intact = await raw.branch.findUnique({ where: { id: branch.id } });
    expect(intact?.code).toBe('ZT6');
  });

  it('user snapshots REDACT the password hash', async () => {
    const user = await asRequest(actor(accountant.id), () =>
      scoped.user.create({
        data: {
          companyId,
          fullName: `${TEST_PREFIX} Snapshot Redaction`,
          email: 'test-0-4-redaction@triserve.test',
          passwordHash: 'super-secret-argon2-hash',
          role: 'TECHNICIAN',
        },
      }),
    );
    touchedEntityIds.push(user.id);

    const row = await raw.auditLog.findFirstOrThrow({
      where: { entityId: user.id, action: 'CREATE' },
    });
    const after = row.afterJson as Record<string, unknown>;
    expect(after.passwordHash).toBe('[REDACTED]');
    expect(after.email).toBe('test-0-4-redaction@triserve.test');

    await raw.user.delete({ where: { id: user.id } });
  });

  it('system writes (no request context) still audit, with actor NULL', async () => {
    const branch = await scoped.branch.create({
      data: {
        companyId, // explicit: no context → no company-scope injection
        code: 'ZT7',
        name: `${TEST_PREFIX} System Write`,
      },
    });
    touchedEntityIds.push(branch.id);

    const row = await raw.auditLog.findFirstOrThrow({
      where: { entityId: branch.id, action: 'CREATE' },
    });
    expect(row.actorUserId).toBeNull();
    expect(row.companyId).toBe(companyId); // derived from the row itself
    expect(row.ip).toBeNull();
    expect(row.userAgent).toBeNull();

    await raw.branch.delete({ where: { id: branch.id } });
  });
});

describe('audit_log is append-only on the DI client', () => {
  it.each(['update', 'updateMany', 'delete', 'deleteMany'] as const)(
    '%s throws',
    async (op) => {
      const args = { where: { id: 'any' }, data: { ip: 'x' } };
      await expect(
        (
          scoped.auditLog as unknown as Record<
            string,
            (a: unknown) => Promise<unknown>
          >
        )[op](args),
      ).rejects.toThrow(/append-only/);
    },
  );

  it('createMany on an audited model fails closed (cannot capture rows)', async () => {
    await expect(
      asRequest(actor(accountant.id), () =>
        scoped.branch.createMany({
          data: [{ companyId, code: 'ZT8', name: `${TEST_PREFIX} bulk` }],
        }),
      ),
    ).rejects.toThrow(/createMany on audited model/);
  });
});

describe('GET /api/v1/audit-log (end-to-end)', () => {
  let app: INestApplication<App>;
  let accountantToken: string;
  let technicianToken: string;
  let branchId: string;

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  beforeAll(async () => {
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

    accountantToken = await login(accountant.email);
    technicianToken = await login(technician.email);

    // One CREATE + one UPDATE through the plain client, so the endpoint has
    // known rows to page over.
    const branch = await asRequest(actor(accountant.id), () =>
      scoped.branch.create({
        data: { companyId, code: 'ZT9', name: `${TEST_PREFIX} Endpoint` },
      }),
    );
    branchId = branch.id;
    touchedEntityIds.push(branchId);
    await asRequest(actor(accountant.id), () =>
      scoped.branch.update({
        where: { id: branchId },
        data: { name: `${TEST_PREFIX} Endpoint v2` },
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/audit-log').expect(401);
  });

  it("403 for a role without 'audit.read' (TECHNICIAN)", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-log')
      .set('Authorization', `Bearer ${technicianToken}`)
      .expect(403);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'FORBIDDEN',
    );
  });

  it('ACCOUNTANT gets filtered rows in the { data, page, page_size, total } envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-log')
      .query({ entity_type: 'Branch', entity_id: branchId })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);

    const body = res.body as {
      data: AuditLogEntry[];
      page: number;
      page_size: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);
    // Newest first.
    expect(body.data.map((r) => r.action)).toEqual(['UPDATE', 'CREATE']);
    for (const row of body.data) {
      expect(row.company_id).toBe(companyId);
      expect(row.entity_type).toBe('Branch');
      expect(row.entity_id).toBe(branchId);
      expect(row.actor_user_id).toBe(accountant.id);
    }
    expect(body.data[1].before_json).toBeNull();
    expect((body.data[0].before_json as Record<string, unknown>).name).toBe(
      `${TEST_PREFIX} Endpoint`,
    );
  });

  it('paginates (page_size=1, page=2 → the CREATE row)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-log')
      .query({ entity_id: branchId, page_size: 1, page: 2 })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);

    const body = res.body as { data: AuditLogEntry[]; total: number };
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].action).toBe('CREATE');
  });

  it('filters by actor_user_id and time window', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-log')
      .query({
        actor_user_id: accountant.id,
        from: '2000-01-01T00:00:00.000Z',
        to: '2100-01-01T00:00:00.000Z',
      })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(200);
    const body = res.body as { data: AuditLogEntry[]; total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.data.every((r) => r.actor_user_id === accountant.id)).toBe(
      true,
    );
  });

  it('rejects an invalid page (validation)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/audit-log')
      .query({ page: 0 })
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(400);
  });
});

describe('real seed data stays intact', () => {
  it('Samsung ASC Group + 5 branches + 1 super admin, un-duplicated', async () => {
    const samsung = await raw.company.findMany({
      where: { name: 'Samsung ASC Group' },
    });
    expect(samsung.length).toBe(1);
    const branchCount = await raw.branch.count({
      where: {
        companyId: samsung[0].id,
        NOT: { name: { startsWith: '__TEST_' } },
      },
    });
    expect(branchCount).toBe(5);
    const adminCount = await raw.user.count({
      where: { companyId: samsung[0].id, role: 'SUPER_ADMIN' },
    });
    expect(adminCount).toBe(1);
  });
});
