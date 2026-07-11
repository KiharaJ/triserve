/**
 * Integration tests (Task 2.2, DESIGN.md §4.5) for reserve/consume of parts on
 * jobs against the REAL MySQL database over HTTP:
 *   - POST /jobs/{id}/parts RESERVES branch stock: available drops by qty,
 *     on_hand unchanged, a RESERVE movement is written, the line is RESERVED;
 *   - DELETE releases a reserved line (UNRESERVE): available restored, gone;
 *   - consume moves on_hand −qty AND reserved −qty (available unchanged), flips
 *     the line to CONSUMED, and writes UNRESERVE + CONSUMPTION;
 *   - reserving more than available → 422; a CONSUMED line can't be removed;
 *   - THE LAST UNIT: with available = 1, two PARALLEL reserves → exactly one
 *     succeeds, the other 422s, final reserved = 1 (the FOR UPDATE lock);
 *   - consume-all consumes every reserved line;
 *   - parts can't be changed on a terminal (closed) job → 422;
 *   - an IW job defaults its parts to is_warranty=true with the catalogue price;
 *   - a TECHNICIAN can't touch parts on a job not assigned to them (404).
 *
 * Fixtures are test-only (prefixed __TEST_2_2__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_2_2__';
const PASSWORD = 'JobParts2.2-Pass!';

const EMAILS = {
  admin: 'test-2-2-admin@triserve.test',
  tech1: 'test-2-2-tech1@triserve.test',
  tech2: 'test-2-2-tech2@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let initialStateId: string;
let terminalStateId: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdPartIds: string[] = [];
const createdJobIds: string[] = [];
let customerId: string;
let deviceId: string;

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

interface Bucket {
  qty_on_hand: number;
  qty_reserved: number;
  qty_available: number;
}
interface PartLine {
  id: string;
  status: string;
  is_warranty: boolean;
  unit_sell_price: string | null;
}

/** Create a part (raw) + opening stock at DAR (raw + a RECEIPT movement). */
async function makePart(partNumber: string, onHand: number): Promise<string> {
  const part = await raw.part.create({
    data: {
      companyId,
      partNumber,
      description: `${TEST_PREFIX} ${partNumber}`,
      category: 'HHP',
      unitCostUsd: 1000n,
      sellPriceTzs: 5_000_000n,
    },
  });
  createdPartIds.push(part.id);
  if (onHand > 0) {
    await raw.inventory.create({
      data: {
        companyId,
        branchId: branchDar,
        partId: part.id,
        qtyOnHand: onHand,
      },
    });
    await raw.stockMovement.create({
      data: {
        companyId,
        branchId: branchDar,
        partId: part.id,
        movementType: 'RECEIPT',
        qty: onHand,
        reason: 'test opening',
        movedById: ids.admin,
      },
    });
  }
  return part.id;
}

/** Create a job at DAR assigned to `engineerId`, at `stateId`. */
async function makeJob(
  stateId: string,
  engineerId: string,
  warranty: 'IW' | 'OW' = 'OW',
): Promise<string> {
  const job = await raw.job.create({
    data: {
      companyId,
      jobNo: `${TEST_PREFIX}-${randomUUID().slice(0, 8)}`,
      branchId: branchDar,
      customerId,
      deviceId,
      bookedById: ids.admin,
      assignedEngineerId: engineerId,
      warrantyStatus: warranty,
      stateId,
      receivedAt: new Date(),
    },
  });
  createdJobIds.push(job.id);
  return job.id;
}

async function bucket(partId: string): Promise<Bucket> {
  const res = await request(app.getHttpServer())
    .get(`/api/v1/inventory/${branchDar}/${partId}`)
    .set('Authorization', `Bearer ${tokens.admin}`)
    .expect(200);
  return res.body as Bucket;
}

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;
  initialStateId = (
    await raw.workflowState.findFirstOrThrow({
      where: { companyId, isInitial: true },
    })
  ).id;
  terminalStateId = (
    await raw.workflowState.findFirstOrThrow({
      where: { companyId, isTerminal: true },
    })
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

  const [admin, tech1, tech2] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', null),
    mk(EMAILS.tech1, 'TECHNICIAN', 'branch', branchDar),
    mk(EMAILS.tech2, 'TECHNICIAN', 'branch', branchDar),
  ]);
  ids.admin = admin.id;
  ids.tech1 = tech1.id;
  ids.tech2 = tech2.id;

  const customer = await raw.customer.create({
    data: { companyId, name: `${TEST_PREFIX} Customer` },
  });
  customerId = customer.id;
  const device = await raw.device.create({
    data: { companyId, customerId, category: 'HHP', brand: 'Samsung' },
  });
  deviceId = device.id;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  tokens.admin = await login(EMAILS.admin);
  tokens.tech1 = await login(EMAILS.tech1);
  tokens.tech2 = await login(EMAILS.tech2);
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  await raw.jobPart.deleteMany({ where: { jobId: { in: createdJobIds } } });
  await raw.stockMovement.deleteMany({
    where: { partId: { in: createdPartIds } },
  });
  await raw.inventory.deleteMany({ where: { partId: { in: createdPartIds } } });
  await raw.job.deleteMany({ where: { id: { in: createdJobIds } } });
  await raw.device.deleteMany({ where: { id: deviceId } });
  await raw.customer.deleteMany({ where: { id: customerId } });
  await raw.part.deleteMany({ where: { id: { in: createdPartIds } } });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.$disconnect();
  await app.close();
});

