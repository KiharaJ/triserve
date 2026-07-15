/**
 * Integration tests (Task 3.2, DESIGN.md §4.6) for payments against the REAL
 * MySQL database over HTTP:
 *   - POST /invoices/{id}/payments records a payment and advances the invoice:
 *     a partial payment → PARTIAL (amount_paid/balance right), the rest → PAID;
 *   - overpayment (> outstanding balance) → 422; paying a PAID/VOID invoice →
 *     409;
 *   - GET /invoices/{id}/payments lists the history; the invoice wire carries
 *     amount_paid + balance;
 *   - recording needs payment.capture (a STOREKEEPER is 403);
 *   - scoping: company B can't pay company A's invoice; a payment writes a
 *     CREATE audit row.
 *
 * Fixtures are test-only (prefixed __TEST_3_2__) and removed in afterAll.
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
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_3_2__';
const PASSWORD = 'Payment3.2-Pass!';

const EMAILS = {
  admin: 'test-3-2-admin@triserve.test',
  advisorDar: 'test-3-2-advisor-dar@triserve.test',
  storeDar: 'test-3-2-store-dar@triserve.test',
  adminB: 'test-3-2-admin-b@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let companyBId: string;
let branchDar: string;

const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const createdInvoiceIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

/** Create a DRAFT invoice (raw) at DAR with the given total. */
async function makeInvoice(total: number, status = 'DRAFT'): Promise<string> {
  const inv = await raw.invoice.create({
    data: {
      companyId,
      invoiceNo: `INV-${TEST_PREFIX}-${randomUUID().slice(0, 8)}`,
      branchId: branchDar,
      type: 'ACCESSORY',
      currency: 'TZS',
      subtotal: BigInt(total),
      total: BigInt(total),
      status: status as 'DRAFT',
      soldById: ids.admin,
      lines: {
        create: [
          {
            lineType: 'CUSTOM',
            description: 'item',
            qty: 1,
            unitPrice: BigInt(total),
            lineTotal: BigInt(total),
          },
        ],
      },
    },
  });
  createdInvoiceIds.push(inv.id);
  return inv.id;
}

const pay = (token: string, invoiceId: string, body: Record<string, unknown>) =>
  request(app.getHttpServer())
    .post(`/api/v1/invoices/${invoiceId}/payments`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;

  const companyB = await raw.company.create({
    data: { name: `${TEST_PREFIX} Rival Co` },
  });
  companyBId = companyB.id;

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

  const [admin, advisorDar, storeDar, adminB] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', companyId, null),
    mk(EMAILS.advisorDar, 'SERVICE_ADVISOR', 'branch', companyId, branchDar),
    mk(EMAILS.storeDar, 'STOREKEEPER', 'branch', companyId, branchDar),
    mk(EMAILS.adminB, 'SUPER_ADMIN', 'group', companyBId, null),
  ]);
  ids.admin = admin.id;
  ids.advisorDar = advisorDar.id;
  ids.storeDar = storeDar.id;
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
  tokens.advisorDar = await login(EMAILS.advisorDar);
  tokens.storeDar = await login(EMAILS.storeDar);
  tokens.adminB = await login(EMAILS.adminB);
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  // Task 3.3: recording a payment auto-posts a journal entry (posted_by = the
  // paying test user). Remove those before the users/company they reference.
  const entries = await raw.journalEntry.findMany({
    where: { postedById: { in: testUserIds } },
    select: { id: true },
  });
  const entryIds = entries.map((e) => e.id);
  await raw.journalLine.deleteMany({ where: { entryId: { in: entryIds } } });
  await raw.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await raw.payment.deleteMany({
    where: { invoiceId: { in: createdInvoiceIds } },
  });
  await raw.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } }); // cascades lines
  await raw.auditLog.deleteMany({
    where: {
      OR: [
        { companyId, entityType: 'Payment' },
        { actorUserId: { in: testUserIds } },
      ],
    },
  });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.company.delete({ where: { id: companyBId } });
  await raw.$disconnect();
  await app.close();
});

describe('Deposit → balance → paid', () => {
  it('partial then full payment advances DRAFT → PARTIAL → PAID', async () => {
    const invoiceId = await makeInvoice(100_000);

    const p1 = await pay(tokens.advisorDar, invoiceId, {
      method: 'CASH',
      amount: '40000',
    }).expect(201);
    const r1 = p1.body as {
      invoice: { status: string; amount_paid: string; balance: string };
    };
    expect(r1.invoice.status).toBe('PARTIAL');
    expect(r1.invoice.amount_paid).toBe('40000');
    expect(r1.invoice.balance).toBe('60000');

    const p2 = await pay(tokens.advisorDar, invoiceId, {
      method: 'MPESA',
      amount: '60000',
      reference: 'QGH7X8',
    }).expect(201);
    const r2 = p2.body as { invoice: { status: string; balance: string } };
    expect(r2.invoice.status).toBe('PAID');
    expect(r2.invoice.balance).toBe('0');

    // Fully paid → can't pay more.
    await pay(tokens.advisorDar, invoiceId, {
      method: 'CASH',
      amount: '1',
    }).expect(409);

    // The invoice wire carries payments + amount_paid/balance.
    const inv = await request(app.getHttpServer())
      .get(`/api/v1/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    const body = inv.body as {
      amount_paid: string;
      balance: string;
      payments: unknown[];
    };
    expect(body.amount_paid).toBe('100000');
    expect(body.balance).toBe('0');
    expect(body.payments).toHaveLength(2);

    // GET /invoices/{id}/payments history.
    const hist = await request(app.getHttpServer())
      .get(`/api/v1/invoices/${invoiceId}/payments`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .expect(200);
    expect((hist.body as unknown[]).length).toBe(2);

    // Audit CREATE row for a payment.
    const audit = await raw.auditLog.findFirst({
      where: { companyId, entityType: 'Payment' },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects overpayment and paying a VOID invoice', async () => {
    const invoiceId = await makeInvoice(50_000);
    await pay(tokens.advisorDar, invoiceId, {
      method: 'CASH',
      amount: '60000',
    }).expect(422);

    const voidId = await makeInvoice(10_000, 'VOID');
    await pay(tokens.advisorDar, voidId, {
      method: 'CASH',
      amount: '5000',
    }).expect(409);
  });
});

describe('Permissions + scoping', () => {
  it('recording needs payment.capture (a STOREKEEPER is 403)', async () => {
    const invoiceId = await makeInvoice(20_000);
    await pay(tokens.storeDar, invoiceId, {
      method: 'CASH',
      amount: '20000',
    }).expect(403);
  });

  it("company B cannot pay company A's invoice", async () => {
    const invoiceId = await makeInvoice(20_000);
    await pay(tokens.adminB, invoiceId, {
      method: 'CASH',
      amount: '20000',
    }).expect(404);
  });
});
