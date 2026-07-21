/**
 * Integration tests (Task 1.2, DESIGN.md §4.10/§5/E7) for the configurable
 * workflow engine against the REAL MySQL database over HTTP + the service:
 *   - GET /workflow/graph returns the seeded default lifecycle (11 states
 *     ordered by sort_order, 16 edges) to ANY authenticated user;
 *   - canTransition: legal move allowed; RECEIVED→CLOSED rejected as
 *     illegal (no edge); a TECHNICIAN cannot take the front-desk-only
 *     READY→DISPATCHED edge while a SERVICE_ADVISOR can; an advisor cannot
 *     take the bench-only AWAITING_PARTS→IN_REPAIR edge while a tech can;
 *   - assertTransition throws 422 with a clear message;
 *   - the guard registry is consulted on guarded edges (stub spied on),
 *     a failing guard blocks the move, an UNREGISTERED guard fails closed;
 *   - POST /workflow/states|transitions are admin-gated ('config.manage'),
 *     validate state codes/guards, and 409 on duplicates;
 *   - company scoping holds (a second tenant sees an empty board).
 *
 * Fixtures are test-only (prefixed __TEST_1_2__ / TEST_1_2_*) and removed in
 * afterAll — the seeded default workflow is intentional seed data and stays.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import type { AuthUser } from './auth/auth.types';
import {
  WORKFLOW_GUARDS,
  type WorkflowGuard,
} from './workflow/guards/registry';
import { WorkflowService } from './workflow/workflow.service';

// Jest does not load /api/.env; default to the local dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_1_2__';
const PASSWORD = 'Workflow1.2-Pass!';
const ADMIN_EMAIL = 'test-1-2-admin@triserve.test';
const ADVISOR_EMAIL = 'test-1-2-advisor@triserve.test';
const TECH_EMAIL = 'test-1-2-tech@triserve.test';
const ADMIN_B_EMAIL = 'test-1-2-admin-b@triserve.test';

const SEEDED_STATE_CODES = [
  'RECEIVED',
  'DIAGNOSING',
  'AWAITING_CUSTOMER_APPROVAL',
  'AWAITING_PARTS',
  'IN_REPAIR',
  'QC',
  'READY',
  'DISPATCHED',
  'CLOSED',
  'CANCELLED',
  'RETURNED_UNREPAIRED',
];

/** Raw (unextended) client for fixture setup/teardown and row assertions. */
const raw = new PrismaClient();

let app: INestApplication<App>;
let workflow: WorkflowService;
let companyId: string; // seeded "Samsung ASC Group"
let companyBId: string; // __TEST_1_2__ second tenant
let branchDar: string;
let adminId: string;
let advisorId: string;
let techId: string;
let adminBId: string;
let adminToken: string;
let advisorToken: string;
let techToken: string;
let adminBToken: string;

let adminUser: AuthUser;
let advisorUser: AuthUser;
let techUser: AuthUser;

// Fixtures created THROUGH THE API during the suite (cleaned up in afterAll).
let stateAId: string; // TEST_1_2_STATE_A
let stateBId: string; // TEST_1_2_STATE_B
let testTransitionId: string; // TEST_1_2_STATE_A → TEST_1_2_STATE_B
let rawEdgeId: string; // raw-inserted edge with an unregistered guard

interface GraphWire {
  states: Array<{
    id: string;
    code: string;
    label: string;
    is_initial: boolean;
    is_terminal: boolean;
    sort_order: number;
    active: boolean;
  }>;
  transitions: Array<{
    id: string;
    from_code: string;
    to_code: string;
    required_permission: string | null;
    requires_approval: boolean;
    guard_code: string | null;
  }>;
}

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

function authUser(
  userId: string,
  role: AuthUser['role'],
  scope: AuthUser['scope'],
  homeBranchId: string | null,
): AuthUser {
  return {
    userId,
    sessionId: 'test-session',
    companyId,
    role,
    scope,
    homeBranchId,
  };
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
    data: { name: `${TEST_PREFIX} Rival Service Co` },
  });
  companyBId = companyB.id;

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const [admin, advisor, tech, adminB] = await Promise.all([
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
        companyId,
        fullName: `${TEST_PREFIX} Technician`,
        email: TECH_EMAIL,
        passwordHash,
        role: 'TECHNICIAN',
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
  techId = tech.id;
  adminBId = adminB.id;

  adminUser = authUser(adminId, 'SUPER_ADMIN', 'group', null);
  advisorUser = authUser(advisorId, 'SERVICE_ADVISOR', 'branch', branchDar);
  techUser = authUser(techId, 'TECHNICIAN', 'branch', branchDar);

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
  workflow = app.get(WorkflowService);

  adminToken = await login(ADMIN_EMAIL);
  advisorToken = await login(ADVISOR_EMAIL);
  techToken = await login(TECH_EMAIL);
  adminBToken = await login(ADMIN_B_EMAIL);
});

