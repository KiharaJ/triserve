/**
 * Integration tests (Task 2.3, DESIGN.md §4.4) for inter-branch stock transfers
 * against the REAL MySQL database over HTTP:
 *   - POST /transfers drafts a transfer (no stock moves; transfer_no assigned);
 *   - dispatch: source on_hand −qty (TRANSFER_OUT), destination in_transit_in
 *     +qty, status DISPATCHED; receive: destination on_hand +qty, in_transit_in
 *     back to 0, status RECEIVED — stock is conserved end-to-end;
 *   - dispatching more than the source has → 422 (status stays DRAFT);
 *   - can't receive a DRAFT / dispatch twice / cancel a dispatched transfer;
 *   - cancel a DRAFT moves nothing;
 *   - from == to → 400;
 *   - approval gate: a STOCK_TRANSFER rule HELDs an over-threshold dispatch
 *     (status stays DRAFT, nothing moves);
 *   - scoping: a KRK storekeeper can't dispatch a DAR→KRK transfer (needs the
 *     source branch) but CAN receive it; can't see a transfer not touching KRK.
 *
 * Fixtures are test-only (prefixed __TEST_2_3__) and removed in afterAll.
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
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_2_3__';
const PASSWORD = 'Transfer2.3-Pass!';

const EMAILS = {
  admin: 'test-2-3-admin@triserve.test',
  storeDar: 'test-2-3-store-dar@triserve.test',
  storeKrk: 'test-2-3-store-krk@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let branchKrk: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdPartIds: string[] = [];
const createdTransferIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

interface Bucket {
  qty_on_hand: number;
  qty_in_transit_in: number;
  qty_available: number;
}
interface TransferBody {
  id: string;
  transfer_no: string;
  status: string;
  lines: { part_id: string; qty: number }[];
}

async function makePart(
  partNumber: string,
  darOnHand: number,
): Promise<string> {
  const part = await raw.part.create({
    data: {
      companyId,
      partNumber,
      description: `${TEST_PREFIX} ${partNumber}`,
      category: 'HHP',
      unitCostUsd: 1000n,
    },
  });
  createdPartIds.push(part.id);
  if (darOnHand > 0) {
    await raw.inventory.create({
      data: {
        companyId,
        branchId: branchDar,
        partId: part.id,
        qtyOnHand: darOnHand,
      },
    });
    await raw.stockMovement.create({
      data: {
        companyId,
        branchId: branchDar,
        partId: part.id,
        movementType: 'RECEIPT',
        qty: darOnHand,
        reason: 'test opening',
        movedById: ids.admin,
      },
    });
  }
  return part.id;
}

async function bucket(branchId: string, partId: string): Promise<Bucket> {
  const res = await request(app.getHttpServer())
    .get(`/api/v1/inventory/${branchId}/${partId}`)
    .set('Authorization', `Bearer ${tokens.admin}`);
  // A missing row (nothing ever stocked) → treat as zeros.
  if (res.status === 404) {
    return { qty_on_hand: 0, qty_in_transit_in: 0, qty_available: 0 };
  }
  return res.body as Bucket;
}

async function createTransfer(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<TransferBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/transfers')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  const t = res.body as TransferBody;
  if (t.id) createdTransferIds.push(t.id);
  return t;
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

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const mk = (
    email: string,
    role: string,
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

  const [admin, storeDar, storeKrk] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', null),
    mk(EMAILS.storeDar, 'STOREKEEPER', 'branch', branchDar),
    mk(EMAILS.storeKrk, 'STOREKEEPER', 'branch', branchKrk),
  ]);
  ids.admin = admin.id;
  ids.storeDar = storeDar.id;
  ids.storeKrk = storeKrk.id;

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
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  await raw.stockTransfer.deleteMany({
    where: { id: { in: createdTransferIds } },
  }); // cascades lines
  // NOTE: transfer_counters is intentionally NOT deleted — it is a company-wide
  // monotonic sequence shared with real data; resetting it would collide real
  // transfer numbers. It just keeps incrementing, which is harmless.
  await raw.stockMovement.deleteMany({
    where: { partId: { in: createdPartIds } },
  });
  await raw.inventory.deleteMany({ where: { partId: { in: createdPartIds } } });
  await raw.part.deleteMany({ where: { id: { in: createdPartIds } } });
  await raw.approval.deleteMany({
    where: { requestedById: { in: testUserIds } },
  });
  await raw.approvalRule.deleteMany({
    where: { companyId, type: 'STOCK_TRANSFER' },
  });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.$disconnect();
  await app.close();
});

describe('Transfer lifecycle', () => {
  it('draft → dispatch → receive conserves stock across branches', async () => {
    const partId = await makePart(`${TEST_PREFIX}-FLOW`, 10);
    const t = await createTransfer(tokens.storeDar, {
      from_branch_id: branchDar,
      to_branch_id: branchKrk,
      lines: [{ part_id: partId, qty: 4 }],
    });
    expect(t.status).toBe('DRAFT');
    expect(t.transfer_no).toMatch(/^TRF-\d{4}-\d{6}$/);

    // DRAFT moved nothing.
    expect((await bucket(branchDar, partId)).qty_on_hand).toBe(10);

    // Dispatch: DAR −4 on hand, KRK +4 in transit.
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/dispatch`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(201);
    const darAfterDispatch = await bucket(branchDar, partId);
    const krkAfterDispatch = await bucket(branchKrk, partId);
    expect(darAfterDispatch.qty_on_hand).toBe(6);
    expect(krkAfterDispatch.qty_on_hand).toBe(0);
    expect(krkAfterDispatch.qty_in_transit_in).toBe(4);

    // Receive (by the destination-branch storekeeper): KRK +4 on hand, clear transit.
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/receive`)
      .set('Authorization', `Bearer ${tokens.storeKrk}`)
      .expect(201);
    const darFinal = await bucket(branchDar, partId);
    const krkFinal = await bucket(branchKrk, partId);
    expect(darFinal.qty_on_hand).toBe(6);
    expect(krkFinal.qty_on_hand).toBe(4);
    expect(krkFinal.qty_in_transit_in).toBe(0);
    // Conserved: 10 = 6 + 4.
    expect(darFinal.qty_on_hand + krkFinal.qty_on_hand).toBe(10);
  });

  it('cannot dispatch more than the source has', async () => {
    const partId = await makePart(`${TEST_PREFIX}-SHORT`, 3);
    const t = await createTransfer(tokens.storeDar, {
      from_branch_id: branchDar,
      to_branch_id: branchKrk,
      lines: [{ part_id: partId, qty: 5 }],
    });
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/dispatch`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(422);
    // Rolled back: still DRAFT, source untouched.
    expect((await bucket(branchDar, partId)).qty_on_hand).toBe(3);
    const after = await request(app.getHttpServer())
      .get(`/api/v1/transfers/${t.id}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    expect((after.body as TransferBody).status).toBe('DRAFT');
  });

  it('enforces the state machine (receive-before-dispatch, double-dispatch)', async () => {
    const partId = await makePart(`${TEST_PREFIX}-STATE`, 5);
    const t = await createTransfer(tokens.storeDar, {
      from_branch_id: branchDar,
      to_branch_id: branchKrk,
      lines: [{ part_id: partId, qty: 1 }],
    });
    // Can't receive a DRAFT.
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/receive`)
      .set('Authorization', `Bearer ${tokens.storeKrk}`)
      .expect(409);
    // Dispatch, then can't dispatch again.
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/dispatch`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/dispatch`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(409);
  });

  it('cancels a DRAFT and rejects from==to', async () => {
    const partId = await makePart(`${TEST_PREFIX}-CANCEL`, 5);
    const t = await createTransfer(tokens.storeDar, {
      from_branch_id: branchDar,
      to_branch_id: branchKrk,
      lines: [{ part_id: partId, qty: 2 }],
    });
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/cancel`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(201);
    const after = await request(app.getHttpServer())
      .get(`/api/v1/transfers/${t.id}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    expect((after.body as TransferBody).status).toBe('CANCELLED');
    expect((await bucket(branchDar, partId)).qty_on_hand).toBe(5);

    await createTransfer(
      tokens.storeDar,
      {
        from_branch_id: branchDar,
        to_branch_id: branchDar,
        lines: [{ part_id: partId, qty: 1 }],
      },
      400,
    );
  });
});

describe('Approval gate (STOCK_TRANSFER)', () => {
  it('holds an over-threshold dispatch and moves nothing', async () => {
    const partId = await makePart(`${TEST_PREFIX}-GATED`, 10);
    await raw.approvalRule.create({
      data: {
        companyId,
        type: 'STOCK_TRANSFER',
        thresholdAmount: 1_000n,
        enabled: true,
      },
    });
    const t = await createTransfer(tokens.storeDar, {
      from_branch_id: branchDar,
      to_branch_id: branchKrk,
      lines: [{ part_id: partId, qty: 5 }], // value 5×1000 = 5000 ≥ 1000
    });
    const res = await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/dispatch`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(201);
    const body = res.body as {
      held: boolean;
      transfer: TransferBody;
      pending_approval?: { status: string };
    };
    expect(body.held).toBe(true);
    expect(body.pending_approval?.status).toBe('PENDING');
    expect(body.transfer.status).toBe('DRAFT');
    expect((await bucket(branchDar, partId)).qty_on_hand).toBe(10); // nothing moved

    await raw.approvalRule.deleteMany({
      where: { companyId, type: 'STOCK_TRANSFER' },
    });
  });
});

describe('Scoping', () => {
  it('a destination-branch user cannot dispatch, and vice versa', async () => {
    const partId = await makePart(`${TEST_PREFIX}-SCOPE`, 5);
    const t = await createTransfer(tokens.storeDar, {
      from_branch_id: branchDar,
      to_branch_id: branchKrk,
      lines: [{ part_id: partId, qty: 1 }],
    });
    // KRK storekeeper can SEE it (KRK is the destination) but can't dispatch
    // (dispatch needs the SOURCE branch, DAR).
    await request(app.getHttpServer())
      .get(`/api/v1/transfers/${t.id}`)
      .set('Authorization', `Bearer ${tokens.storeKrk}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${t.id}/dispatch`)
      .set('Authorization', `Bearer ${tokens.storeKrk}`)
      .expect(403);
  });
});
