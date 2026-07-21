/**
 * Close the imported job backlog (§4.3).
 *
 * The history importer books every spreadsheet row as a Job in the workflow's
 * INITIAL state, because that is all the source data says. Those jobs were
 * resolved in the real world long ago, but the system cannot tell them from
 * live work — so they sit "open" forever and dominate the board, the dashboard
 * and the Right-now snapshot, drowning the jobs that actually need attention.
 *
 * Scope is deliberately narrow. Only jobs that are ALL of:
 *   - imported (job_no starts with the importer's "H" prefix — app-generated
 *     numbers are BRANCH-YEAR-SEQ, so this cannot catch a real one);
 *   - still in a NON-TERMINAL state (already-closed jobs are left alone, which
 *     also makes a re-run a no-op);
 *   - older than --days (default 30), so anything plausibly still on the bench
 *     stays open.
 *
 * Every close writes an audit row carrying the previous state, so this is
 * traceable and reversible — the before_json is enough to put a job back.
 *
 *   npm run close:backlog -- [--days 30] [--state CLOSED] [--dry] [--limit N]
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry');
const DAYS = Number(arg('days', '30'));
const TARGET_STATE = arg('state', 'CLOSED');
const LIMIT = Number(arg('limit', '0'));
/** The importer's deterministic job_no prefix. */
const IMPORTED_PREFIX = 'H';
const BATCH = 500;

async function main(): Promise<void> {
  if (!Number.isFinite(DAYS) || DAYS < 0) {
    throw new Error(`--days must be a non-negative number, got "${DAYS}"`);
  }
  const cutoff = new Date(Date.now() - DAYS * 86_400_000);

  const target = await prisma.workflowState.findFirst({
    where: { code: TARGET_STATE, deletedAt: null },
  });
  if (!target) throw new Error(`No workflow state "${TARGET_STATE}"`);
  if (!target.isTerminal) {
    // Closing into a non-terminal state would leave the jobs "open" — the
    // whole point is that they stop counting as live work.
    throw new Error(`"${TARGET_STATE}" is not a terminal state`);
  }

  const where = {
    deletedAt: null,
    jobNo: { startsWith: IMPORTED_PREFIX },
    state: { isTerminal: false },
    receivedAt: { lt: cutoff },
  } as const;

  const total = await prisma.job.count({ where });
  console.log(
    `${DRY ? '[DRY RUN] ' : ''}closing imported jobs received before ` +
      `${cutoff.toISOString().slice(0, 10)} (older than ${DAYS} days) → ${target.label}`,
  );
  console.log(`  matching: ${total}`);
  if (LIMIT) console.log(`  limited to: ${LIMIT}`);

  if (DRY || total === 0) {
    const sample = await prisma.job.findMany({
      where,
      select: { jobNo: true, receivedAt: true },
      orderBy: { receivedAt: 'desc' },
      take: 3,
    });
    for (const s of sample) {
      console.log(
        `  e.g. ${s.jobNo}  received ${s.receivedAt.toISOString().slice(0, 10)}`,
      );
    }
    console.log(DRY ? '[DRY RUN] nothing written.' : 'Nothing to do.');
    return;
  }

  let done = 0;
  for (;;) {
    const take = LIMIT ? Math.min(BATCH, LIMIT - done) : BATCH;
    if (take <= 0) break;
    const batch = await prisma.job.findMany({
      where,
      select: {
        id: true,
        companyId: true,
        branchId: true,
        stateId: true,
        state: { select: { code: true } },
      },
      take,
    });
    if (batch.length === 0) break;

    for (const job of batch) {
      // One transaction per job: the state change and the audit row that
      // explains it must not be able to land separately.
      await prisma.$transaction([
        prisma.job.update({
          where: { id: job.id },
          data: { stateId: target.id },
        }),
        prisma.auditLog.create({
          data: {
            id: randomUUID(),
            companyId: job.companyId,
            branchId: job.branchId,
            // No actor: this is a system back-fill, not someone's action.
            actorUserId: null,
            entityType: 'Job',
            entityId: job.id,
            action: 'TRANSITION',
            beforeJson: { state_code: job.state.code },
            afterJson: {
              state_code: target.code,
              note: `Bulk close of imported backlog older than ${DAYS} days`,
            },
          },
        }),
      ]);
    }
    done += batch.length;
    console.log(`  closed ${done}/${LIMIT || total}`);
  }
  console.log(`Done — ${done} job(s) closed.`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