describe('Reserve / consume lifecycle', () => {
  it('reserve → consume moves the buckets exactly right', async () => {
    const partId = await makePart(`${TEST_PREFIX}-LIFECYCLE`, 10);
    const jobId = await makeJob(initialStateId, ids.tech1);

    // Reserve 3: available 10 → 7, on_hand still 10.
    const add = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 3 })
      .expect(201);
    const line = add.body as PartLine;
    expect(line.status).toBe('RESERVED');
    expect(line.unit_sell_price).toBe('5000000'); // catalogue default

    let b = await bucket(partId);
    expect(b.qty_on_hand).toBe(10);
    expect(b.qty_reserved).toBe(3);
    expect(b.qty_available).toBe(7);

    // Consume the line: on_hand 10 → 7, reserved 3 → 0, available stays 7.
    const consumed = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${line.id}/consume`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(201);
    expect((consumed.body as PartLine).status).toBe('CONSUMED');

    b = await bucket(partId);
    expect(b.qty_on_hand).toBe(7);
    expect(b.qty_reserved).toBe(0);
    expect(b.qty_available).toBe(7);

    // A consumed line cannot be removed.
    await request(app.getHttpServer())
      .delete(`/api/v1/jobs/${jobId}/parts/${line.id}`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(409);
  });

  it('removing a reserved line releases the hold', async () => {
    const partId = await makePart(`${TEST_PREFIX}-RELEASE`, 5);
    const jobId = await makeJob(initialStateId, ids.tech1);

    const add = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 2 })
      .expect(201);
    expect((await bucket(partId)).qty_available).toBe(3);

    await request(app.getHttpServer())
      .delete(`/api/v1/jobs/${jobId}/parts/${(add.body as PartLine).id}`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(200);
    expect((await bucket(partId)).qty_available).toBe(5);
  });

  it('cannot reserve more than available', async () => {
    const partId = await makePart(`${TEST_PREFIX}-OVER`, 2);
    const jobId = await makeJob(initialStateId, ids.tech1);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 3 })
      .expect(422);
    // Nothing reserved.
    expect((await bucket(partId)).qty_reserved).toBe(0);
  });
});

describe('The last unit — concurrent reserves', () => {
  it('two parallel reserves of the last unit: exactly one wins', async () => {
    const partId = await makePart(`${TEST_PREFIX}-LASTUNIT`, 1);
    const jobId = await makeJob(initialStateId, ids.tech1);

    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        request(app.getHttpServer())
          .post(`/api/v1/jobs/${jobId}/parts`)
          .set('Authorization', `Bearer ${tokens.tech1}`)
          .send({ part_id: partId, qty: 1 }),
      ),
    );
    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    const created = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 422).length;
    expect(created).toBe(1);
    expect(rejected).toBe(1);

    const b = await bucket(partId);
    expect(b.qty_reserved).toBe(1);
    expect(b.qty_available).toBe(0);
  });
});

describe('Consume-all + warranty defaults', () => {
  it('an IW job defaults parts to warranty, and consume-all consumes them', async () => {
    const partA = await makePart(`${TEST_PREFIX}-IW-A`, 5);
    const partB = await makePart(`${TEST_PREFIX}-IW-B`, 5);
    const jobId = await makeJob(initialStateId, ids.tech1, 'IW');

    const a = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partA, qty: 1 })
      .expect(201);
    expect((a.body as PartLine).is_warranty).toBe(true);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partB, qty: 2 })
      .expect(201);

    const consumed = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/consume`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(201);
    const lines = consumed.body as PartLine[];
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.status === 'CONSUMED')).toBe(true);

    expect((await bucket(partA)).qty_on_hand).toBe(4);
    expect((await bucket(partB)).qty_on_hand).toBe(3);
  });
});

describe('Guards', () => {
  it('cannot add parts to a terminal (closed) job', async () => {
    const partId = await makePart(`${TEST_PREFIX}-TERMINAL`, 5);
    const jobId = await makeJob(terminalStateId, ids.tech1);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 1 })
      .expect(422);
  });

  it('a technician cannot add parts to a job not assigned to them', async () => {
    const partId = await makePart(`${TEST_PREFIX}-SCOPE`, 5);
    const jobId = await makeJob(initialStateId, ids.tech1); // assigned to tech1
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech2}`) // tech2 is not assigned
      .send({ part_id: partId, qty: 1 })
      .expect(404);
  });
});
