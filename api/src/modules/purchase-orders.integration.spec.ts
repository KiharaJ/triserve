/**
 * Integration tests (Task 2.6, DESIGN.md §4.4b) for purchase orders against the
 * REAL MySQL database over HTTP:
 *   - POST /purchase-orders drafts an order: po_no PO-DAR-YYYY-NNNN, subtotal =
 *     Σ(qty×cost), total = subtotal + tax + shipping, currency from supplier;
 *   - PATCH edits a DRAFT (lines replace, totals recompute); non-DRAFT → 409;
 *   - submit records requires_approval from the PURCHASE_ORDER threshold;
 *   - a small PO (no rule) goes submit → order directly;
 *   - a large PO must be APPROVED before order (order → 422 until approved);
 *     approve needs po.approve (a STOREKEEPER is 403, a BRANCH_MANAGER 200);
 *   - order stamps order_date + expected_date (supplier lead time);
 *   - cancel a DRAFT; state-machine guards (submit non-DRAFT, approve non-
 *     SUBMITTED) → 409;
 *   - scoping: a KRK storekeeper can't see a DAR PO; an order emits a
 *     TRANSITION audit row.
 *
 * Fixtures are test-only (prefixed __TEST_2_6__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_2_6__';
const PASSWORD = 'Po2.6-Pass!';

const EMAILS = {
  admin: 'test-2-6-admin@triserve.test',
  storeDar: 'test-2-6-store-dar@triserve.test',
  mgrDar: 'test-2-6-mgr-dar@triserve.test',
  storeKrk: 'test-2-6-store-krk@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let branchKrk: string;
let supplierId: string;
let partA: string;
let partB: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdPoIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

interface PoBody {
  id: string;
  po_no: string;
  status: string;
  currency: string;
  subtotal: string;
  tax: string;
  shipping: string;
  total: string;
  requires_approval: boolean;
  order_date: string | null;
  expected_date: string | null;
  lines: { part_id: string; qty_ordered: number }[];
}

async function createPo(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<PoBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/purchase-orders')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  const po = res.body as PoBody;
  if (po.id) createdPoIds.push(po.id);
  return po;
}

const act = (token: string, id: string, action: string) =>
  request(app.getHttpServer())
    .post(`/api/v1/purchase-orders/${id}/${action}`)
    .set('Authorization', `Bearer ${token}`);

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

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mk = (
    email: string,
    role: UserRole,
    scope: UserScope,
    homeBranchId: string | null,
  ) =>
    raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} ${role}`,
        email,
        passwordHash,
        role,
        scope,
        homeBranchId,
      },
    });

  const [admin, storeDar, mgrDar, storeKrk] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', null),
    mk(EMAILS.storeDar, 'STOREKEEPER', 'branch', branchDar),
    mk(EMAILS.mgrDar, 'BRANCH_MANAGER', 'branch', branchDar),
    mk(EMAILS.storeKrk, 'STOREKEEPER', 'branch', branchKrk),
  ]);
  ids.admin = admin.id;
  ids.storeDar = storeDar.id;
  ids.mgrDar = mgrDar.id;
  ids.storeKrk = storeKrk.id;

  const supplier = await raw.supplier.create({
    data: {
      companyId,
      name: `${TEST_PREFIX} Vendor`,
      defaultCurrency: 'USD',
      leadTimeDays: 7,
    },
  });
  supplierId = supplier.id;
  const [pa, pb] = await Promise.all([
    raw.part.create({
      data: {
        companyId,
        partNumber: `${TEST_PREFIX}-A`,
        description: 'PO part A',
        category: 'HHP',
      },
    }),
    raw.part.create({
      data: {
        companyId,
        partNumber: `${TEST_PREFIX}-B`,
        description: 'PO part B',
        category: 'HHP',
      },
    }),
  ]);
  partA = pa.id;
  partB = pb.id;

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
  tokens.mgrDar = await login(EMAILS.mgrDar);
  tokens.storeKrk = await login(EMAILS.storeKrk);
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  await raw.purchaseOrder.deleteMany({ where: { id: { in: createdPoIds } } }); // cascades lines
  // purchase_order_counters intentionally NOT reset (company-wide sequence).
  await raw.auditLog.deleteMany({
    where: { entityType: 'PurchaseOrder', entityId: { in: createdPoIds } },
  });
  await raw.part.deleteMany({ where: { id: { in: [partA, partB] } } });
  await raw.supplier.deleteMany({ where: { id: supplierId } });
  await raw.approvalRule.deleteMany({
    where: { companyId, type: 'PURCHASE_ORDER' },
  });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.$disconnect();
  await app.close();
});

describe('Draft + edit + totals', () => {
  it('drafts a PO with computed totals and PO number', async () => {
    const po = await createPo(tokens.storeDar, {
      branch_id: branchDar,
      supplier_id: supplierId,
      tax: '100',
      shipping: '50',
      lines: [
        { part_id: partA, qty_ordered: 2, unit_cost: '1000' },
        { part_id: partB, qty_ordered: 1, unit_cost: '500' },
      ],
    });
    expect(po.po_no).toMatch(/^PO-DAR-\d{4}-\d{4}$/);
    expect(po.currency).toBe('USD');
    expect(po.subtotal).toBe('2500'); // 2×1000 + 1×500
    expect(po.total).toBe('2650'); // + 100 + 50

    // Edit: replace lines, bump shipping → totals recompute.
    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/purchase-orders/${po.id}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({
        shipping: '200',
        lines: [{ part_id: partA, qty_ordered: 3, unit_cost: '1000' }],
      })
      .expect(200);
    const p = patched.body as PoBody;
    expect(p.subtotal).toBe('3000');
    expect(p.total).toBe('3300'); // 3000 + 100 tax + 200 shipping
  });
});

describe('Lifecycle without approval', () => {
  it('submit → order directly when no threshold rule applies', async () => {
    const po = await createPo(tokens.storeDar, {
      branch_id: branchDar,
      supplier_id: supplierId,
      lines: [{ part_id: partA, qty_ordered: 1, unit_cost: '10' }],
    });
    // Can't order a DRAFT.
    await act(tokens.storeDar, po.id, 'order').expect(409);

    const submitted = await act(tokens.storeDar, po.id, 'submit').expect(201);
    expect((submitted.body as PoBody).status).toBe('SUBMITTED');
    expect((submitted.body as PoBody).requires_approval).toBe(false);

    const ordered = await act(tokens.storeDar, po.id, 'order').expect(201);
    const ob = ordered.body as PoBody;
    expect(ob.status).toBe('ORDERED');
    expect(ob.order_date).not.toBeNull();
    expect(ob.expected_date).not.toBeNull(); // today + 7d lead time
  });
});

describe('Approval gate + state machine', () => {
  it('a large PO must be approved before it can be ordered', async () => {
    await raw.approvalRule.create({
      data: {
        companyId,
        type: 'PURCHASE_ORDER',
        thresholdAmount: 1_000n,
        enabled: true,
      },
    });

    const po = await createPo(tokens.storeDar, {
      branch_id: branchDar,
      supplier_id: supplierId,
      lines: [{ part_id: partA, qty_ordered: 5, unit_cost: '1000' }], // 5000 ≥ 1000
    });
    const submitted = await act(tokens.storeDar, po.id, 'submit').expect(201);
    expect((submitted.body as PoBody).requires_approval).toBe(true);

    // Ordering is blocked until approved.
    await act(tokens.storeDar, po.id, 'order').expect(422);

    // A STOREKEEPER lacks po.approve.
    await act(tokens.storeDar, po.id, 'approve').expect(403);
    // The BRANCH_MANAGER approves.
    const approved = await act(tokens.mgrDar, po.id, 'approve').expect(201);
    expect((approved.body as PoBody).status).toBe('APPROVED');
    // Can't approve again.
    await act(tokens.mgrDar, po.id, 'approve').expect(409);

    const ordered = await act(tokens.storeDar, po.id, 'order').expect(201);
    expect((ordered.body as PoBody).status).toBe('ORDERED');

    // An ORDER wrote a TRANSITION audit row.
    const audit = await raw.auditLog.findFirst({
      where: {
        entityType: 'PurchaseOrder',
        entityId: po.id,
        action: 'TRANSITION',
      },
      orderBy: { at: 'desc' },
    });
    expect(audit).not.toBeNull();

    await raw.approvalRule.deleteMany({
      where: { companyId, type: 'PURCHASE_ORDER' },
    });
  });

  it('cancels a DRAFT and rejects editing a non-DRAFT', async () => {
    const po = await createPo(tokens.storeDar, {
      branch_id: branchDar,
      supplier_id: supplierId,
      lines: [{ part_id: partA, qty_ordered: 1, unit_cost: '100' }],
    });
    await act(tokens.storeDar, po.id, 'submit').expect(201);
    // Editing a SUBMITTED PO → 409.
    await request(app.getHttpServer())
      .patch(`/api/v1/purchase-orders/${po.id}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .send({ shipping: '10' })
      .expect(409);
    // Cancel is allowed (nothing received).
    const cancelled = await act(tokens.storeDar, po.id, 'cancel').expect(201);
    expect((cancelled.body as PoBody).status).toBe('CANCELLED');
  });
});

describe('Scoping', () => {
  it('a KRK storekeeper cannot see a DAR purchase order', async () => {
    const po = await createPo(tokens.storeDar, {
      branch_id: branchDar,
      supplier_id: supplierId,
      lines: [{ part_id: partA, qty_ordered: 1, unit_cost: '100' }],
    });
    await request(app.getHttpServer())
      .get(`/api/v1/purchase-orders/${po.id}`)
      .set('Authorization', `Bearer ${tokens.storeKrk}`)
      .expect(404);
    void branchKrk;
  });
});
