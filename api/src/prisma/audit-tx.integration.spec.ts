/**
 * Integration tests proving the audit hook JOINS a caller-managed
 * transaction instead of opening a second one on another connection.
 *
 * REGRESSION THIS LOCKS DOWN
 *
 * The hook used to re-dispatch every audited mutation through
 * `inner.$transaction(...)`. Inside `PrismaService.$transaction(...)` that was
 * a SEPARATE transaction on a SEPARATE connection, which:
 *   - escaped the caller's transaction, so the audited row committed even when
 *     the caller rolled back — a half-committed write; and
 *   - deadlocked whenever the caller's transaction already held a lock the
 *     hook's transaction needed (the classic case: the caller inserts a child
 *     row, taking a shared FK lock on the parent, then mutates the parent),
 *     which Prisma surfaced as a 5s interactive-transaction timeout.
 *
 * In production this stopped every job state move between 2026-08-05 and
 * 2026-08-14: `jobs.state_id` advanced while the SLA clock rows written in the
 * caller's transaction were rolled back, and the request 500'd.
 *
 * Fixtures are test-only (prefixed __TEST_AUDIT_TX__) and removed in afterAll.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { runWithRequestContext } from '../common/context/request-context';
import type { AuthUser } from '../modules/auth/auth.types';
import { PrismaService } from './prisma.service';

// Jest does not load /api/.env; default to the local dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/triserve_test';

const TEST_PREFIX = '__TEST_AUDIT_TX__';

/** Raw (unextended) client for fixture setup/teardown and row assertions. */
const raw = new PrismaClient();
/** The DI-shape client: company-scope + audit extensions, wrapped $transaction. */
const db = new PrismaService();

let companyId: string;
let branchId: string;
let userId: string;

function actor(): AuthUser {
  return {
    userId,
    sessionId: randomUUID(),
    companyId,
    role: 'SUPER_ADMIN',
    scope: 'group',
    homeBranchId: branchId,
  };
}

function asUser<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ user: actor() }, async () => await fn());
}

/** A fresh audited row to mutate: a Currency belongs to the audited set. */
async function makeCurrency(code: string): Promise<string> {
  const row = await raw.currency.create({
    data: { companyId, code, name: `${TEST_PREFIX} ${code}`, symbol: 'X' },
  });
  return row.id;
}

function auditRowsFor(entityId: string) {
  return raw.auditLog.findMany({ where: { entityId } });
}

