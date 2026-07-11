/**
 * Integration tests (Task 2.7, DESIGN.md §4.4b) for goods received notes
 * against the REAL MySQL database over HTTP:
 *   - POST /purchase-orders/{id}/receipts posts a GRN (grn_no GRN-DAR-YYYY-NNNN)
 *     that MOVES stock: on_hand += qty_received, a RECEIPT movement (ref GRN)
 *     is written, the PO line's qty_received bumps, and a fully-received PO
 *     flips to RECEIVED;
 *   - a partial receipt → PARTIALLY_RECEIVED / line PARTIAL; a second GRN
 *     completes it → RECEIVED (a PO can have several GRNs);
 *   - over-receipt (more than outstanding) → 422; empty receipt → 422;
 *   - receiving a non-ORDERED PO → 422;
 *   - qty_rejected is recorded but moves no stock; bin_location lands on the row;
 *   - permission: grn.receive required (a TECHNICIAN is 403);
 *   - scoping: a KRK storekeeper can't receive a DAR PO (404).
 *
 * Fixtures are test-only (prefixed __TEST_2_7__) and removed in afterAll.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, type UserRole, type UserScope } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_2_7__';
const PASSWORD = 'Grn2.7-Pass!';

const EMAILS = {
  admin: 'test-2-7-admin@triserve.test',
  storeDar: 'test-2-7-store-dar@triserve.test',
  tech: 'test-2-7-tech@triserve.test',
  storeKrk: 'test-2-7-store-krk@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let branchKrk: string;
let supplierId: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdPartIds: string[] = [];
const createdPoIds: string[] = [];
const createdGrnIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

async function makePart(partNumber: string): Promise<string> {
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
  return part.id;
}

interface PoLineSpec {
  partId: string;
  qtyOrdered: number;
  unitCost: bigint;
}
interface MadePo {
  id: string;
  lines: { id: string; partId: string; qtyOrdered: number }[];
}

/** Create an ORDERED PO (raw) at DAR with the given lines. */
async function makeOrderedPo(specs: PoLineSpec[]): Promise<MadePo> {
  const subtotal = specs.reduce(
    (s, l) => s + BigInt(l.qtyOrdered) * l.unitCost,
    0n,
  );
  const po = await raw.purchaseOrder.create({
    data: {
      companyId,
      poNo: `PO-${TEST_PREFIX}-${randomUUID().slice(0, 6)}`,
      supplierId,
      branchId: branchDar,
      status: 'ORDERED',
      currency: 'USD',
      subtotal,
      total: subtotal,
      orderDate: new Date(),
      orderedAt: new Date(),
      createdById: ids.admin,
      updatedById: ids.admin,
      lines: {
        create: specs.map((l) => ({
          partId: l.partId,
          qtyOrdered: l.qtyOrdered,
          unitCost: l.unitCost,
          currency: 'USD',
        })),
      },
    },
    include: { lines: true },
  });
  createdPoIds.push(po.id);
  return {
    id: po.id,
    lines: po.lines.map((l) => ({
      id: l.id,
      partId: l.partId,
      qtyOrdered: l.qtyOrdered,
    })),
  };
}

