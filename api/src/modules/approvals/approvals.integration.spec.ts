/**
 * Integration tests (Task 0.5) proving the generic approvals framework
 * against the REAL MySQL database:
 *   - THE SPEC TEST: request() creates a PENDING approval; a manager's
 *     approve() transitions it to APPROVED, stamps approved_by/decided_at,
 *     and writes an audit row with action=APPROVE;
 *   - a non-manager (TECHNICIAN, no 'approval.decide') cannot decide —
 *     403 at the endpoint AND ForbiddenException at the service;
 *   - rejecting requires a reason and sets REJECTED (+ audit REJECT);
 *   - double-decides are refused with 409 CONFLICT;
 *   - isRequired() against the SEEDED rules: REFUND 150,000 TZS → required,
 *     50,000 → not; PRICE_OVERRIDE 12% → required, 5% → not; plus pure
 *     ruleRequiresApproval unit cases;
 *   - endpoints: GET /approvals (filters + pagination envelope),
 *     POST /approvals, POST /approvals/{id}/approve|reject, 401/403/404.
 *
 * Fixtures are test-only (prefixed __TEST_0_5__) and removed in afterAll —
 * the real seed (Samsung ASC Group + 5 branches + 1 admin + 2 approval
 * rules) stays pristine, which the last test asserts explicitly.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { runWithRequestContext } from '../../common/context/request-context';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  ApprovalsService,
  ruleRequiresApproval,
  type ApprovalEntry,
} from './approvals.service';

// Jest does not load /api/.env; default to the local dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_0_5__';
const PASSWORD = 'Approvals0.5-Pass!';

/** TZS major units → BIGINT minor units (senti), per the money convention. */
const tzs = (amount: number): bigint => BigInt(amount) * 100n;

/** Raw (unextended) client for fixture setup/teardown and row assertions. */
const raw = new PrismaClient();
/** The DI-shape client: PrismaClient + company-scope + audit extensions. */
const scoped = new PrismaService();
/** Service under test, wired exactly as in the DI container. */
const service = new ApprovalsService(scoped, new AuditService(scoped), new PermissionResolverService(scoped));

let companyId: string; // the SEEDED company (Samsung ASC Group)
let branchDar: string; // seeded DAR branch
let branchAru: string; // seeded ARU branch
let manager: { id: string; email: string }; // BRANCH_MANAGER — 'approval.decide'
let technician: { id: string; email: string }; // TECHNICIAN — no 'approval.decide'
/** Approval ids created by the suite — audit rows are purged by these. */
const approvalIds: string[] = [];

function managerActor(): AuthUser {
  return {
    userId: manager.id,
    sessionId: 'test-session',
    companyId,
    role: 'BRANCH_MANAGER',
    scope: 'branch',
    homeBranchId: branchDar,
  };
}

function technicianActor(): AuthUser {
  return {
    userId: technician.id,
    sessionId: 'test-session',
    companyId,
    role: 'TECHNICIAN',
    scope: 'branch',
    homeBranchId: branchDar,
  };
}

/** Mirror of the HTTP pipeline: request-context store + AuthGuard user. */
function asRequest<T>(user: AuthUser, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ user }, async () => await fn());
}

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;
  branchAru = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'ARU' } })
  ).id;

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const [mgr, tech] = await Promise.all([
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} Manager`,
        email: 'test-0-5-manager@triserve.test',
        passwordHash,
        role: 'BRANCH_MANAGER',
        scope: 'branch',
        homeBranchId: branchDar,
      },
    }),
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} Technician`,
        email: 'test-0-5-technician@triserve.test',
        passwordHash,
        role: 'TECHNICIAN',
        scope: 'branch',
        homeBranchId: branchDar,
      },
    }),
  ]);
  manager = { id: mgr.id, email: mgr.email };
  technician = { id: tech.id, email: tech.email };
});

