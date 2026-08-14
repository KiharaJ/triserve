/**
 * Integration tests (Task 2.2, DESIGN.md §4.5) for reserve/consume of parts on
 * jobs against the REAL MySQL database over HTTP:
 *   - POST /jobs/{id}/parts REQUESTS a part and holds NOTHING; stores raises it
 *     ({lineId}/issue-request) and an approver signs it off ({lineId}/approve),
 *     and it is that approval which RESERVES: available drops by qty, on_hand
 *     unchanged, a RESERVE movement is written, the line becomes RESERVED;
 *   - DELETE releases a reserved line (UNRESERVE): available restored, gone;
 *   - consume moves on_hand −qty AND reserved −qty (available unchanged), flips
 *     the line to CONSUMED, and writes UNRESERVE + CONSUMPTION;
 *   - asking for more than available is ALLOWED (the bench cannot see the
 *     shelf); the APPROVAL is what 422s, leaving the line awaiting a decision;
 *   - THE LAST UNIT: with available = 1, two PARALLEL approvals → exactly one
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
import { PrismaClient, type UserScope } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

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
  // Parts requests raise `approvals` rows, whose requested_by FK is NOT
  // nullable — leaving them behind blocks the user delete below, and the
  // fixtures then collide with the NEXT run rather than failing here.
  await raw.approval.deleteMany({
    where: {
      OR: [
        { requestedById: { in: testUserIds } },
        { refType: 'JobPart' },
        { refId: { in: createdJobIds } },
      ],
    },
  });
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

/**
 * Drive a line through the bench request flow to RESERVED.
 *
 * The technician asks, the parts clerk raises it for approval, and an approver
 * signs it off — and it is that approval which fires the RESERVE movement.
 * Most tests below care about the reserved end state, not the ceremony, so
 * they go through here. `admin` is a SUPER_ADMIN and so holds both the clerk
 * permission ('inventory.issue') and the approver one ('job.parts.approve').
 */
async function reserveLine(
  jobId: string,
  partId: string,
  qty: number,
): Promise<PartLine> {
  const requested = await request(app.getHttpServer())
    .post(`/api/v1/jobs/${jobId}/parts`)
    .set('Authorization', `Bearer ${tokens.tech1}`)
    .send({ part_id: partId, qty })
    .expect(201);
  const line = requested.body as PartLine;

  await request(app.getHttpServer())
    .post(`/api/v1/jobs/${jobId}/parts/${line.id}/issue-request`)
    .set('Authorization', `Bearer ${tokens.admin}`)
    .expect(201);

  const approved = await request(app.getHttpServer())
    .post(`/api/v1/jobs/${jobId}/parts/${line.id}/approve`)
    .set('Authorization', `Bearer ${tokens.admin}`)
    .expect(201);
  return approved.body as PartLine;
}

describe('Reserve / consume lifecycle', () => {
  it('reserve → consume moves the buckets exactly right', async () => {
    const partId = await makePart(`${TEST_PREFIX}-LIFECYCLE`, 10);
    const jobId = await makeJob(initialStateId, ids.tech1);

    // Request 3 — nothing is held yet, which is the point of the request step.
    const asked = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 3 })
      .expect(201);
    expect((asked.body as PartLine).status).toBe('REQUESTED');
    expect((await bucket(partId)).qty_available).toBe(10); // untouched

    // Stores raises it, an approver signs it off — THAT reserves the stock:
    // available 10 → 7, on_hand still 10.
    await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(asked.body as PartLine).id}/issue-request`,
      )
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);
    const approved = await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(asked.body as PartLine).id}/approve`,
      )
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);
    const line = approved.body as PartLine;
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

    const line = await reserveLine(jobId, partId, 2);
    expect((await bucket(partId)).qty_available).toBe(3);

    await request(app.getHttpServer())
      .delete(`/api/v1/jobs/${jobId}/parts/${line.id}`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(200);
    expect((await bucket(partId)).qty_available).toBe(5);
  });

  it('cannot reserve more than available — refused at APPROVAL', async () => {
    const partId = await makePart(`${TEST_PREFIX}-OVER`, 2);
    const jobId = await makeJob(initialStateId, ids.tech1);

    // Asking for more than exists is allowed: the bench may not know what is
    // on the shelf, and stores/the approver are the ones who find out.
    const asked = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 3 })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(asked.body as PartLine).id}/issue-request`,
      )
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);

    // The reservation is what fails, and the approver is the one told.
    await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(asked.body as PartLine).id}/approve`,
      )
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(422);

    // Nothing reserved, and the line is still awaiting a decision.
    expect((await bucket(partId)).qty_reserved).toBe(0);
    const after = await raw.jobPart.findFirstOrThrow({ where: { jobId } });
    expect(after.status).toBe('ISSUE_REQUESTED');
  });
});