afterAll(async () => {
  // Purge ONLY this suite's leftovers (raw client bypasses the DI append-
  // only audit guard — that guard protects the app surface, not teardown).
  const actorIds = [adminId, advisorId, techId, adminBId].filter(Boolean);
  const entityIds = [
    stateAId,
    stateBId,
    testTransitionId,
    rawEdgeId,
    adminId,
    advisorId,
    techId,
    adminBId,
    companyBId,
  ].filter(Boolean);
  await raw.auditLog.deleteMany({
    where: {
      OR: [{ entityId: { in: entityIds } }, { actorUserId: { in: actorIds } }],
    },
  });
  await raw.session.deleteMany({ where: { userId: { in: actorIds } } });
  // Transitions before states (FK). Test states carry the TEST_1_2_ prefix;
  // the seeded default workflow is intentional seed data and must remain.
  await raw.workflowTransition.deleteMany({
    where: {
      OR: [
        { companyId: companyBId },
        { fromState: { code: { startsWith: 'TEST_1_2_' } } },
        { toState: { code: { startsWith: 'TEST_1_2_' } } },
      ],
    },
  });
  await raw.workflowState.deleteMany({
    where: {
      OR: [{ companyId: companyBId }, { code: { startsWith: 'TEST_1_2_' } }],
    },
  });
  await raw.user.deleteMany({
    where: {
      email: { in: [ADMIN_EMAIL, ADVISOR_EMAIL, TECH_EMAIL, ADMIN_B_EMAIL] },
    },
  });
  await raw.company.deleteMany({ where: { id: companyBId } });
  await app.close();
  await raw.$disconnect();
});

describe('GET /workflow/graph (§4.10 — board rendering)', () => {
  it('returns the seeded default lifecycle to ANY authenticated user (technician)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/workflow/graph')
      .set('Authorization', `Bearer ${techToken}`)
      .expect(200);
    const body = res.body as GraphWire;

    expect(body.states.map((s) => s.code)).toEqual(SEEDED_STATE_CODES); // sort_order
    expect(body.transitions).toHaveLength(16);

    const received = body.states.find((s) => s.code === 'RECEIVED');
    expect(received).toMatchObject({ is_initial: true, is_terminal: false });
    for (const terminal of ['CLOSED', 'CANCELLED', 'RETURNED_UNREPAIRED']) {
      expect(body.states.find((s) => s.code === terminal)).toMatchObject({
        is_terminal: true,
      });
    }

    const dispatch = body.transitions.find(
      (t) => t.from_code === 'READY' && t.to_code === 'DISPATCHED',
    );
    expect(dispatch).toMatchObject({
      required_permission: 'job.transition.dispatch',
      requires_approval: false,
    });

    const quoteEdge = body.transitions.find(
      (t) =>
        t.from_code === 'AWAITING_CUSTOMER_APPROVAL' &&
        t.to_code === 'IN_REPAIR',
    );
    expect(quoteEdge).toMatchObject({
      required_permission: 'job.transition.repair',
      requires_approval: false, // OW-quote gating arrives with POS
      guard_code: 'ow_quote_approved',
    });
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/workflow/graph')
      .expect(401);
  });

  it('is company-scoped: a second tenant sees an empty board', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/workflow/graph')
      .set('Authorization', `Bearer ${adminBToken}`)
      .expect(200);
    const body = res.body as GraphWire;
    expect(body.states).toHaveLength(0);
    expect(body.transitions).toHaveLength(0);
  });
});

