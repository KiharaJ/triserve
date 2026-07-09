/**
 * Integration tests (Task 0.3) proving tenancy isolation against the REAL
 * MySQL database:
 *   - a user of company A cannot read/update company B's rows, even by id;
 *   - a scope='branch' user cannot read another branch of their own company;
 *   - creates are pinned to the acting user's company (forgeries ignored);
 *   - no-context system code bypasses scoping (documented rule).
 *
 * All fixtures are test-only (names prefixed __TEST_0_3__) and are removed
 * in afterAll — the real seed (Samsung ASC Group + 5 branches + admin) is
 * left untouched, which the last test asserts explicitly.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { runWithRequestContext } from '../common/context/request-context';
import type { AuthUser } from '../modules/auth/auth.types';
import { PrismaService } from './prisma.service';

// Jest does not load /api/.env; default to the local dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve';

const TEST_PREFIX = '__TEST_0_3__';

/** Raw (unextended) client for fixture setup/teardown. */
const raw = new PrismaClient();
/** The DI-shape client: PrismaClient + company-scope extension. */
const scoped = new PrismaService();

let companyAId: string;
let companyBId: string;
let branchAXId: string; // company A, branch "X"
let branchAYId: string; // company A, branch "Y"
let branchBId: string; // company B's branch
let currencyAId: string;
let currencyBId: string;

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: randomUUID(),
    sessionId: randomUUID(),
    companyId: companyAId,
    role: 'BRANCH_MANAGER',
    scope: 'group',
    homeBranchId: branchAXId,
    ...overrides,
  };
}

/**
 * Run `fn` as an authenticated request of `user` (what the middleware +
 * AuthGuard produce for real HTTP requests). NB: the await happens INSIDE
 * the ALS context — Prisma promises are lazy, and in production the whole
 * request pipeline (controller/service awaits included) runs inside the
 * middleware's `run()`, which this mirrors.
 */
function asUser<T>(user: AuthUser, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ user }, async () => await fn());
}

beforeAll(async () => {
  const [companyA, companyB] = await Promise.all([
    raw.company.create({ data: { name: `${TEST_PREFIX} Company A` } }),
    raw.company.create({ data: { name: `${TEST_PREFIX} Company B` } }),
  ]);
  companyAId = companyA.id;
  companyBId = companyB.id;

  const [ax, ay, b] = await Promise.all([
    raw.branch.create({
      data: { companyId: companyAId, code: 'TAX', name: `${TEST_PREFIX} A/X` },
    }),
    raw.branch.create({
      data: { companyId: companyAId, code: 'TAY', name: `${TEST_PREFIX} A/Y` },
    }),
    raw.branch.create({
      data: { companyId: companyBId, code: 'TB1', name: `${TEST_PREFIX} B/1` },
    }),
  ]);
  branchAXId = ax.id;
  branchAYId = ay.id;
  branchBId = b.id;

  const [curA, curB] = await Promise.all([
    raw.currency.create({
      data: {
        companyId: companyAId,
        code: 'ZZA',
        name: `${TEST_PREFIX} A`,
        symbol: 'A',
      },
    }),
    raw.currency.create({
      data: {
        companyId: companyBId,
        code: 'ZZB',
        name: `${TEST_PREFIX} B`,
        symbol: 'B',
      },
    }),
  ]);
  currencyAId = curA.id;
  currencyBId = curB.id;
});

afterAll(async () => {
  // Remove ONLY the fixtures (plus anything the create-tests added under
  // the two test companies); the real seed stays intact.
  const companyIds = [companyAId, companyBId].filter(Boolean);
  if (companyIds.length > 0) {
    await raw.currency.deleteMany({ where: { companyId: { in: companyIds } } });
    await raw.user.deleteMany({ where: { companyId: { in: companyIds } } });
    await raw.branch.deleteMany({ where: { companyId: { in: companyIds } } });
    await raw.company.deleteMany({ where: { id: { in: companyIds } } });
  }
  await raw.$disconnect();
  await scoped.$disconnect();
});