async function receive(
  token: string,
  poId: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<{ id: string; grn_no: string }> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/purchase-orders/${poId}/receipts`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  const grn = res.body as { id: string; grn_no: string };
  if (grn.id) createdGrnIds.push(grn.id);
  return grn;
}

async function onHand(partId: string): Promise<number> {
  const res = await request(app.getHttpServer())
    .get(`/api/v1/inventory/${branchDar}/${partId}`)
    .set('Authorization', `Bearer ${tokens.admin}`);
  return res.status === 404
    ? 0
    : (res.body as { qty_on_hand: number }).qty_on_hand;
}

async function poStatus(poId: string): Promise<string> {
  return (await raw.purchaseOrder.findFirstOrThrow({ where: { id: poId } }))
    .status;
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

  const [admin, storeDar, tech, storeKrk] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', null),
    mk(EMAILS.storeDar, 'STOREKEEPER', 'branch', branchDar),
    mk(EMAILS.tech, 'TECHNICIAN', 'branch', branchDar),
    mk(EMAILS.storeKrk, 'STOREKEEPER', 'branch', branchKrk),
  ]);
  ids.admin = admin.id;
  ids.storeDar = storeDar.id;
  ids.tech = tech.id;
  ids.storeKrk = storeKrk.id;

  supplierId = (
    await raw.supplier.create({
      data: {
        companyId,
        name: `${TEST_PREFIX} Vendor`,
        defaultCurrency: 'USD',
      },
    })
  ).id;

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
  tokens.tech = await login(EMAILS.tech);
  tokens.storeKrk = await login(EMAILS.storeKrk);
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  await raw.goodsReceivedNote.deleteMany({
    where: { id: { in: createdGrnIds } },
  }); // cascades grn_lines
  await raw.purchaseOrder.deleteMany({ where: { id: { in: createdPoIds } } }); // cascades po_lines
  await raw.stockMovement.deleteMany({
    where: { partId: { in: createdPartIds } },
  });
  await raw.inventory.deleteMany({ where: { partId: { in: createdPartIds } } });
  await raw.part.deleteMany({ where: { id: { in: createdPartIds } } });
  await raw.supplier.deleteMany({ where: { id: supplierId } });
  await raw.auditLog.deleteMany({
    where: { entityType: 'GoodsReceivedNote', entityId: { in: createdGrnIds } },
  });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.$disconnect();
  await app.close();
});

describe('Receiving against a PO', () => {
  it('a full receipt moves stock and completes the PO', async () => {
    const partId = await makePart(`${TEST_PREFIX}-FULL`);
    const po = await makeOrderedPo([
      { partId, qtyOrdered: 10, unitCost: 1000n },
    ]);

    const grn = await receive(tokens.storeDar, po.id, {
      supplier_delivery_ref: 'WB-001',
      lines: [
        { po_line_id: po.lines[0].id, qty_received: 10, bin_location: 'A1' },
      ],
    });
    expect(grn.grn_no).toMatch(/^GRN-DAR-\d{4}-\d{4}$/);

    expect(await onHand(partId)).toBe(10);
    expect(await poStatus(po.id)).toBe('RECEIVED');

    // A RECEIPT movement was written with ref_type GRN.
    const mv = await raw.stockMovement.findFirst({
      where: { partId, movementType: 'RECEIPT', refType: 'GRN' },
    });
    expect(mv).not.toBeNull();
    // bin_location landed on the inventory row.
    const inv = await raw.inventory.findFirstOrThrow({
      where: { branchId: branchDar, partId },
    });
    expect(inv.binLocation).toBe('A1');
  });

  it('partial receipts across two GRNs complete the PO', async () => {
    const partId = await makePart(`${TEST_PREFIX}-PARTIAL`);
    const po = await makeOrderedPo([
      { partId, qtyOrdered: 8, unitCost: 1000n },
    ]);

    await receive(tokens.storeDar, po.id, {
      lines: [{ po_line_id: po.lines[0].id, qty_received: 3 }],
    });
    expect(await onHand(partId)).toBe(3);
    expect(await poStatus(po.id)).toBe('PARTIALLY_RECEIVED');

    // Over-receipt of the remaining 5 → 422.
    await receive(
      tokens.storeDar,
      po.id,
      { lines: [{ po_line_id: po.lines[0].id, qty_received: 6 }] },
      422,
    );

    await receive(tokens.storeDar, po.id, {
      lines: [{ po_line_id: po.lines[0].id, qty_received: 5, qty_rejected: 1 }],
    });
    expect(await onHand(partId)).toBe(8); // 3 + 5 (rejected 1 not counted)
    expect(await poStatus(po.id)).toBe('RECEIVED');
  });

  it('rejects an empty receipt and a non-ORDERED PO', async () => {
    const partId = await makePart(`${TEST_PREFIX}-GUARD`);
    const po = await makeOrderedPo([
      { partId, qtyOrdered: 5, unitCost: 1000n },
    ]);
    // Nothing received → 422.
    await receive(
      tokens.storeDar,
      po.id,
      { lines: [{ po_line_id: po.lines[0].id, qty_received: 0 }] },
      422,
    );
    // A DRAFT PO cannot be received against.
    const draft = await raw.purchaseOrder.create({
      data: {
        companyId,
        poNo: `PO-${TEST_PREFIX}-DR-${randomUUID().slice(0, 6)}`,
        supplierId,
        branchId: branchDar,
        status: 'DRAFT',
        currency: 'USD',
        createdById: ids.admin,
        updatedById: ids.admin,
        lines: {
          create: [{ partId, qtyOrdered: 1, unitCost: 1000n, currency: 'USD' }],
        },
      },
      include: { lines: true },
    });
    createdPoIds.push(draft.id);
    await receive(
      tokens.storeDar,
      draft.id,
      { lines: [{ po_line_id: draft.lines[0].id, qty_received: 1 }] },
      422,
    );
  });
});

describe('Permissions + scoping', () => {
  it('a TECHNICIAN cannot receive (no grn.receive)', async () => {
    const partId = await makePart(`${TEST_PREFIX}-PERM`);
    const po = await makeOrderedPo([
      { partId, qtyOrdered: 2, unitCost: 1000n },
    ]);
    await receive(
      tokens.tech,
      po.id,
      { lines: [{ po_line_id: po.lines[0].id, qty_received: 1 }] },
      403,
    );
  });

  it('a KRK storekeeper cannot receive a DAR PO', async () => {
    const partId = await makePart(`${TEST_PREFIX}-SCOPE`);
    const po = await makeOrderedPo([
      { partId, qtyOrdered: 2, unitCost: 1000n },
    ]);
    await receive(
      tokens.storeKrk,
      po.id,
      { lines: [{ po_line_id: po.lines[0].id, qty_received: 1 }] },
      404,
    );
    void branchKrk;
  });
});
