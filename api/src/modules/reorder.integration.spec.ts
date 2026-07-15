/**
 * Integration tests (Task 2.9, DESIGN.md §4.4b) for reorder suggestions against
 * the REAL MySQL database over HTTP:
 *   - GET /reorder-suggestions lists parts whose available (on_hand − reserved
 *     − damaged) is ≤ their reorder level, grouped by preferred supplier, with
 *     suggested_qty = 2×reorder_level − available (≥ 1);
 *   - a part comfortably above its reorder level is excluded;
 *   - parts with no preferred supplier fall in a null group;
 *   - permission (po.read) + branch scoping.
 *
 * Fixtures are test-only (prefixed __TEST_2_9__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_2_9__';
const PASSWORD = 'Reorder2.9-Pass!';

const EMAILS = {
  admin: 'test-2-9-admin@triserve.test',
  storeDar: 'test-2-9-store-dar@triserve.test',
  tech: 'test-2-9-tech@triserve.test',
  storeKrk: 'test-2-9-store-krk@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let supplierId: string;

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

/** Create a part (raw) + a DAR inventory row with the given levels. */
async function stockPart(
  partNumber: string,
  onHand: number,
  reorderLevel: number,
  preferredSupplierId: string | null,
): Promise<string> {
  const part = await raw.part.create({
    data: {
      companyId,
      partNumber,
      description: `${TEST_PREFIX} ${partNumber}`,
      category: 'HHP',
      unitCostUsd: 1500n,
      preferredSupplierId,
    },
  });
  createdPartIds.push(part.id);
  await raw.inventory.create({
    data: {
      companyId,
      branchId: branchDar,
      partId: part.id,
      qtyOnHand: onHand,
      reorderLevel,
    },
  });
  return part.id;
}

interface Group {
  supplier_id: string | null;
  supplier_name: string | null;
  items: {
    part_id: string;
    available: number;
    reorder_level: number;
    suggested_qty: number;
  }[];
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

  const krk = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'KRK' } })
  ).id;
  const [admin, storeDar, tech, storeKrk] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', null),
    mk(EMAILS.storeDar, 'STOREKEEPER', 'branch', branchDar),
    mk(EMAILS.tech, 'TECHNICIAN', 'branch', branchDar),
    mk(EMAILS.storeKrk, 'STOREKEEPER', 'branch', krk),
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

  // Two low parts from the same supplier, one low with no supplier, one OK.
  await stockPart(`${TEST_PREFIX}-LOW1`, 3, 10, supplierId); // avail 3 ≤ 10
  await stockPart(`${TEST_PREFIX}-LOW2`, 5, 5, supplierId); // avail 5 ≤ 5
  await stockPart(`${TEST_PREFIX}-NOSUP`, 1, 4, null); // avail 1 ≤ 4, no supplier
  await stockPart(`${TEST_PREFIX}-OK`, 20, 5, supplierId); // avail 20 > 5 → excluded

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
  await raw.inventory.deleteMany({ where: { partId: { in: createdPartIds } } });
  await raw.part.deleteMany({ where: { id: { in: createdPartIds } } });
  await raw.supplier.deleteMany({ where: { id: supplierId } });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.$disconnect();
  await app.close();
});

describe('Reorder suggestions', () => {
  it('groups low-stock parts by supplier with a suggested qty', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/reorder-suggestions?branch_id=${branchDar}`)
      .set('Authorization', `Bearer ${tokens.storeDar}`)
      .expect(200);
    const body = res.body as { groups: Group[] };

    const supplierGroup = body.groups.find((g) => g.supplier_id === supplierId);
    const noneGroup = body.groups.find((g) => g.supplier_id === null);
    expect(supplierGroup).toBeDefined();
    expect(noneGroup).toBeDefined();

    const supplierParts = new Set(supplierGroup!.items.map((i) => i.part_id));
    // LOW1 + LOW2 are in the supplier group; OK is excluded.
    expect(supplierGroup!.items).toHaveLength(2);

    const low1 = supplierGroup!.items.find((i) => i.available === 3);
    expect(low1?.reorder_level).toBe(10);
    expect(low1?.suggested_qty).toBe(17); // 2×10 − 3

    const low2 = supplierGroup!.items.find((i) => i.available === 5);
    expect(low2?.suggested_qty).toBe(5); // 2×5 − 5

    // The no-supplier part is in the null group.
    expect(noneGroup!.items).toHaveLength(1);
    expect(noneGroup!.items[0].suggested_qty).toBe(7); // 2×4 − 1

    // The well-stocked part appears nowhere.
    const okPart = createdPartIds[3];
    const allItems = body.groups.flatMap((g) => g.items.map((i) => i.part_id));
    expect(allItems).not.toContain(okPart);
    void supplierParts;
  });

  it('requires po.read and enforces branch access', async () => {
    // TECHNICIAN lacks po.read.
    await request(app.getHttpServer())
      .get(`/api/v1/reorder-suggestions?branch_id=${branchDar}`)
      .set('Authorization', `Bearer ${tokens.tech}`)
      .expect(403);
    // A KRK storekeeper can't request DAR's suggestions.
    await request(app.getHttpServer())
      .get(`/api/v1/reorder-suggestions?branch_id=${branchDar}`)
      .set('Authorization', `Bearer ${tokens.storeKrk}`)
      .expect(403);
  });
});