beforeAll(async () => {
  const company = await raw.company.create({
    data: { name: `${TEST_PREFIX} Co` },
  });
  companyId = company.id;
  const branch = await raw.branch.create({
    data: { companyId, code: 'ATX', name: `${TEST_PREFIX} Branch` },
  });
  branchId = branch.id;
  const user = await raw.user.create({
    data: {
      companyId,
      fullName: `${TEST_PREFIX} Actor`,
      email: `audit-tx-${randomUUID()}@triserve.test`,
      passwordHash: 'x',
      role: 'SUPER_ADMIN',
      scope: 'group',
      homeBranchId: branchId,
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await raw.auditLog.deleteMany({ where: { companyId } });
  await raw.currency.deleteMany({ where: { companyId } });
  await raw.user.deleteMany({ where: { companyId } });
  await raw.branch.deleteMany({ where: { companyId } });
  await raw.company.deleteMany({ where: { id: companyId } });
  await raw.$disconnect();
  await db.$disconnect();
});

describe('audited mutations inside a caller-managed $transaction', () => {
  it('rolls the audit row back WITH the caller transaction', async () => {
    // The decisive test: when the caller's transaction aborts, an audit row
    // that joined it must vanish too. The old hook committed it on its own
    // connection, leaving an audit trail for a mutation that never happened.
    const id = await makeCurrency('ZT1');

    await expect(
      asUser(() =>
        db.$transaction(async (tx) => {
          await tx.currency.update({
            where: { id },
            data: { name: `${TEST_PREFIX} renamed` },
          });
          throw new Error('CALLER_ROLLBACK');
        }),
      ),
    ).rejects.toThrow('CALLER_ROLLBACK');

    const row = await raw.currency.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe(`${TEST_PREFIX} ZT1`); // mutation rolled back
    expect(await auditRowsFor(id)).toHaveLength(0); // …and so did its audit row
  });

  it('commits the audit row WITH the caller transaction', async () => {
    const id = await makeCurrency('ZT2');

    await asUser(() =>
      db.$transaction(async (tx) => {
        await tx.currency.update({
          where: { id },
          data: { name: `${TEST_PREFIX} committed` },
        });
      }),
    );

    const row = await raw.currency.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe(`${TEST_PREFIX} committed`);

    const audits = await auditRowsFor(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'UPDATE',
      entityType: 'Currency',
      actorUserId: userId,
    });
    // The snapshots must still be full rows, not the caller's `select`.
    expect(audits[0].beforeJson).toMatchObject({ name: `${TEST_PREFIX} ZT2` });
    expect(audits[0].afterJson).toMatchObject({
      name: `${TEST_PREFIX} committed`,
    });
  });

  it('does not deadlock when the caller already holds a lock on the row', async () => {
    // The production shape: the caller writes something else first (taking
    // locks), THEN mutates the audited row in the same transaction. A hook
    // that opened its own connection would block on the caller's locks until
    // Prisma's 5s transaction timeout fired.
    const id = await makeCurrency('ZT3');

    await asUser(() =>
      db.$transaction(async (tx) => {
        // Another audited write in the same tx — two joins, one connection.
        await tx.branch.update({
          where: { id: branchId },
          data: { name: `${TEST_PREFIX} Branch touched` },
        });
        await tx.currency.update({
          where: { id },
          data: { name: `${TEST_PREFIX} after lock` },
        });
      }),
    );

    expect((await raw.currency.findUniqueOrThrow({ where: { id } })).name).toBe(
      `${TEST_PREFIX} after lock`,
    );
    expect(await auditRowsFor(id)).toHaveLength(1);
    expect(await auditRowsFor(branchId)).toHaveLength(1);
  }, 20_000);

  it('still audits a bare mutation outside any transaction', async () => {
    // The self-managed path must keep working untouched.
    const id = await makeCurrency('ZT4');

    await asUser(() =>
      db.currency.update({
        where: { id },
        data: { name: `${TEST_PREFIX} bare` },
      }),
    );

    expect((await raw.currency.findUniqueOrThrow({ where: { id } })).name).toBe(
      `${TEST_PREFIX} bare`,
    );
    expect(await auditRowsFor(id)).toHaveLength(1);
  });

  it('keeps company scoping inside the joined transaction', async () => {
    // An out-of-scope update must still fail with P2025 and write no audit
    // row — the scope extension runs on the caller's tx client too.
    const otherCompany = await raw.company.create({
      data: { name: `${TEST_PREFIX} Other` },
    });
    const foreign = await raw.currency.create({
      data: {
        companyId: otherCompany.id,
        code: 'ZT5',
        name: `${TEST_PREFIX} foreign`,
        symbol: 'Y',
      },
    });

    await expect(
      asUser(() =>
        db.$transaction(async (tx) => {
          await tx.currency.update({
            where: { id: foreign.id },
            data: { name: 'hacked' },
          });
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    expect(
      (await raw.currency.findUniqueOrThrow({ where: { id: foreign.id } }))
        .name,
    ).toBe(`${TEST_PREFIX} foreign`);
    expect(await auditRowsFor(foreign.id)).toHaveLength(0);

    await raw.currency.deleteMany({ where: { companyId: otherCompany.id } });
    await raw.auditLog.deleteMany({ where: { companyId: otherCompany.id } });
    await raw.company.deleteMany({ where: { id: otherCompany.id } });
  });
});