describe('company scoping (cross-tenant isolation)', () => {
  it('findMany returns ONLY the acting company rows', async () => {
    const branches = await asUser(makeUser(), () => scoped.branch.findMany());
    expect(branches.length).toBe(2);
    expect(branches.every((b) => b.companyId === companyAId)).toBe(true);
    const ids = branches.map((b) => b.id).sort();
    expect(ids).toEqual([branchAXId, branchAYId].sort());
    expect(ids).not.toContain(branchBId);
  });

  it('findUnique by a GUESSED company-B id returns null', async () => {
    const stolen = await asUser(makeUser(), () =>
      scoped.branch.findUnique({ where: { id: branchBId } }),
    );
    expect(stolen).toBeNull();
  });

  it('update of a company-B row by id is rejected (P2025 not found)', async () => {
    await expect(
      asUser(makeUser(), () =>
        scoped.branch.update({
          where: { id: branchBId },
          data: { name: 'hacked' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });
    // …and the row is untouched.
    const intact = await raw.branch.findUnique({ where: { id: branchBId } });
    expect(intact?.name).toBe(`${TEST_PREFIX} B/1`);
  });

  it('delete of a company-B row by id is rejected (P2025 not found)', async () => {
    await expect(
      asUser(makeUser(), () =>
        scoped.branch.delete({ where: { id: branchBId } }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('count only counts the acting company', async () => {
    const count = await asUser(makeUser(), () => scoped.branch.count());
    expect(count).toBe(2);
  });

  it('applies to config tables too (currencies)', async () => {
    const currencies = await asUser(makeUser(), () =>
      scoped.currency.findMany(),
    );
    expect(currencies.map((c) => c.id)).toEqual([currencyAId]);
    const stolen = await asUser(makeUser(), () =>
      scoped.currency.findUnique({ where: { id: currencyBId } }),
    );
    expect(stolen).toBeNull();
  });

  it('users of other companies are invisible (seed admin included)', async () => {
    // Company A (test) has no users → a company-A user sees NONE, even
    // though the seeded Samsung admin exists in the same table.
    const users = await asUser(makeUser(), () => scoped.user.findMany());
    expect(users).toEqual([]);
  });

  it('the companies table itself is pinned to id = companyId', async () => {
    const companies = await asUser(makeUser(), () => scoped.company.findMany());
    expect(companies.map((c) => c.id)).toEqual([companyAId]);
    const stolen = await asUser(makeUser(), () =>
      scoped.company.findUnique({ where: { id: companyBId } }),
    );
    expect(stolen).toBeNull();
  });

  it('create pins company_id to the acting user — forged ids are ignored', async () => {
    const created = await asUser(makeUser(), () =>
      scoped.branch.create({
        data: {
          // Forged cross-tenant create attempt:
          companyId: companyBId,
          code: 'TZZ',
          name: `${TEST_PREFIX} forged`,
        },
      }),
    );
    expect(created.companyId).toBe(companyAId); // NOT company B
    await raw.branch.delete({ where: { id: created.id } });
  });

  it('company B users symmetrically see only company B', async () => {
    const userB = makeUser({
      companyId: companyBId,
      homeBranchId: branchBId,
    });
    const branches = await asUser(userB, () => scoped.branch.findMany());
    expect(branches.map((b) => b.id)).toEqual([branchBId]);
    const stolen = await asUser(userB, () =>
      scoped.branch.findUnique({ where: { id: branchAXId } }),
    );
    expect(stolen).toBeNull();
  });
});

describe('branch scoping (scope=branch users)', () => {
  const branchUser = (): AuthUser =>
    makeUser({ role: 'TECHNICIAN', scope: 'branch', homeBranchId: branchAXId });

  it('findMany returns only the home branch', async () => {
    const branches = await asUser(branchUser(), () => scoped.branch.findMany());
    expect(branches.map((b) => b.id)).toEqual([branchAXId]);
  });

  it('CANNOT read a sibling branch of the SAME company by id', async () => {
    const stolen = await asUser(branchUser(), () =>
      scoped.branch.findUnique({ where: { id: branchAYId } }),
    );
    expect(stolen).toBeNull();
  });

  it('can read the home branch by id', async () => {
    const home = await asUser(branchUser(), () =>
      scoped.branch.findUnique({ where: { id: branchAXId } }),
    );
    expect(home?.id).toBe(branchAXId);
  });

  it('group-scoped users of the same company see every branch', async () => {
    const branches = await asUser(makeUser({ scope: 'group' }), () =>
      scoped.branch.findMany(),
    );
    expect(branches.map((b) => b.id).sort()).toEqual(
      [branchAXId, branchAYId].sort(),
    );
  });
});

describe('scoping bypass for system code (documented rule)', () => {
  it('no request context → unscoped (seeds/migrations/system jobs)', async () => {
    const row = await scoped.branch.findUnique({ where: { id: branchBId } });
    expect(row?.id).toBe(branchBId);
  });

  it('context without an authenticated user → unscoped (e.g. login)', async () => {
    const row = await runWithRequestContext({}, () =>
      scoped.branch.findUnique({ where: { id: branchBId } }),
    );
    expect(row?.id).toBe(branchBId);
  });
});

describe('real seed data stays intact', () => {
  it('Samsung ASC Group + 5 branches + 1 super admin, un-duplicated', async () => {
    const samsung = await raw.company.findMany({
      where: { name: 'Samsung ASC Group' },
    });
    expect(samsung.length).toBe(1);
    const branchCount = await raw.branch.count({
      where: { companyId: samsung[0].id },
    });
    expect(branchCount).toBe(5);
    const adminCount = await raw.user.count({
      where: { companyId: samsung[0].id, role: 'SUPER_ADMIN' },
    });
    expect(adminCount).toBe(1);
  });

  it('sanity: extension model lists reference real Prisma models', () => {
    expect(Object.keys(Prisma.ModelName)).toEqual(
      expect.arrayContaining(['Company', 'Branch', 'User', 'Currency']),
    );
  });
});
