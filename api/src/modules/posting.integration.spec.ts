/**
 * Integration tests (Task 3.3, DESIGN.md §4.9 / E1) for automatic payment
 * posting against the REAL MySQL database over HTTP. Recording a payment posts
 * a balanced double-entry IN THE SAME transaction:
 *   - a CASH payment → Dr Cash (1000) / Cr Revenue (4000) [+ Cr VAT (2100) for
 *     the payment's proportional VAT share]; source_type PAYMENT, source_id =
 *     the payment; entry balances;
 *   - MPESA posts to Bank (1010) instead of Cash;
 *   - a partial payment posts its proportional VAT share.
 *
 * Fixtures are test-only (prefixed __TEST_3_3__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_3_3__';
const PASSWORD = 'Posting3.3-Pass!';
const EMAILS = { advisorDar: 'test-3-3-advisor-dar@triserve.test' };

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let advisorId: string;
let token: string;
const acct: Record<string, string> = {}; // code → account id

const createdInvoiceIds: string[] = [];
const paymentIds: string[] = [];

async function login(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

/** Create a DRAFT TZS invoice (raw) with the given total + tax. */
async function makeInvoice(total: number, tax: number): Promise<string> {
  const inv = await raw.invoice.create({
    data: {
      companyId,
      invoiceNo: `INV-${TEST_PREFIX}-${randomUUID().slice(0, 8)}`,
      branchId: branchDar,
      type: 'PARTS_SALE',
      currency: 'TZS',
      subtotal: BigInt(total - tax),
      tax: BigInt(tax),
      total: BigInt(total),
      status: 'DRAFT',
      soldById: advisorId,
      lines: {
        create: [
          {
            lineType: 'CUSTOM',
            description: 'item',
            qty: 1,
            unitPrice: BigInt(total - tax),
            lineTotal: BigInt(total - tax),
          },
        ],
      },
    },
  });
  createdInvoiceIds.push(inv.id);
  return inv.id;
}

async function pay(
  invoiceId: string,
  method: string,
  amount: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/invoices/${invoiceId}/payments`)
    .set('Authorization', `Bearer ${token}`)
    .send({ method, amount })
    .expect(201);
  const id = (res.body as { payment: { id: string } }).payment.id;
  paymentIds.push(id);
  return id;
}

/** The posted PAYMENT journal entry (with lines) for a payment. */
async function entryFor(paymentId: string) {
  return raw.journalEntry.findFirst({
    where: { sourceType: 'PAYMENT', sourceId: paymentId },
    include: { lines: true },
  });
}

beforeAll(async () => {
  const seeded = await raw.company.findFirstOrThrow({
    where: { name: 'Samsung ASC Group' },
  });
  companyId = seeded.id;
  branchDar = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;

  for (const a of await raw.chartOfAccount.findMany({
    where: { companyId, code: { in: ['1000', '1010', '2100', '4000'] } },
  })) {
    acct[a.code] = a.id;
  }

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const advisor = await raw.user.create({
    data: {
      companyId,
      fullName: `${TEST_PREFIX} advisor`,
      email: EMAILS.advisorDar,
      passwordHash,
      role: 'SERVICE_ADVISOR',
      scope: 'branch',
      homeBranchId: branchDar,
    },
  });
  advisorId = advisor.id;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  token = await login(EMAILS.advisorDar);
});

afterAll(async () => {
  const entries = await raw.journalEntry.findMany({
    where: { sourceType: 'PAYMENT', sourceId: { in: paymentIds } },
    select: { id: true },
  });
  const entryIds = entries.map((e) => e.id);
  await raw.journalLine.deleteMany({ where: { entryId: { in: entryIds } } });
  await raw.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await raw.payment.deleteMany({
    where: { invoiceId: { in: createdInvoiceIds } },
  });
  await raw.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  await raw.auditLog.deleteMany({
    where: { companyId, entityType: 'Payment', actorUserId: advisorId },
  });
  await raw.session.deleteMany({ where: { userId: advisorId } });
  await raw.user.deleteMany({ where: { email: EMAILS.advisorDar } });
  await raw.$disconnect();
  await app.close();
});

describe('Automatic payment posting', () => {
  it('a CASH payment posts Dr Cash / Cr Revenue + VAT, balanced', async () => {
    const invoiceId = await makeInvoice(118_000, 18_000); // net 100k + 18k VAT
    const paymentId = await pay(invoiceId, 'CASH', '118000');

    const entry = await entryFor(paymentId);
    expect(entry).not.toBeNull();
    expect(entry!.branchId).toBe(branchDar);
    expect(entry!.lines).toHaveLength(3);

    const byAccount = new Map(entry!.lines.map((l) => [l.accountId, l]));
    // Dr Cash 118000.
    expect(byAccount.get(acct['1000'])!.debit).toBe(118_000n);
    // Cr Revenue 100000.
    expect(byAccount.get(acct['4000'])!.credit).toBe(100_000n);
    // Cr VAT 18000.
    expect(byAccount.get(acct['2100'])!.credit).toBe(18_000n);

    // Balanced.
    const debit = entry!.lines.reduce((s, l) => s + l.debit, 0n);
    const credit = entry!.lines.reduce((s, l) => s + l.credit, 0n);
    expect(debit).toBe(credit);
    expect(debit).toBe(118_000n);
  });

  it('MPESA posts to Bank (1010) not Cash', async () => {
    const invoiceId = await makeInvoice(50_000, 0);
    const paymentId = await pay(invoiceId, 'MPESA', '50000');
    const entry = await entryFor(paymentId);
    expect(entry!.lines).toHaveLength(2); // no VAT line
    const accounts = entry!.lines.map((l) => l.accountId);
    expect(accounts).toContain(acct['1010']); // Bank
    expect(accounts).not.toContain(acct['1000']); // not Cash
  });

  it('a partial payment posts its proportional VAT share', async () => {
    const invoiceId = await makeInvoice(118_000, 18_000);
    const paymentId = await pay(invoiceId, 'CASH', '59000'); // half
    const entry = await entryFor(paymentId);
    const byAccount = new Map(entry!.lines.map((l) => [l.accountId, l]));
    // VAT share = 59000 × 18000 / 118000 = 9000; revenue = 50000.
    expect(byAccount.get(acct['2100'])!.credit).toBe(9_000n);
    expect(byAccount.get(acct['4000'])!.credit).toBe(50_000n);
    expect(byAccount.get(acct['1000'])!.debit).toBe(59_000n);
  });
});
