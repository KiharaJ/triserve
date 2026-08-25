/**
 * Backfill the symptom tree + condition-map hotspots onto EXISTING
 * companies (SCMS proposal Module 1, §2 steps 3–4).
 *
 * prisma/seed.ts's SYMPTOM_TREE/CONDITION_ZONES (now in
 * prisma/intake-tree-data.ts) only reach a company through the seed
 * script's own upsert loop — and the seed script only runs against a
 * FRESH company or the test suite. It is never invoked automatically on
 * deploy (Render's startCommand is `prisma migrate deploy`, not the
 * seed), so an already-live company never picks up array changes here on
 * its own. This script closes that gap: same upsert logic as seed.ts's
 * main(), run against every company that already exists.
 *
 * Idempotent and non-destructive: upserts by the same natural keys seed.ts
 * uses (company_id+code for symptom nodes, company_id+category+code for
 * condition zones), so re-running it — or running it after the shop has
 * already added some of these by hand via Admin → Intake config — just
 * updates the ones that already match and creates whatever's still
 * missing. Nothing is ever deleted.
 *
 *   npm run backfill:intake-data -- [--dry] [--company <id>]
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { SYMPTOM_TREE, CONDITION_ZONES } from '../prisma/intake-tree-data';

const prisma = new PrismaClient();

const DRY = process.argv.includes('--dry');
const companyArgIdx = process.argv.indexOf('--company');
const COMPANY_ID =
  companyArgIdx !== -1 ? process.argv[companyArgIdx + 1] : undefined;

async function backfillCompany(companyId: string): Promise<void> {
  // Same derivation as seed.ts: depth and leaf-ness come from the array
  // itself, never hand-maintained, so they can never drift from the data.
  const symptomIdByCode = new Map<string, string>();
  let symptomsCreated = 0;
  let symptomsUpdated = 0;

  for (const n of SYMPTOM_TREE) {
    if (n.parent && !symptomIdByCode.has(n.parent)) {
      throw new Error(
        `symptom tree: '${n.code}' names parent '${n.parent}' before it is defined`,
      );
    }
    const parentId = n.parent ? (symptomIdByCode.get(n.parent) ?? null) : null;
    const level = n.parent
      ? SYMPTOM_TREE.find((x) => x.code === n.parent)?.parent
        ? 3
        : 2
      : 1;
    const isLeaf = !SYMPTOM_TREE.some((x) => x.parent === n.code);

    if (DRY) {
      const existing = await prisma.symptomNode.findFirst({
        where: { companyId, code: n.code },
        select: { id: true },
      });
      if (existing) symptomsUpdated++;
      else symptomsCreated++;
      // Fabricate an id so children can still resolve parentId in dry mode.
      symptomIdByCode.set(n.code, existing?.id ?? `dry:${n.code}`);
      continue;
    }

    const before = await prisma.symptomNode.findFirst({
      where: { companyId, code: n.code },
      select: { id: true },
    });
    const node = await prisma.symptomNode.upsert({
      where: { companyId_code: { companyId, code: n.code } },
      update: {
        label: n.label,
        parentId,
        level,
        isLeaf,
        category: n.category ?? null,
        estimateAmount: n.estimateTzs ?? null,
        estimateCurrency: n.estimateTzs ? 'TZS' : null,
        estimateMinutes: n.estimateMinutes ?? null,
        sortOrder: n.sortOrder,
        active: true,
        deletedAt: null,
      },
      create: {
        id: randomUUID(),
        companyId,
        code: n.code,
        label: n.label,
        parentId,
        level,
        isLeaf,
        category: n.category ?? null,
        estimateAmount: n.estimateTzs ?? null,
        estimateCurrency: n.estimateTzs ? 'TZS' : null,
        estimateMinutes: n.estimateMinutes ?? null,
        sortOrder: n.sortOrder,
      },
    });
    symptomIdByCode.set(node.code, node.id);
    if (before) symptomsUpdated++;
    else symptomsCreated++;
  }

  let zonesCreated = 0;
  let zonesUpdated = 0;
  for (const z of CONDITION_ZONES) {
    const before = await prisma.conditionZone.findFirst({
      where: { companyId, category: z.category, code: z.code },
      select: { id: true },
    });
    if (before) zonesUpdated++;
    else zonesCreated++;

    if (DRY) continue;

    await prisma.conditionZone.upsert({
      where: {
        companyId_category_code: {
          companyId,
          category: z.category,
          code: z.code,
        },
      },
      update: {
        label: z.label,
        x: new Prisma.Decimal(z.x),
        y: new Prisma.Decimal(z.y),
        face: z.face,
        sortOrder: z.sortOrder,
        active: true,
        deletedAt: null,
      },
      create: {
        id: randomUUID(),
        companyId,
        category: z.category,
        code: z.code,
        label: z.label,
        x: new Prisma.Decimal(z.x),
        y: new Prisma.Decimal(z.y),
        face: z.face,
        sortOrder: z.sortOrder,
      },
    });
  }

  console.log(
    `  symptom nodes:   ${symptomsCreated} new, ${symptomsUpdated} already present (of ${SYMPTOM_TREE.length})`,
  );
  console.log(
    `  condition zones: ${zonesCreated} new, ${zonesUpdated} already present (of ${CONDITION_ZONES.length})`,
  );
}

async function main(): Promise<void> {
  const companies = COMPANY_ID
    ? await prisma.company.findMany({ where: { id: COMPANY_ID } })
    : await prisma.company.findMany();

  if (companies.length === 0) {
    console.log('No matching company found.');
    return;
  }

  console.log(
    `${DRY ? '[DRY RUN] ' : ''}Backfilling intake data for ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}…`,
  );
  for (const company of companies) {
    console.log(`\n${company.name} (${company.id})`);
    await backfillCompany(company.id);
  }
  console.log(`\n${DRY ? '[DRY RUN] Nothing written.' : 'Done.'}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