afterAll(async () => {
  // Purge ONLY this suite's leftovers (raw client bypasses the DI append-
  // only audit guard — that guard protects the app surface, not teardown).
  const userIds = [manager?.id, technician?.id].filter(Boolean);
  await raw.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: [...approvalIds, ...userIds] } },
        { actorUserId: { in: userIds } },
      ],
    },
  });
  await raw.approval.deleteMany({ where: { id: { in: approvalIds } } });
  await raw.approval.deleteMany({
    where: { companyId, requestedById: { in: userIds } },
  });
  await raw.session.deleteMany({ where: { userId: { in: userIds } } });
  await raw.user.deleteMany({ where: { id: { in: userIds } } });
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('ApprovalsService.request → decide (THE SPEC TEST)', () => {
  let approvalId: string;

  it('request() creates a PENDING approval stamped with the requester', async () => {
    const entry = await asRequest(technicianActor(), () =>
      service.request('REFUND', {
        branchId: branchDar,
        refType: 'Invoice',
        refId: null,
        payload: { amount: '15000000', currency: 'TZS' },
        reason: `${TEST_PREFIX} customer refund over threshold`,
      }),
    );
    approvalId = entry.id;
    approvalIds.push(entry.id);

    expect(entry.status).toBe('PENDING');
    expect(entry.type).toBe('REFUND');
    expect(entry.company_id).toBe(companyId);
    expect(entry.branch_id).toBe(branchDar);
    expect(entry.requested_by).toBe(technician.id);
    expect(entry.approved_by).toBeNull();
    expect(entry.decided_at).toBeNull();
    expect(entry.requested_at).toBeTruthy();
    expect(entry.payload_json).toEqual({
      amount: '15000000',
      currency: 'TZS',
    });

    // Row really is in MySQL, and its creation was audited (CREATE).
    const row = await raw.approval.findUniqueOrThrow({
      where: { id: entry.id },
    });
    expect(row.status).toBe('PENDING');
    const createAudit = await raw.auditLog.findFirst({
      where: { entityId: entry.id, action: 'CREATE' },
    });
    expect(createAudit?.entityType).toBe('Approval');
    expect(createAudit?.actorUserId).toBe(technician.id);
  });

  it('approve() → APPROVED, approver + decided_at stamped, audit action=APPROVE written', async () => {
    const before = Date.now();
    const entry = await asRequest(managerActor(), () =>
      service.decide(approvalId, 'APPROVED', managerActor()),
    );

    expect(entry.status).toBe('APPROVED');
    expect(entry.approved_by).toBe(manager.id);
    expect(entry.decided_at).not.toBeNull();
    expect(new Date(entry.decided_at!).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    // Approve without a new reason keeps the requester's justification.
    expect(entry.reason).toBe(`${TEST_PREFIX} customer refund over threshold`);

    const audit = await raw.auditLog.findFirst({
      where: { entityId: approvalId, action: 'APPROVE' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.entityType).toBe('Approval');
    expect(audit?.actorUserId).toBe(manager.id);
    expect(audit?.companyId).toBe(companyId);
    expect(audit?.branchId).toBe(branchDar);
    expect((audit?.beforeJson as Record<string, unknown>).status).toBe(
      'PENDING',
    );
    expect((audit?.afterJson as Record<string, unknown>).status).toBe(
      'APPROVED',
    );
  });

  it('double-decide is refused with 409 CONFLICT', async () => {
    await expect(
      asRequest(managerActor(), () =>
        service.decide(approvalId, 'REJECTED', managerActor(), 'too late'),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a non-manager cannot decide (service-level defense in depth)', async () => {
    const entry = await asRequest(technicianActor(), () =>
      service.request('REOPEN_JOB', {
        branchId: branchDar,
        reason: `${TEST_PREFIX} reopen for missed fault`,
      }),
    );
    approvalIds.push(entry.id);

    await expect(
      asRequest(technicianActor(), () =>
        service.decide(entry.id, 'APPROVED', technicianActor()),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('reject requires a reason, then sets REJECTED (+ audit REJECT)', async () => {
    const entry = await asRequest(technicianActor(), () =>
      service.request('INVENTORY_ADJUSTMENT', {
        branchId: branchDar,
        reason: `${TEST_PREFIX} stock count variance`,
      }),
    );
    approvalIds.push(entry.id);

    await expect(
      asRequest(managerActor(), () =>
        service.decide(entry.id, 'REJECTED', managerActor()),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const rejected = await asRequest(managerActor(), () =>
      service.decide(
        entry.id,
        'REJECTED',
        managerActor(),
        'variance not evidenced',
      ),
    );
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.approved_by).toBe(manager.id);
    expect(rejected.decided_at).not.toBeNull();
    expect(rejected.reason).toBe('variance not evidenced');

    const audit = await raw.auditLog.findFirst({
      where: { entityId: entry.id, action: 'REJECT' },
    });
    expect(audit?.actorUserId).toBe(manager.id);
    expect((audit?.afterJson as Record<string, unknown>).status).toBe(
      'REJECTED',
    );
  });

  it('a branch-scoped user cannot request an approval for another branch', async () => {
    await expect(
      asRequest(technicianActor(), () =>
        service.request('REFUND', {
          branchId: branchAru, // not the technician's home branch
          reason: `${TEST_PREFIX} cross-branch attempt`,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('ApprovalsService.isRequired against the SEEDED rules', () => {
  it('REFUND of 150,000 TZS → required', async () => {
    const { required, rule } = await asRequest(technicianActor(), () =>
      service.isRequired('REFUND', { amount: tzs(150_000) }),
    );
    expect(required).toBe(true);
    expect(rule?.type).toBe('REFUND');
    expect(rule?.thresholdAmount).toBe(tzs(100_000));
  });

  it('REFUND of 50,000 TZS → not required', async () => {
    const { required } = await asRequest(technicianActor(), () =>
      service.isRequired('REFUND', { amount: tzs(50_000) }),
    );
    expect(required).toBe(false);
  });

  it('PRICE_OVERRIDE of 12% → required', async () => {
    const { required, rule } = await asRequest(technicianActor(), () =>
      service.isRequired('PRICE_OVERRIDE', { percent: 12 }),
    );
    expect(required).toBe(true);
    expect(rule?.thresholdPercent?.toNumber()).toBe(10);
  });

  it('PRICE_OVERRIDE of 5% → not required', async () => {
    const { required } = await asRequest(technicianActor(), () =>
      service.isRequired('PRICE_OVERRIDE', { percent: 5 }),
    );
    expect(required).toBe(false);
  });

  it('a type with NO rule (INVOICE_VOID) → never required', async () => {
    const { required, rule } = await asRequest(technicianActor(), () =>
      service.isRequired('INVOICE_VOID', { amount: tzs(9_999_999) }),
    );
    expect(required).toBe(false);
    expect(rule).toBeNull();
  });

  it('works outside a request context when companyId is passed explicitly', async () => {
    const { required } = await service.isRequired(
      'REFUND',
      { amount: tzs(100_000) }, // boundary: threshold is INCLUSIVE
      companyId,
    );
    expect(required).toBe(true);
  });
});

describe('ruleRequiresApproval (pure threshold logic)', () => {
  const rule = (over: {
    enabled?: boolean;
    thresholdAmount?: bigint | null;
    thresholdPercent?: Prisma.Decimal | null;
  }) => ({
    enabled: over.enabled ?? true,
    thresholdAmount: over.thresholdAmount ?? null,
    thresholdPercent: over.thresholdPercent ?? null,
  });

  it('no rule → false', () => {
    expect(ruleRequiresApproval(null, { amount: 999_999_999n })).toBe(false);
  });

  it('disabled rule → false even over threshold', () => {
    expect(
      ruleRequiresApproval(rule({ enabled: false, thresholdAmount: 100n }), {
        amount: 200n,
      }),
    ).toBe(false);
  });

  it('amount threshold is inclusive (>=)', () => {
    const r = rule({ thresholdAmount: 100n });
    expect(ruleRequiresApproval(r, { amount: 99n })).toBe(false);
    expect(ruleRequiresApproval(r, { amount: 100n })).toBe(true);
    expect(ruleRequiresApproval(r, { amount: 101n })).toBe(true);
  });

  it('percent threshold is inclusive (>=) and Decimal-safe', () => {
    const r = rule({ thresholdPercent: new Prisma.Decimal('10') });
    expect(ruleRequiresApproval(r, { percent: 9.999 })).toBe(false);
    expect(ruleRequiresApproval(r, { percent: 10 })).toBe(true);
    expect(ruleRequiresApproval(r, { percent: '10.5' })).toBe(true);
  });

  it('thresholds are OR-ed; missing context dimension never trips', () => {
    const r = rule({
      thresholdAmount: 100n,
      thresholdPercent: new Prisma.Decimal('10'),
    });
    expect(ruleRequiresApproval(r, { amount: 50n, percent: 12 })).toBe(true);
    expect(ruleRequiresApproval(r, { amount: 150n, percent: 5 })).toBe(true);
    expect(ruleRequiresApproval(r, { amount: 50n, percent: 5 })).toBe(false);
    expect(ruleRequiresApproval(r, {})).toBe(false);
  });
});

describe('/api/v1/approvals endpoints (end-to-end)', () => {
  let app: INestApplication<App>;
  let managerToken: string;
  let technicianToken: string;
  let pendingId: string;

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

    managerToken = await login(manager.email);
    technicianToken = await login(technician.email);
  });

  afterAll(async () => {
    await app.close();
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/approvals').expect(401);
  });

  it('POST /approvals raises a PENDING approval (technician has approval.request)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${technicianToken}`)
      .send({
        type: 'PRICE_OVERRIDE',
        branch_id: branchDar,
        payload: { percent: 12, item: 'LCD-A515' },
        reason: `${TEST_PREFIX} loyal customer discount`,
      })
      .expect(201);

    const body = res.body as ApprovalEntry;
    pendingId = body.id;
    approvalIds.push(body.id);
    expect(body.status).toBe('PENDING');
    expect(body.requested_by).toBe(technician.id);
    expect(body.company_id).toBe(companyId);
    expect(body.branch_id).toBe(branchDar);
  });

  it('POST /approvals validates the body (missing reason → 400)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${technicianToken}`)
      .send({ type: 'REFUND', branch_id: branchDar })
      .expect(400);
  });

  it("a non-manager cannot decide: approve → 403 FORBIDDEN (no 'approval.decide')", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/approvals/${pendingId}/approve`)
      .set('Authorization', `Bearer ${technicianToken}`)
      .send({})
      .expect(403);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'FORBIDDEN',
    );

    const row = await raw.approval.findUniqueOrThrow({
      where: { id: pendingId },
    });
    expect(row.status).toBe('PENDING'); // untouched
  });

  it('reject without a reason → 400 (endpoint contract)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/approvals/${pendingId}/reject`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({})
      .expect(400);
  });

  it('GET /approvals lists PENDING rows in the { data, page, page_size, total } envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/approvals')
      .query({
        status: 'PENDING',
        type: 'PRICE_OVERRIDE',
        branch_id: branchDar,
      })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    const body = res.body as {
      data: ApprovalEntry[];
      page: number;
      page_size: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data.some((a) => a.id === pendingId)).toBe(true);
    for (const a of body.data) {
      expect(a.company_id).toBe(companyId);
      expect(a.status).toBe('PENDING');
      expect(a.type).toBe('PRICE_OVERRIDE');
      expect(a.branch_id).toBe(branchDar);
    }
  });

  it('manager approves → 200 APPROVED with approver + decided_at; audit APPROVE row exists', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/approvals/${pendingId}/approve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'within manager discretion' })
      .expect(200);

    const body = res.body as ApprovalEntry;
    expect(body.status).toBe('APPROVED');
    expect(body.approved_by).toBe(manager.id);
    expect(body.decided_at).not.toBeNull();
    expect(body.reason).toBe('within manager discretion');

    const audit = await raw.auditLog.findFirst({
      where: { entityId: pendingId, action: 'APPROVE' },
    });
    expect(audit?.actorUserId).toBe(manager.id);
  });

  it('double-decide over HTTP → 409 CONFLICT', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/approvals/${pendingId}/reject`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'changed my mind' })
      .expect(409);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'CONFLICT',
    );
  });

  it('unknown approval id → 404', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/approvals/00000000-0000-4000-8000-000000000000/approve')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({})
      .expect(404);
  });

  it('paginates (page_size=1 → one row, total preserved)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/approvals')
      .query({ page_size: 1, page: 1 })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const body = res.body as { data: ApprovalEntry[]; total: number };
    expect(body.data).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });
});

describe('real seed data stays intact', () => {
  it('Samsung ASC Group + 5 branches + 1 super admin + 2 approval rules, un-duplicated', async () => {
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
    const rules = await raw.approvalRule.findMany({
      where: { companyId: samsung[0].id },
    });
    expect(rules.map((r) => r.type).sort()).toEqual([
      'PRICE_OVERRIDE',
      'REFUND',
    ]);
  });
});
