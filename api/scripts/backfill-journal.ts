/**
 * Backfill the double-entry ledger from historical payments (Phase 5 reports).
 *
 * The history importer wrote payments directly (bulk), bypassing the automatic
 * posting that live payments get (Task 3.3). This posts a balanced journal
 * entry for every payment that doesn't yet have one — Dr Cash|Bank / Cr Revenue
 * [/ Cr VAT] in the payment's currency — so the Trial Balance and P&L reflect
 * the real revenue. Idempotent: a payment that already has a PAYMENT entry is
 * skipped, so it is safe to re-run.
 *
 *   npm run backfill:journal -- [--dry]
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

const CASH_CODE = '1000';
const BANK_CODE = '1010';
const REVENUE_CODE = '4000';
const VAT_CODE = '2100';

async function main(): Promise<void> {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  let posted = 0;
  let skipped = 0;

  for (const company of companies) {
    const accounts = new Map(
      (
        await prisma.chartOfAccount.findMany({
          where: {
            companyId: company.id,
            code: { in: [CASH_CODE, BANK_CODE, REVENUE_CODE, VAT_CODE] },
            isActive: true,
          },
          select: { id: true, code: true },
        })
      ).map((a) => [a.code, a.id]),
    );
    const cashId = accounts.get(CASH_CODE);
    const bankId = accounts.get(BANK_CODE);
    const revenueId = accounts.get(REVENUE_CODE);
    const vatId = accounts.get(VAT_CODE);
    if (!revenueId || (!cashId && !bankId)) continue; // books not set up

    // payment ids that already have a PAYMENT journal entry.
    const already = new Set(
      (
        await prisma.journalEntry.findMany({
          where: { companyId: company.id, sourceType: 'PAYMENT' },
          select: { sourceId: true },
        })
      ).map((e) => e.sourceId),
    );

    const payments = await prisma.payment.findMany({
      where: { companyId: company.id },
      include: {
        invoice: { select: { invoiceNo: true, tax: true, total: true } },
      },
    });

    for (const p of payments) {
      if (already.has(p.id)) {
        skipped++;
        continue;
      }
      const debitAccount = p.method === 'CASH' ? cashId : bankId;
      if (!debitAccount) {
        skipped++;
        continue;
      }
      const inv = p.invoice;
      const vatPortion =
        vatId && inv && inv.tax > 0n && inv.total > 0n
          ? (p.amount * inv.tax) / inv.total
          : 0n;
      const revenuePortion = p.amount - vatPortion;

      if (DRY) {
        posted++;
        continue;
      }

      await prisma.journalEntry.create({
        data: {
          id: randomUUID(),
          companyId: company.id,
          branchId: p.branchId,
          entryDate: p.paidAt,
          sourceType: 'PAYMENT',
          sourceId: p.id,
          memo: `Payment for ${inv?.invoiceNo ?? '?'} (${p.method})`,
          postedById: p.receivedById,
          createdAt: p.paidAt,
          lines: {
            create: [
              { accountId: debitAccount, debit: p.amount, currency: p.currency },
              { accountId: revenueId, credit: revenuePortion, currency: p.currency },
              ...(vatPortion > 0n && vatId
                ? [{ accountId: vatId, credit: vatPortion, currency: p.currency }]
                : []),
            ],
          },
        },
      });
      posted++;
    }
    console.log(`  ${company.name}: ${payments.length} payments seen`);
  }

  console.log('─'.repeat(48));
  console.log(`${DRY ? 'would post' : 'posted'}: ${posted} | skipped: ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