describe('GET /workflow/states + /workflow/transitions', () => {
  it('lists states paginated, ordered by sort_order', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/workflow/states')
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);
    const body = res.body as {
      data: Array<{ code: string }>;
      page: number;
      page_size: number;
      total: number;
    };
    expect(body.total).toBe(11);
    expect(body.data.map((s) => s.code)).toEqual(SEEDED_STATE_CODES);
  });

  it('lists transitions; ?q= filters by state code', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/workflow/transitions?q=DISPATCHED')
      .set('Authorization', `Bearer ${advisorToken}`)
      .expect(200);
    const body = res.body as {
      data: Array<{ from_code: string; to_code: string }>;
      total: number;
    };
    expect(body.total).toBe(2); // READY→DISPATCHED, DISPATCHED→CLOSED
  });
});

describe('WorkflowService.canTransition (§4.10 engine semantics)', () => {
  it('allows a legal, permitted move: RECEIVED→DIAGNOSING as advisor', async () => {
    const check = await workflow.canTransition(
      companyId,
      'RECEIVED',
      'DIAGNOSING',
      advisorUser,
    );
    expect(check.allowed).toBe(true);
    expect(check.reason).toBeUndefined();
    expect(check.transition).toMatchObject({
      from_code: 'RECEIVED',
      to_code: 'DIAGNOSING',
      required_permission: 'job.transition',
    });
  });

  it('rejects an ILLEGAL move (no edge): RECEIVED→CLOSED, even for admin', async () => {
    const check = await workflow.canTransition(
      companyId,
      'RECEIVED',
      'CLOSED',
      adminUser,
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe(
      'Illegal transition: RECEIVED → CLOSED is not an allowed move',
    );
  });

  it('rejects unknown state codes', async () => {
    const check = await workflow.canTransition(
      companyId,
      'RECEIVED',
      'NO_SUCH_STATE',
      adminUser,
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("Unknown workflow state 'NO_SUCH_STATE'");
  });

  it('TECHNICIAN cannot take the front-desk-only READY→DISPATCHED edge; advisor can', async () => {
    const techCheck = await workflow.canTransition(
      companyId,
      'READY',
      'DISPATCHED',
      techUser,
    );
    expect(techCheck.allowed).toBe(false);
    expect(techCheck.reason).toBe(
      "Not authorized: READY → DISPATCHED requires permission 'job.transition.dispatch'",
    );

    const advisorCheck = await workflow.canTransition(
      companyId,
      'READY',
      'DISPATCHED',
      advisorUser,
    );
    expect(advisorCheck.allowed).toBe(true);
  });

  it('SERVICE_ADVISOR cannot take the bench-only AWAITING_PARTS→IN_REPAIR edge; tech can', async () => {
    const advisorCheck = await workflow.canTransition(
      companyId,
      'AWAITING_PARTS',
      'IN_REPAIR',
      advisorUser,
    );
    expect(advisorCheck.allowed).toBe(false);
    expect(advisorCheck.reason).toContain("'job.transition.repair'");

    const techCheck = await workflow.canTransition(
      companyId,
      'AWAITING_PARTS',
      'IN_REPAIR',
      techUser,
    );
    expect(techCheck.allowed).toBe(true);
  });

  it('refuses to move through an INACTIVE state', async () => {
    await raw.workflowState.updateMany({
      where: { companyId, code: 'QC' },
      data: { active: false },
    });
    try {
      const check = await workflow.canTransition(
        companyId,
        'IN_REPAIR',
        'QC',
        techUser,
      );
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe("Workflow state 'QC' is inactive");
    } finally {
      await raw.workflowState.updateMany({
        where: { companyId, code: 'QC' },
        data: { active: true },
      });
    }
  });
});

describe('guard registry (§4.10 — pluggable business rules)', () => {
  const guards = WORKFLOW_GUARDS as Record<string, WorkflowGuard>;

  afterEach(() => jest.restoreAllMocks());

  it('consults ow_quote_approved on AWAITING_CUSTOMER_APPROVAL→IN_REPAIR and lets a FULLY covered job through', async () => {
    const spy = jest.spyOn(guards, 'ow_quote_approved');
    const job = {
      id: 'job-ctx-passthrough',
      companyId,
      coverage: 'FULL' as const,
    };
    const check = await workflow.canTransition(
      companyId,
      'AWAITING_CUSTOMER_APPROVAL',
      'IN_REPAIR',
      techUser,
      { job },
    );
    // FULL coverage = nothing to bill the customer, so no quote is required.
    expect(check.allowed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, user: techUser, job }),
    );
  });

  it('blocks a job the customer pays for until a REPAIR_OW quote exists', async () => {
    // No invoice was raised against this job id, so the quote gate holds —
    // this is job-card T&C 5/9: no unquoted chargeable work.
    for (const coverage of ['NONE', 'LABOUR_ONLY', 'PARTS_ONLY'] as const) {
      const check = await workflow.canTransition(
        companyId,
        'AWAITING_CUSTOMER_APPROVAL',
        'IN_REPAIR',
        techUser,
        { job: { id: `job-unquoted-${coverage}`, companyId, coverage } },
      );
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe(
        "Transition condition 'ow_quote_approved' not satisfied for AWAITING_CUSTOMER_APPROVAL → IN_REPAIR",
      );
    }
  });

  it('fails closed when the job context is missing entirely', async () => {
    const check = await workflow.canTransition(
      companyId,
      'AWAITING_CUSTOMER_APPROVAL',
      'IN_REPAIR',
      techUser,
    );
    expect(check.allowed).toBe(false);
  });

  it('a failing guard blocks the move with a clear reason', async () => {
    jest.spyOn(guards, 'ow_quote_approved').mockReturnValue(false);
    const check = await workflow.canTransition(
      companyId,
      'AWAITING_CUSTOMER_APPROVAL',
      'IN_REPAIR',
      techUser,
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe(
      "Transition condition 'ow_quote_approved' not satisfied for AWAITING_CUSTOMER_APPROVAL → IN_REPAIR",
    );
  });

  it('an edge naming an UNREGISTERED guard fails closed', async () => {
    // Raw insert simulates config drift (the API rejects unknown guards).
    const [stateA, stateB] = await Promise.all([
      raw.workflowState.create({
        data: {
          companyId,
          code: 'TEST_1_2_GUARDED_FROM',
          label: `${TEST_PREFIX} guarded from`,
          sortOrder: 900,
        },
      }),
      raw.workflowState.create({
        data: {
          companyId,
          code: 'TEST_1_2_GUARDED_TO',
          label: `${TEST_PREFIX} guarded to`,
          sortOrder: 901,
        },
      }),
    ]);
    const edge = await raw.workflowTransition.create({
      data: {
        companyId,
        fromStateId: stateA.id,
        toStateId: stateB.id,
        guardCode: 'not_a_registered_guard',
      },
    });
    rawEdgeId = edge.id;

    const check = await workflow.canTransition(
      companyId,
      'TEST_1_2_GUARDED_FROM',
      'TEST_1_2_GUARDED_TO',
      adminUser,
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe(
      "Transition guard 'not_a_registered_guard' is not registered — transition blocked",
    );
  });
});

describe('WorkflowService.assertTransition (422 on refusal)', () => {
  it('throws 422 UNPROCESSABLE_ENTITY with the reason for an illegal move', async () => {
    await expect(
      workflow.assertTransition(companyId, 'RECEIVED', 'CLOSED', adminUser),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Illegal transition: RECEIVED → CLOSED is not an allowed move',
    });
  });

  it('throws 422 for an unauthorized move (tech dispatching)', async () => {
    await expect(
      workflow.assertTransition(companyId, 'READY', 'DISPATCHED', techUser),
    ).rejects.toMatchObject({
      status: 422,
      message:
        "Not authorized: READY → DISPATCHED requires permission 'job.transition.dispatch'",
    });
  });

  it('resolves with the edge for a legal, permitted move', async () => {
    const check = await workflow.assertTransition(
      companyId,
      'DISPATCHED',
      'CLOSED',
      advisorUser,
    );
    expect(check.allowed).toBe(true);
    expect(check.transition?.requires_approval).toBe(false);
  });
});

describe('POST /workflow/states + /workflow/transitions (admin config)', () => {
  it('rejects non-admin roles (technician, advisor) with 403', async () => {
    for (const token of [techToken, advisorToken]) {
      await request(app.getHttpServer())
        .post('/api/v1/workflow/states')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'TEST_1_2_NOPE', label: 'nope' })
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/v1/workflow/transitions')
        .set('Authorization', `Bearer ${token}`)
        .send({ from_code: 'RECEIVED', to_code: 'QC' })
        .expect(403);
    }
  });

  it('admin creates states; duplicate code → 409; second initial state → 409', async () => {
    const resA = await request(app.getHttpServer())
      .post('/api/v1/workflow/states')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'TEST_1_2_STATE_A',
        label: `${TEST_PREFIX} State A`,
        sort_order: 910,
      })
      .expect(201);
    stateAId = (resA.body as { id: string }).id;

    const resB = await request(app.getHttpServer())
      .post('/api/v1/workflow/states')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'TEST_1_2_STATE_B',
        label: `${TEST_PREFIX} State B`,
        is_terminal: true,
        sort_order: 911,
      })
      .expect(201);
    stateBId = (resB.body as { id: string }).id;

    await request(app.getHttpServer())
      .post('/api/v1/workflow/states')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'TEST_1_2_STATE_A', label: 'duplicate' })
      .expect(409);

    // RECEIVED is already the (only) initial state.
    const res = await request(app.getHttpServer())
      .post('/api/v1/workflow/states')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'TEST_1_2_SECOND_INITIAL',
        label: 'second initial',
        is_initial: true,
      })
      .expect(409);
    expect(
      (res.body as { error: { message: string } }).error.message,
    ).toContain("'RECEIVED'");
  });

  it('admin creates a transition; validates codes/permissions/guards; duplicate → 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/workflow/transitions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        from_code: 'TEST_1_2_STATE_A',
        to_code: 'TEST_1_2_STATE_B',
        required_permission: 'job.transition',
      })
      .expect(201);
    const body = res.body as {
      id: string;
      from_code: string;
      to_code: string;
      requires_approval: boolean;
      guard_code: string | null;
    };
    testTransitionId = body.id;
    expect(body).toMatchObject({
      from_code: 'TEST_1_2_STATE_A',
      to_code: 'TEST_1_2_STATE_B',
      requires_approval: false, // DB default
      guard_code: null,
    });

    // duplicate edge
    await request(app.getHttpServer())
      .post('/api/v1/workflow/transitions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ from_code: 'TEST_1_2_STATE_A', to_code: 'TEST_1_2_STATE_B' })
      .expect(409);

    // unknown from state → 422
    await request(app.getHttpServer())
      .post('/api/v1/workflow/transitions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ from_code: 'NO_SUCH_STATE', to_code: 'TEST_1_2_STATE_B' })
      .expect(422);

    // self-loop → 422
    await request(app.getHttpServer())
      .post('/api/v1/workflow/transitions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ from_code: 'TEST_1_2_STATE_A', to_code: 'TEST_1_2_STATE_A' })
      .expect(422);

    // unknown permission string → 400 (DTO validation)
    await request(app.getHttpServer())
      .post('/api/v1/workflow/transitions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        from_code: 'TEST_1_2_STATE_B',
        to_code: 'TEST_1_2_STATE_A',
        required_permission: 'job.not-a-permission',
      })
      .expect(400);

    // unregistered guard_code → 422
    await request(app.getHttpServer())
      .post('/api/v1/workflow/transitions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        from_code: 'TEST_1_2_STATE_B',
        to_code: 'TEST_1_2_STATE_A',
        guard_code: 'no_such_guard',
      })
      .expect(422);
  });

  it('creations are audited', async () => {
    const audit = await raw.auditLog.findMany({
      where: { entityId: { in: [stateAId, testTransitionId] } },
    });
    expect(audit.map((a) => `${a.entityType}:${a.action}`).sort()).toEqual([
      'WorkflowState:CREATE',
      'WorkflowTransition:CREATE',
    ]);
  });
});

describe('seed stays pristine', () => {
  it('the seeded default workflow is intact (11 states / 16 edges) and only test fixtures were added', async () => {
    const seededStates = await raw.workflowState.count({
      where: {
        companyId,
        code: { notIn: [] },
        NOT: { code: { startsWith: 'TEST_1_2_' } },
      },
    });
    const seededTransitions = await raw.workflowTransition.count({
      where: {
        companyId,
        fromState: { NOT: { code: { startsWith: 'TEST_1_2_' } } },
        toState: { NOT: { code: { startsWith: 'TEST_1_2_' } } },
      },
    });
    expect(seededStates).toBe(11);
    expect(seededTransitions).toBe(16);

    // Every extra row this suite created is test-prefixed (removed in afterAll).
    const extraStates = await raw.workflowState.count({
      where: { code: { startsWith: 'TEST_1_2_' } },
    });
    expect(extraStates).toBe(4); // A, B, GUARDED_FROM, GUARDED_TO

    const initialStates = await raw.workflowState.count({
      where: { companyId, isInitial: true, deletedAt: null },
    });
    expect(initialStates).toBe(1); // RECEIVED only
  });
});
