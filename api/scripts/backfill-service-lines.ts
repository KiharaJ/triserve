/**
 * Backfill the service line on jobs that predate it (§4.3).
 *
 * Jobs booked before service lines existed have none, so the Right-now
 * snapshot files them all under "Not set" and no open job has a turnaround
 * target. The device's Samsung repair grouping is a reliable proxy for what
 * the customer was asking for, so the line is derived from it.
 *
 * TWO DIFFERENT THINGS, and only one is applied to closed jobs:
 *
 *   - the SERVICE LINE is a statement about what the repair WAS. That is just
 *     as true of a finished job, so it is backfilled everywhere — it is what
 *     makes per-line history worth reading.
 *
 *   - the SLA TARGET is a promise about when work will be done. Writing one
 *     onto a job that finished years ago would invent a deadline nobody ever
 *     made, so targets are set on OPEN jobs only.
 *
 * The target on an open job is honestly retroactive: it says "measured against
 * today's standard turnaround, this is where it should have been". Most of the
 * remaining backlog is far older than any SLA, so expect them to read overdue
 * immediately — that is the true statement, not a glitch.
 *
 * Idempotent: only touches jobs whose service_category_id is NULL.
 *
 *   npm run backfill:service-lines -- [--dry] [--limit N]
 */
import { PrismaClient, type DeviceCategory } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const DRY = process.argv.includes('--dry');
const limitArg = process.argv.indexOf('--limit');
const LIMIT =
  limitArg !== -1 && process.argv[limitArg + 1]
    ? Number(process.argv[limitArg + 1])
    : 0;
const BATCH = 500;

/**
 * Device grouping → service line code. AC and REF share one line because a
 * centre sends one engineer to both; OTHER falls to general repair rather than
 * being guessed at.
 */
const LINE_BY_CATEGORY: Record<DeviceCategory, string> = {
  HHP: 'MOBILE',
  CE: 'CE',
  AC: 'AC_REF',
  REF: 'AC_REF',
  OTHER: 'GENERAL',
};

async function main(): Promise<void> {
  const lines = await prisma.serviceCategory.findMany({
    where: { deletedAt: null },
  });
  const lineByCode = new Map(lines.map((l) => [l.code, l]));
  for (const code of new Set(Object.values(LINE_BY_CATEGORY))) {
    if (!lineByCode.has(code)) {
      throw new Error(`No service category "${code}" — seed them first`);
    }
  }

  const where = { deletedAt: null, serviceCategoryId: null } as const;
  const total = await prisma.job.count({ where });
  console.log(
    `${DRY ? '[DRY RUN] ' : ''}backfilling service lines on ${total} job(s)`,
  );

  if (DRY) {
    const preview = await prisma.job.groupBy({
      by: ['stateId'],
      where,
      _count: { _all: true },
    });
    const states = await prisma.workflowState.findMany();
    const byId = new Map(states.map((s) => [s.id, s]));
    for (const p of preview) {
      const s = byId.get(p.stateId);
      console.log(
        `  ${s?.label ?? '?'}: ${p._count._all}` +
          (s?.isTerminal ? ' (line only — no target)' : ' (line + target)'),
      );
    }
    console.log('[DRY RUN] nothing written.');
    return;
  }

  let done = 0;
  const tally = new Map<string, number>();
  for (;;) {
    const take = LIMIT ? Math.min(BATCH, LIMIT - done) : BATCH;
    if (take <= 0) break;
    const batch = await prisma.job.findMany({
      where,
      select: {
        id: true,
        companyId: true,
        branchId: true,
        receivedAt: true,
        device: { select: { category: true } },
        state: { select: { isTerminal: true } },
      },
      take,
    });
    if (batch.length === 0) break;

    for (const job of batch) {
      const line = lineByCode.get(LINE_BY_CATEGORY[job.device.category]);
      if (!line) continue;
      // Only an OPEN job gets a target — see the header.
      const slaDueAt =
        !job.state.isTerminal && line.defaultSlaHours
          ? new Date(
              job.receivedAt.getTime() + line.defaultSlaHours * 3_600_000,
            )
          : null;

      await prisma.$transaction([
        prisma.job.update({
          where: { id: job.id },
          data: {
            serviceCategoryId: line.id,
            ...(slaDueAt ? { slaDueAt } : {}),
          },
        }),
        prisma.auditLog.create({
          data: {
            id: randomUUID(),
            companyId: job.companyId,
            branchId: job.branchId,
            // System back-fill, not someone's action.
            actorUserId: null,
            entityType: 'Job',
            entityId: job.id,
            action: 'UPDATE',
            beforeJson: { service_category_id: null, sla_due_at: null },
            afterJson: {
              service_category_id: line.id,
              sla_due_at: slaDueAt?.toISOString() ?? null,
              note: `Service line derived from device category ${job.device.category}`,
            },
          },
        }),
      ]);
      tally.set(line.code, (tally.get(line.code) ?? 0) + 1);
    }
    done += batch.length;
    console.log(`  ${done}/${LIMIT || total}`);
  }

  for (const [code, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code}: ${n}`);
  }
  console.log(`Done — ${done} job(s) updated.`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
