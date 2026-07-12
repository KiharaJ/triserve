import { Injectable } from '@nestjs/common';
import { Prisma, type PaymentMethodType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JournalService } from './journal.service';

/** What a payment needs to post its Dr Cash/Bank / Cr Revenue (+ VAT) entry. */
export interface PostPaymentInput {
  companyId: string;
  branchId: string;
  postedById: string;
  invoiceNo: string;
  invoiceTotal: bigint;
  invoiceTax: bigint;
  currency: string;
  method: PaymentMethodType;
  amount: bigint;
  paymentId: string;
}

/** Cash-family payment methods → the cash account; the rest → bank. */
const CASH_METHODS = new Set<PaymentMethodType>(['CASH']);
const CASH_CODE = '1000';
const BANK_CODE = '1010';
const REVENUE_CODE = '4000'; // Repair/sales revenue (default; per-type later)
const VAT_CODE = '2100';

/**
 * Automatic accounting posting (Task 3.3, DESIGN.md §4.9 / E1). Switches on the
 * double-entry side-effects of operational events — the ledger becomes live.
 * Every method resolves the chart of accounts by well-known code and posts a
 * balanced entry through JournalService.post INSIDE the caller's transaction,
 * so the operational row and its journal commit or roll back together.
 *
 * RESILIENT BY DESIGN: if the required accounts aren't configured for a company
 * (no seeded chart), posting is skipped rather than failing the operation — a
 * company can run POS before its books are set up, and backfill later.
 *
 * Task 3.3 covers PAYMENT posting (all in the invoice currency — clean, no fx).
 * GRN (Dr Inventory / Cr AP) and part-consumption COGS (Dr COGS / Cr Inventory)
 * post in the parts' cost currency (USD); consolidating them into a TZS ledger
 * needs fx rates (Phase 5 / open question §14.11), so they are deferred.
 */
@Injectable()
export class PostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
  ) {}

  /**
   * Post a customer payment: Dr Cash|Bank (amount) / Cr Revenue (net) [/ Cr VAT
   * Payable (the payment's proportional VAT share)]. Single-currency (the
   * invoice's), so it always balances without fx.
   */
  async postPayment(
    input: PostPaymentInput,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const cashCode = CASH_METHODS.has(input.method) ? CASH_CODE : BANK_CODE;
    const accounts = await this.resolveAccounts(input.companyId, [
      cashCode,
      REVENUE_CODE,
      VAT_CODE,
    ]);
    const cashId = accounts.get(cashCode);
    const revenueId = accounts.get(REVENUE_CODE);
    if (!cashId || !revenueId) return; // books not set up — skip, don't fail

    const vatId = accounts.get(VAT_CODE);
    // VAT recognised proportionally to this payment's share of the invoice.
    const vatPortion =
      vatId && input.invoiceTax > 0n && input.invoiceTotal > 0n
        ? (input.amount * input.invoiceTax) / input.invoiceTotal
        : 0n;
    const revenuePortion = input.amount - vatPortion;

    const lines = [
      { accountId: cashId, debit: input.amount, currency: input.currency },
      {
        accountId: revenueId,
        credit: revenuePortion,
        currency: input.currency,
      },
      ...(vatPortion > 0n && vatId
        ? [{ accountId: vatId, credit: vatPortion, currency: input.currency }]
        : []),
    ];

    await this.journal.post(
      {
        companyId: input.companyId,
        branchId: input.branchId,
        postedById: input.postedById,
        entryDate: today(),
        sourceType: 'PAYMENT',
        sourceId: input.paymentId,
        memo: `Payment for ${input.invoiceNo} (${input.method})`,
        lines,
      },
      tx,
    );
  }

  /** Resolve active accounts of a company by code → id. */
  private async resolveAccounts(
    companyId: string,
    codes: string[],
  ): Promise<Map<string, string>> {
    const rows = await this.prisma.chartOfAccount.findMany({
      where: { companyId, code: { in: codes }, isActive: true },
      select: { id: true, code: true },
    });
    return new Map(rows.map((a) => [a.code, a.id]));
  }
}

/** Today as a YYYY-MM-DD string (entry date). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
