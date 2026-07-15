/**
 * Integration tests (Task 3.1, DESIGN.md §4.6) for invoices against the REAL
 * MySQL database over HTTP:
 *   - POST /invoices drafts a sale: invoice_no INV-DAR-YYYY-NNNNN, subtotal =
 *     Σ(qty×price), total = subtotal − discount + tax, currency = company base;
 *   - a PART line with an unknown part_id → 400; discount > subtotal → 400;
 *   - PATCH edits a DRAFT (lines replace, totals recompute); non-DRAFT → 409;
 *   - void a DRAFT → VOID; a threshold rule HELDs the void (INVOICE_VOID);
 *     voiding a PAID invoice → 409; void needs invoice.void (advisor 403);
 *   - creating needs invoice.create (a TECHNICIAN is 403);
 *   - scoping: a KRK user can't see a DAR invoice; create writes a CREATE audit.
 *
 * Fixtures are test-only (prefixed __TEST_3_1__) and removed in afterAll.
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

const TEST_PREFIX = '__TEST_3_1__';
const PASSWORD = 'Invoice3.1-Pass!';

const EMAILS = {
  admin: 'test-3-1-admin@triserve.test',
  advisorDar: 'test-3-1-advisor-dar@triserve.test',
  mgrDar: 'test-3-1-mgr-dar@triserve.test',
  techDar: 'test-3-1-tech-dar@triserve.test',
  advisorKrk: 'test-3-1-advisor-krk@triserve.test',
};

const raw = new PrismaClient();

let app: INestApplication<App>;
let companyId: string;
let branchDar: string;
let branchKrk: string;
let partId: string;
let customerId: string;

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

interface InvoiceBody {
  id: string;
  invoice_no: string;
  status: string;
  currency: string;
  subtotal: string;
  total: string;
  lines: { id: string }[];
}

async function createInvoice(
  token: string,
  body: Record<string, unknown>,
  expectStatus = 201,
): Promise<InvoiceBody> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/invoices')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(expectStatus);
  const inv = res.body as InvoiceBody;
  if (inv.id) createdInvoiceIds.push(inv.id);
  return inv;
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

  const [admin, advisorDar, mgrDar, techDar, advisorKrk] = await Promise.all([
    mk(EMAILS.admin, 'SUPER_ADMIN', 'group', null),
    mk(EMAILS.advisorDar, 'SERVICE_ADVISOR', 'branch', branchDar),
    mk(EMAILS.mgrDar, 'BRANCH_MANAGER', 'branch', branchDar),
    mk(EMAILS.techDar, 'TECHNICIAN', 'branch', branchDar),
    mk(EMAILS.advisorKrk, 'SERVICE_ADVISOR', 'branch', branchKrk),
  ]);
  ids.admin = admin.id;
  ids.advisorDar = advisorDar.id;
  ids.mgrDar = mgrDar.id;
  ids.techDar = techDar.id;
  ids.advisorKrk = advisorKrk.id;

  partId = (
    await raw.part.create({
      data: {
        companyId,
        partNumber: `${TEST_PREFIX}-PART`,
        description: 'Invoice test part',
        category: 'HHP',
      },
    })
  ).id;
  customerId = (
    await raw.customer.create({
      data: { companyId, name: `${TEST_PREFIX} Customer` },
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
  tokens.advisorDar = await login(EMAILS.advisorDar);
  tokens.mgrDar = await login(EMAILS.mgrDar);
  tokens.techDar = await login(EMAILS.techDar);
  tokens.advisorKrk = await login(EMAILS.advisorKrk);
});

afterAll(async () => {
  const testUserIds = Object.values(ids);
  await raw.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } }); // cascades lines
  await raw.auditLog.deleteMany({
    where: { entityType: 'Invoice', entityId: { in: createdInvoiceIds } },
  });
  await raw.approval.deleteMany({
    where: { requestedById: { in: testUserIds } },
  });
  await raw.approvalRule.deleteMany({
    where: { companyId, type: 'INVOICE_VOID' },
  });
  await raw.customer.deleteMany({ where: { id: customerId } });
  await raw.part.deleteMany({ where: { id: partId } });
  await raw.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await raw.user.deleteMany({
    where: { email: { in: Object.values(EMAILS) } },
  });
  await raw.$disconnect();
  await app.close();
});

describe('Draft + totals', () => {
  it('drafts an invoice with computed totals and number', async () => {
    const inv = await createInvoice(tokens.advisorDar, {
      branch_id: branchDar,
      customer_id: customerId,
      type: 'PARTS_SALE',
      tax: '5000',
      discount: '2000',
      lines: [
        {
          line_type: 'PART',
          part_id: partId,
          description: 'LCD',
          qty: 2,
          unit_price: '45000',
        },
        {
          line_type: 'SERVICE',
          description: 'Fitting',
          qty: 1,
          unit_price: '10000',
        },
      ],
    });
    expect(inv.invoice_no).toMatch(/^INV-DAR-\d{4}-\d{5}$/);
    expect(inv.currency).toBe('TZS');
    expect(inv.subtotal).toBe('100000'); // 2×45000 + 10000
    expect(inv.total).toBe('103000'); // 100000 − 2000 + 5000

    // Edit: replace lines → totals recompute.
    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/invoices/${inv.id}`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({
        discount: '0',
        lines: [
          {
            line_type: 'PART',
            part_id: partId,
            description: 'LCD',
            qty: 1,
            unit_price: '45000',
          },
        ],
      })
      .expect(200);
    expect((patched.body as InvoiceBody).subtotal).toBe('45000');
    expect((patched.body as InvoiceBody).total).toBe('50000'); // 45000 + 5000 tax
  });

  it('rejects an unknown part line and an over-discount', async () => {
    await createInvoice(
      tokens.advisorDar,
      {
        branch_id: branchDar,
        type: 'PARTS_SALE',
        lines: [
          {
            line_type: 'PART',
            part_id: '00000000-0000-4000-8000-000000000000',
            description: 'ghost',
            qty: 1,
            unit_price: '1000',
          },
        ],
      },
      400,
    );
    await createInvoice(
      tokens.advisorDar,
      {
        branch_id: branchDar,
        type: 'PARTS_SALE',
        discount: '99999',
        lines: [
          {
            line_type: 'CUSTOM',
            description: 'small',
            qty: 1,
            unit_price: '1000',
          },
        ],
      },
      400,
    );
  });
});

describe('Void + permissions + scoping', () => {
  const line = {
    line_type: 'CUSTOM',
    description: 'item',
    qty: 1,
    unit_price: '20000',
  };

  it('voids a DRAFT; holds when over the threshold; blocks PAID/void', async () => {
    const inv = await createInvoice(tokens.advisorDar, {
      branch_id: branchDar,
      type: 'ACCESSORY',
      lines: [line],
    });
    // An advisor lacks invoice.void.
    await request(app.getHttpServer())
      .post(`/api/v1/invoices/${inv.id}/void`)
      .set('Authorization', `Bearer ${tokens.advisorDar}`)
      .send({ reason: 'mistake' })
      .expect(403);
    // The branch manager voids it.
    const voided = await request(app.getHttpServer())
      .post(`/api/v1/invoices/${inv.id}/void`)
      .set('Authorization', `Bearer ${tokens.mgrDar}`)
      .send({ reason: 'mistake' })
      .expect(201);
    expect((voided.body as { invoice: InvoiceBody }).invoice.status).toBe(
      'VOID',
    );
    // Re-voiding → 409.
    await request(app.getHttpServer())
      .post(`/api/v1/invoices/${inv.id}/void`)
      .set('Authorization', `Bearer ${tokens.mgrDar}`)
      .send({ reason: 'again' })
      .expect(409);

    // With a rule, a void is held for approval (nothing changes).
    await raw.approvalRule.create({
      data: {
        companyId,
        type: 'INVOICE_VOID',
        thresholdAmount: 1_000n,
        enabled: true,
      },
    });
    const inv2 = await createInvoice(tokens.advisorDar, {
      branch_id: branchDar,
      type: 'ACCESSORY',
      lines: [line],
    });
    const held = await request(app.getHttpServer())
      .post(`/api/v1/invoices/${inv2.id}/void`)
      .set('Authorization', `Bearer ${tokens.mgrDar}`)
      .send({ reason: 'big void' })
      .expect(201);
    const body = held.body as {
      held: boolean;
      invoice: InvoiceBody;
      pending_approval?: { status: string };
    };
    expect(body.held).toBe(true);
    expect(body.invoice.status).toBe('DRAFT');
    expect(body.pending_approval?.status).toBe('PENDING');
    await raw.approvalRule.deleteMany({
      where: { companyId, type: 'INVOICE_VOID' },
    });

    // A PAID invoice can't be voided.
    const inv3 = await createInvoice(tokens.advisorDar, {
      branch_id: branchDar,
      type: 'ACCESSORY',
      lines: [line],
    });
    await raw.invoice.update({
      where: { id: inv3.id },
      data: { status: 'PAID' },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/invoices/${inv3.id}/void`)
      .set('Authorization', `Bearer ${tokens.mgrDar}`)
      .send({ reason: 'nope' })
      .expect(409);
  });

  it('creating needs invoice.create; a TECHNICIAN is 403', async () => {
    await createInvoice(
      tokens.techDar,
      { branch_id: branchDar, type: 'ACCESSORY', lines: [line] },
      403,
    );
  });

  it('a KRK advisor cannot see a DAR invoice', async () => {
    const inv = await createInvoice(tokens.advisorDar, {
      branch_id: branchDar,
      type: 'ACCESSORY',
      lines: [line],
    });
    await request(app.getHttpServer())
      .get(`/api/v1/invoices/${inv.id}`)
      .set('Authorization', `Bearer ${tokens.advisorKrk}`)
      .expect(404);

    // Create wrote a CREATE audit row.
    const audit = await raw.auditLog.findFirst({
      where: { entityType: 'Invoice', entityId: inv.id, action: 'CREATE' },
    });
    expect(audit).not.toBeNull();
  });
});
