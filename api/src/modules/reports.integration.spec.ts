/**
 * Integration tests (Phase 5 / E1) for the financial reports against the REAL
 * MySQL database over HTTP. A balanced test entry is posted in an ISOLATED past
 * period (2020) so the assertions don't mix with live/backfilled ledger data:
 *   - trial-balance groups by currency, lists per-account debit/credit balances
 *     and balances (Σdebit = Σcredit);
 *   - profit-loss nets REVENUE − EXPENSE per currency;
 *   - both need accounting.read (a SERVICE_ADVISOR is 403).
 * Fixtures are test-only (prefixed __TEST_5_2__) and removed in afterAll.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

const TEST_PREFIX = '__TEST_5_2__';
const PASSWORD = 'Reports5.2-Pass!';
const EMAILS = {
  admin: 'test-5-2-admin@triserve.test',
  advisor: 'test-5-2-advisor@triserve.test',
};
const FROM = '2020-01-01';
const TO = '2020-12-31';

const raw = new PrismaClient();
let app: INestApplication<App>;
let companyId: string;
let branchId: string;
let adminId: string;
let entryId: string;
const acct: Record<string, string> = {};
const tokens: Record<string, string> = {};

async function login(email: string): Promise<string> {
  return (
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200)
  ).body.access_token;
}

beforeAll(async () => {
  companyId = (
    await raw.company.findFirstOrThrow({ where: { name: 'Samsung ASC Group' } })
  ).id;
  branchId = (
    await raw.branch.findFirstOrThrow({ where: { companyId, code: 'DAR' } })
  ).id;
  for (const a of await raw.chartOfAccount.findMany({
    where: { companyId, code: { in: ['1000', '4000'] } },
  })) {
    acct[a.code] = a.id;
  }

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  adminId = (
    await raw.user.create({
      data: {
        companyId,
        fullName: `${TEST_PREFIX} admin`,
        email: EMAILS.admin,
        passwordHash,
        role: 'SUPER_ADMIN',
        scope: 'group',
        homeBranchId: null,
      },
    })
  ).id;
  await raw.user.create({
    data: {
      companyId,
      fullName: `${TEST_PREFIX} advisor`,
      email: EMAILS.advisor,
      passwordHash,
      role: 'SERVICE_ADVISOR',
      scope: 'branch',
      homeBranchId: branchId,
    },
  });

  // A balanced entry in 2020: Dr Cash 100000 / Cr Repair Revenue 100000 (TZS).
  entryId = (
    await raw.journalEntry.create({
      data: {
        companyId,
        branchId,
        entryDate: new Date('2020-06-15'),
        sourceType: 'MANUAL',
        memo: `${TEST_PREFIX} test entry`,
        postedById: adminId,
        lines: {
          create: [
            { accountId: acct['1000'], debit: 100_000n, currency: 'TZS' },
            { accountId: acct['4000'], credit: 100_000n, currency: 'TZS' },
          ],
        },
      },
    })
  ).id;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  tokens.admin = await login(EMAILS.admin);
  tokens.advisor = await login(EMAILS.advisor);
});

afterAll(async () => {
  await raw.journalLine.deleteMany({ where: { entryId } });
  await raw.journalEntry.deleteMany({ where: { id: entryId } });
  await raw.session.deleteMany({
    where: { user: { email: { in: Object.values(EMAILS) } } },
  });
  await raw.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await raw.$disconnect();
  await app.close();
});

describe('Financial reports', () => {
  it('trial balance groups by currency and balances', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/trial-balance?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(200);
    const body = res.body as {
      currencies: {
        currency: string;
        total_debit: string;
        total_credit: string;
        balanced: boolean;
        rows: { code: string; balance: string }[];
      }[];
    };
    const tzs = body.currencies.find((c) => c.currency === 'TZS');
    expect(tzs).toBeDefined();
    expect(tzs!.total_debit).toBe('100000');
    expect(tzs!.total_credit).toBe('100000');
    expect(tzs!.balanced).toBe(true);
    expect(tzs!.rows.find((r) => r.code === '1000')!.balance).toBe('100000');
    expect(tzs!.rows.find((r) => r.code === '4000')!.balance).toBe('-100000');
  });

  it('profit & loss nets revenue for the period', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/profit-loss?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(200);
    const body = res.body as {
      currencies: { currency: string; total_revenue: string; net_profit: string }[];
    };
    const tzs = body.currencies.find((c) => c.currency === 'TZS');
    expect(tzs!.total_revenue).toBe('100000');
    expect(tzs!.net_profit).toBe('100000');
  });

  it('needs accounting.read — a SERVICE_ADVISOR is 403', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/reports/trial-balance')
      .set('Authorization', `Bearer ${tokens.advisor}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/reports/profit-loss')
      .set('Authorization', `Bearer ${tokens.advisor}`)
      .expect(403);
  });
});
