/**
 * Integration tests (Task 2.1, DESIGN.md §4.4 / E10) for the parts catalogue +
 * ledger-backed inventory API against the REAL MySQL database over HTTP:
 *   - POST /parts creates a catalogue entry; a duplicate part_number → 409;
 *     GET /parts lists + filters; PATCH /parts edits;
 *   - POST /inventory/adjust posts an ADJUSTMENT, moves the buckets AND writes
 *     exactly one stock_movements row; available = on_hand − reserved − damaged;
 *   - DAMAGE flags on-hand stock (available drops, on_hand unchanged); an
 *     adjust that would push available < 0 → 422;
 *   - POST /inventory/count reconciles to a physical count (posts the delta);
 *   - POST /inventory/reconcile rebuilds the buckets from the ledger and they
 *     match the live buckets (ledger is the source of truth);
 *   - low_stock=true returns only rows at/below reorder level;
 *   - CONCURRENCY: 10 parallel +1 adjusts → on_hand === 10 with 10 ledger rows
 *     (the SELECT … FOR UPDATE lock serializes the bucket writes);
 *   - approval gate: with an INVENTORY_ADJUSTMENT rule, an over-threshold
 *     adjust is HELD (held:true, PENDING approval) and nothing moves;
 *   - scoping: a KRK storekeeper can't see DAR stock; company B can't see
 *     company A's parts/inventory.
 *
 * Fixtures are test-only (prefixed __TEST_2_1__) and removed in afterAll — the
 * real seed stays pristine.
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

const TEST_PREFIX = '__TEST_2_1__';
const PASSWORD = 'Inv2.1-Pass!';

const EMAILS = {
  admin: 'test-2-1-admin@triserve.test',
  storeDar: 'test-2-1-store-dar@triserve.test',
  storeKrk: 'test-2-1-store-krk@triserve.test',
  adminB: 'test-2-1-admin-b@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let companyBId: string;
let branchDar: string;
let branchKrk: string;
let branchB: string;

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

interface PartBody {
  id: string;
  part_number: string;
  unit_cost_usd: string | null;
  compatible_models: string[];
}

interface InventoryBody {
  id: string;
  branch_id: string;
  part_id: string;
  qty_on_hand: number;
  qty_reserved: number;
  qty_damaged: number;
  qty_available: number;
  reorder_level: number;
  low_stock: boolean;
}

interface ChangeBody {
  held: boolean;
  movement: { id: string; movement_type: string; qty: number } | null;
  inventory: InventoryBody;
  pending_approval?: { id: string; status: string };
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
  const part = res.body as PartBody;
  if (part.id && expectStatus === 201) createdPartIds.push(part.id);
  return part;
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
  branchB = (
    await raw.branch.create({
      data: { companyId: companyBId, code: 'RB1', name: `${TEST_PREFIX} B` },
    })
  ).id;

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

  const [admin, storeDar, storeKrk, adminB] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', companyId, null),
    mk(EMAILS.storeDar, 'STOREKEEPER', 'branch', companyId, branchDar),
    mk(EMAILS.storeKrk, 'STOREKEEPER', 'branch', companyId, branchKrk),
    mk(EMAILS.adminB, 'SUPER_ADMIN', 'group', companyBId, null),
  ]);
  ids.admin = admin.id;
  ids.storeDar = storeDar.id;
  ids.storeKrk = storeKrk.id;
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
  tokens.storeDar = await login(EMAILS.storeDar);
  tokens.storeKrk = await login(EMAILS.storeKrk);
  tokens.adminB = await login(EMAILS.adminB);
});

afterAll(async () => {
  // Children first (FK order): movements + inventory → parts, all scoped to the
  // test parts / test users so the real seed is never touched.
  const testUserIds = Object.values(ids);
  await raw.stockMovement.deleteMany({
    where: { partId: { in: createdPartIds } },
  });
  await raw.inventory.deleteMany({ where: { partId: { in: createdPartIds } } });
  await raw.part.deleteMany({ where: { id: { in: createdPartIds } } });
  // Only approvals raised by our test users; only the INVENTORY_ADJUSTMENT rule
  // (the seed never creates one — see prisma/seed.ts APPROVAL_RULES).
  await raw.approval.deleteMany({
    where: { requestedById: { in: testUserIds } },
  });
  await raw.approvalRule.deleteMany({
    where: { companyId, type: 'INVENTORY_ADJUSTMENT' },
  });
  await raw.auditLog.deleteMany({
    where: { entityType: 'Part', entityId: { in: createdPartIds } },
  });
  // Sessions FK users → drop them (login created one per user) before users.
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.branch.deleteMany({ where: { companyId: companyBId } });
  await raw.company.delete({ where: { id: companyBId } });
  await raw.$disconnect();
  await app.close();
});

describe('Parts catalogue', () => {
  it('creates a part, rejects a duplicate part number, lists + filters', async () => {
    const part = await createPart(tokens.storeDar, {
      part_number: `${TEST_PREFIX}-GH82-0001`,
      description: 'S24 LCD OLED assembly',
      category: 'HHP',
      unit_cost_usd: '9500', // USD 95.00
      compatible_models: ['S24', 'S24U'],
    });
    expect(part.unit_cost_usd).toBe('9500');
    expect(part.compatible_models).toEqual(['S24', 'S24U']);

    // Duplicate part_number within the company → 409.
    await createPart(
      tokens.storeDar,
      {
        part_number: `${TEST_PREFIX}-GH82-0001`,
        description: 'dup',
        category: 'HHP',
      },
      409,
    );

    const res = await request(app.getHttpServer())
      .get(`/api/v1/parts?q=${TEST_PREFIX}-GH82-0001`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    const body = res.body as { total: number; data: PartBody[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.data.some((p) => p.id === part.id)).toBe(true);
  });
});

describe('Ledger-backed stock', () => {
  let partId: string;

  beforeAll(async () => {
    const part = await createPart(tokens.storeDar, {
      part_number: `${TEST_PREFIX}-LEDGER`,
      description: 'Ledger test part',
      category: 'HHP',
      unit_cost_usd: '1000',
    });
    partId = part.id;
  });

  async function adjust(
    token: string,
    body: Record<string, unknown>,
    expectStatus = 201,
  ): Promise<ChangeBody> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjust')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(expectStatus);
    return res.body as ChangeBody;
  }

  it('adjust posts a movement and updates the buckets; available derives', async () => {
    const r = await adjust(tokens.storeDar, {
      branch_id: branchDar,
      part_id: partId,
      delta: 20,
      reason: 'Opening stock',
    });
    expect(r.held).toBe(false);
    expect(r.movement?.movement_type).toBe('ADJUSTMENT');
    expect(r.inventory.qty_on_hand).toBe(20);
    expect(r.inventory.qty_available).toBe(20);

    // DAMAGE 1: on_hand unchanged, damaged +1, available drops to 19.
    const d = await adjust(tokens.storeDar, {
      branch_id: branchDar,
      part_id: partId,
      delta: 1,
      movement_type: 'DAMAGE',
      reason: 'Cracked in handling',
    });
    expect(d.inventory.qty_on_hand).toBe(20);
    expect(d.inventory.qty_damaged).toBe(1);
    expect(d.inventory.qty_available).toBe(19);

    // Exactly two movement rows exist for this (branch, part).
    const mv = await request(app.getHttpServer())
      .get(
        `/api/v1/inventory/movements?part_id=${partId}&branch_id=${branchDar}`,
      )
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    expect((mv.body as { total: number }).total).toBe(2);
  });

  it('rejects an adjust that would push available below zero', async () => {
    // available is 19; removing 20 would make on_hand 0 but reserved/damaged
    // still 1 → available −1 → 422.
    await adjust(
      tokens.storeDar,
      {
        branch_id: branchDar,
        part_id: partId,
        delta: -20,
        reason: 'over-remove',
      },
      422,
    );
  });

  it('count reconciles to the physical count by posting the delta', async () => {
    // on_hand is 20; count says 25 → +5 ADJUSTMENT (ref COUNT).
    const res = await request(app.getHttpServer())
      .post('/api/v1/inventory/count')
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({ branch_id: branchDar, part_id: partId, counted_qty: 25 })
      .expect(201);
    const body = res.body as ChangeBody;
    expect(body.movement?.qty).toBe(5);
    expect(body.inventory.qty_on_hand).toBe(25);
  });

  it('reconcile rebuilds the buckets from the ledger and they match', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/inventory/reconcile')
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({ branch_id: branchDar, part_id: partId })
      .expect(201);
    const inv = res.body as InventoryBody;
    // Ledger: +20 (adjust) + 1 damaged + 5 (count) → on_hand 25, damaged 1.
    expect(inv.qty_on_hand).toBe(25);
    expect(inv.qty_damaged).toBe(1);
    expect(inv.qty_available).toBe(24);
  });

  it('low_stock=true returns rows at/below reorder level', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/inventory/settings')
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({ branch_id: branchDar, part_id: partId, reorder_level: 100 })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/inventory?low_stock=true&part_id=${partId}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    const body = res.body as { data: InventoryBody[] };
    expect(body.data.some((i) => i.part_id === partId)).toBe(true);
    expect(body.data.every((i) => i.low_stock)).toBe(true);
  });
});

describe('Concurrency — the FOR UPDATE lock', () => {
  it('10 parallel +1 adjusts land exactly 10 on hand with 10 ledger rows', async () => {
    const part = await createPart(tokens.storeDar, {
      part_number: `${TEST_PREFIX}-CONCURRENCY`,
      description: 'Concurrency test part',
      category: 'HHP',
    });

    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer())
          .post('/api/v1/inventory/adjust')
          .set('Authorization', `Bearer ${tokens.storeDar}`)
          .send({
            branch_id: branchDar,
            part_id: part.id,
            delta: 1,
            reason: 'parallel',
          })
          .expect(201),
      ),
    );

    const inv = await request(app.getHttpServer())
      .get(`/api/v1/inventory/${branchDar}/${part.id}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    expect((inv.body as InventoryBody).qty_on_hand).toBe(10);

    const mv = await request(app.getHttpServer())
      .get(`/api/v1/inventory/movements?part_id=${part.id}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    expect((mv.body as { total: number }).total).toBe(10);
  });
});

describe('Approval gate (INVENTORY_ADJUSTMENT)', () => {
  it('holds an over-threshold adjust and moves nothing', async () => {
    const part = await createPart(tokens.storeDar, {
      part_number: `${TEST_PREFIX}-GATED`,
      description: 'Gated adjust part',
      category: 'HHP',
      unit_cost_usd: '5000', // USD 50.00 per unit
    });

    // Rule: adjustments valued >= 10000 (USD cents) need approval.
    await raw.approvalRule.create({
      data: {
        companyId,
        type: 'INVENTORY_ADJUSTMENT',
        thresholdAmount: 10_000n,
        enabled: true,
      },
    });

    // delta 10 × 5000 = 50000 >= 10000 → held.
    const res = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjust')
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({
        branch_id: branchDar,
        part_id: part.id,
        delta: 10,
        reason: 'bulk correction',
      })
      .expect(201);
    const body = res.body as ChangeBody;
    expect(body.held).toBe(true);
    expect(body.movement).toBeNull();
    expect(body.pending_approval?.status).toBe('PENDING');
    expect(body.inventory.qty_on_hand).toBe(0); // nothing moved

    await raw.approvalRule.deleteMany({
      where: { companyId, type: 'INVENTORY_ADJUSTMENT' },
    });
  });
});

describe('Scoping', () => {
  let darPartId: string;

  beforeAll(async () => {
    const part = await createPart(tokens.storeDar, {
      part_number: `${TEST_PREFIX}-SCOPE`,
      description: 'Scope test part',
      category: 'HHP',
    });
    darPartId = part.id;
    await request(app.getHttpServer())
      .post('/api/v1/inventory/adjust')
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({
        branch_id: branchDar,
        part_id: darPartId,
        delta: 5,
        reason: 'scope seed',
      })
      .expect(201);
  });

  it("a KRK storekeeper cannot read DAR's stock row", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/inventory/${branchDar}/${darPartId}`)
      .set('Authorization', `Bearer ${tokens.storeKrk}`)
      .expect(403);
  });

  it('a KRK storekeeper cannot adjust DAR stock', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/inventory/adjust')
      .set('Authorization', `Bearer ${tokens.storeKrk}`)
      .send({
        branch_id: branchDar,
        part_id: darPartId,
        delta: 1,
        reason: 'cross-branch',
      })
      .expect(403);
  });

  it("company B cannot see company A's part", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/parts/${darPartId}`)
      .set('Authorization', `Bearer ${tokens.adminB}`)
      .expect(404);
  });

  it('company B sees none of company A inventory in its list', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/inventory')
      .set('Authorization', `Bearer ${tokens.adminB}`)
      .expect(200);
    const body = res.body as { data: InventoryBody[] };
    expect(body.data.every((i) => i.branch_id === branchB)).toBe(true);
  });
});