describe('The last unit — concurrent reserves', () => {
  it('two parallel APPROVALS of the last unit: exactly one wins', async () => {
    const partId = await makePart(`${TEST_PREFIX}-LASTUNIT`, 1);
    const jobId = await makeJob(initialStateId, ids.tech1);

    // Both requests are accepted — neither holds stock. The race that matters
    // is now between the two APPROVALS, because approving is what reserves.
    const lineIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const asked = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/parts`)
        .set('Authorization', `Bearer ${tokens.tech1}`)
        .send({ part_id: partId, qty: 1 })
        .expect(201);
      const id = (asked.body as PartLine).id;
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/parts/${id}/issue-request`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(201);
      lineIds.push(id);
    }

    const results = await Promise.allSettled(
      lineIds.map((id) =>
        request(app.getHttpServer())
          .post(`/api/v1/jobs/${jobId}/parts/${id}/approve`)
          .set('Authorization', `Bearer ${tokens.admin}`),
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

    // The warranty default is applied at REQUEST time, off the job's coverage.
    const a = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partA, qty: 1 })
      .expect(201);
    expect((a.body as PartLine).is_warranty).toBe(true);

    // Consume-all only reaches APPROVED lines: a request holds no stock, so
    // there would be nothing to consume.
    await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(a.body as PartLine).id}/issue-request`,
      )
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${(a.body as PartLine).id}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);
    await reserveLine(jobId, partB, 2);

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

/**
 * The bench request loop end to end: engineer asks → parts clerk raises it →
 * approver signs it off (reserving the stock) → clerk hands it over → engineer
 * signs for it. Plus the refusals that keep each step honest.
 */
describe('Bench parts request flow', () => {
  it('runs the full chain: request → issue-request → approve → issue → acknowledge', async () => {
    const partId = await makePart(`${TEST_PREFIX}-CHAIN`, 4);
    const jobId = await makeJob(initialStateId, ids.tech1);

    // 1. The engineer asks. Nothing is held.
    const asked = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 1, request_note: 'Screen is cracked' })
      .expect(201);
    const lineId = (asked.body as PartLine).id;
    expect((asked.body as PartLine).status).toBe('REQUESTED');
    expect((await bucket(partId)).qty_available).toBe(4);

    // 2. Stores raises it — and only NOW does an approval row exist.
    const raised = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${lineId}/issue-request`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);
    expect((raised.body as PartLine).status).toBe('ISSUE_REQUESTED');
    const approvalId = (raised.body as { approval_id: string | null })
      .approval_id;
    expect(approvalId).toBeTruthy();
    expect((await bucket(partId)).qty_available).toBe(4); // still nothing held

    // 3. The approver signs it off — THIS is what reserves.
    const approved = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${lineId}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);
    expect((approved.body as PartLine).status).toBe('RESERVED');
    expect((await bucket(partId)).qty_available).toBe(3);

    // 4. Stores hands it over.
    const issued = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${lineId}/issue`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({})
      .expect(201);
    expect((issued.body as PartLine).status).toBe('ISSUED');

    // 5. The engineer signs for it — the half stores cannot assert for them.
    const ack = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${lineId}/acknowledge`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(201);
    expect((ack.body as PartLine).status).toBe('ACKNOWLEDGED');
    expect(
      (ack.body as { acknowledged_at: string | null }).acknowledged_at,
    ).toBeTruthy();

    // …and it is still fittable from there.
    const consumed = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${lineId}/consume`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(201);
    expect((consumed.body as PartLine).status).toBe('CONSUMED');
  });

  it('the generic approvals inbox REFUSES to decide a parts request', async () => {
    // Approving reserves stock and can fail; a decision taken in the inbox
    // could not report that, so the inbox lists it but sends you elsewhere.
    const partId = await makePart(`${TEST_PREFIX}-INBOX`, 2);
    const jobId = await makeJob(initialStateId, ids.tech1);

    const asked = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 1 })
      .expect(201);
    const raised = await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(asked.body as PartLine).id}/issue-request`,
      )
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);
    const approvalId = (raised.body as { approval_id: string }).approval_id;

    await request(app.getHttpServer())
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({})
      .expect(400);

    // Nothing moved: the line is still awaiting its proper decision.
    expect((await bucket(partId)).qty_reserved).toBe(0);
  });

  it('stores can decline a request without troubling an approver', async () => {
    const partId = await makePart(`${TEST_PREFIX}-DECLINE`, 2);
    const jobId = await makeJob(initialStateId, ids.tech1);

    const asked = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 1 })
      .expect(201);

    const declined = await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(asked.body as PartLine).id}/decline`,
      )
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ reason: 'Wrong part number for this model' })
      .expect(201);
    expect((declined.body as PartLine).status).toBe('REJECTED');
    expect(
      (declined.body as { rejection_reason: string | null }).rejection_reason,
    ).toBe('Wrong part number for this model');
    expect((await bucket(partId)).qty_reserved).toBe(0);
  });

  it('rejecting requires a reason, and a REQUESTED line cannot be approved', async () => {
    const partId = await makePart(`${TEST_PREFIX}-ORDER`, 2);
    const jobId = await makeJob(initialStateId, ids.tech1);
    const asked = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 1 })
      .expect(201);
    const lineId = (asked.body as PartLine).id;

    // Steps cannot be jumped: stores must raise it before anyone approves.
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${lineId}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(409);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${lineId}/issue-request`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts/${lineId}/reject`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ reason: '' })
      .expect(400);
  });

  it('a technician cannot approve their own request', async () => {
    const partId = await makePart(`${TEST_PREFIX}-SELFAPPROVE`, 2);
    const jobId = await makeJob(initialStateId, ids.tech1);
    const asked = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .send({ part_id: partId, qty: 1 })
      .expect(201);

    // TECHNICIAN holds neither 'inventory.issue' nor 'job.parts.approve'.
    await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(asked.body as PartLine).id}/issue-request`,
      )
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(
        `/api/v1/jobs/${jobId}/parts/${(asked.body as PartLine).id}/approve`,
      )
      .set('Authorization', `Bearer ${tokens.tech1}`)
      .expect(403);
  });
});
