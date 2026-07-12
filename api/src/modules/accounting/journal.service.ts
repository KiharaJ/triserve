import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type JournalEntry,
  type JournalLine,
  type JournalSourceType,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { getCurrentUser } from '../../common/context/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import {
  ApprovalsService,
  type ApprovalEntry,
} from '../approvals/approvals.service';
import type {
  CreateManualJournalDto,
  JournalEntryListQueryDto,
} from './dto/accounting.dto';

/** Wire shape of one journal line (snake_case; money as strings). */
export interface JournalLineWire {
  id: string;
  entry_id: string;
  account_id: string;
  debit: string;
  credit: string;
  currency: string;
}

/** Wire shape of one journal entry with its lines. */
export interface JournalEntryWire {
  id: string;
  company_id: string;
  branch_id: string | null;
  entry_date: string; // YYYY-MM-DD
  source_type: JournalSourceType;
  source_id: string | null;
  memo: string | null;
  posted_by: string;
  created_at: string;
  lines: JournalLineWire[];
}

/** One line as accepted by {@link JournalService.post}. */
export interface JournalLineInput {
  accountId: string;
  debit?: bigint | number | string | null;
  credit?: bigint | number | string | null;
  currency: string;
}

/** Input to {@link JournalService.post} — THE only way entries are created. */
export interface PostJournalEntryInput {
  /** Pre-allocated id (used by the approval-claim protocol); default uuid. */
  id?: string;
  /** Defaults to the request-context user's company; REQUIRED outside one. */
  companyId?: string;
  branchId?: string | null;
  entryDate: string; // YYYY-MM-DD
  sourceType: JournalSourceType;
  /** The operational row that produced the entry (approval id for MANUAL). */
  sourceId?: string | null;
  memo?: string | null;
  /** Defaults to the request-context user; REQUIRED outside one. */
  postedById?: string;
  lines: JournalLineInput[];
}

/** Validated, normalized line (money as bigint minor units). */
export interface NormalizedJournalLine {
  accountId: string;
  debit: bigint;
  credit: bigint;
  currency: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE_SIZE = 20;

function parseMoney(
  value: bigint | number | string | null | undefined,
): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  const v = typeof value === 'string' ? value.trim() : value;
  if (typeof v === 'number' && !Number.isInteger(v)) {
    throw new UnprocessableEntityException(
      'Money must be integer minor units (no decimals)',
    );
  }
  let parsed: bigint;
  try {
    parsed = BigInt(v);
  } catch {
    throw new UnprocessableEntityException(
      `Invalid money amount: ${String(v)}`,
    );
  }
  if (parsed < 0n) {
    throw new UnprocessableEntityException('Money amounts must be >= 0');
  }
  return parsed;
}

/**
 * PURE validation of the double-entry invariants (unit-testable without a
 * DB). Throws 422 with details unless:
 *   - there are at least 2 lines;
 *   - every line has EXACTLY ONE of debit/credit > 0 (never both, never
 *     neither);
 *   - all lines share one currency (single-currency entries for now —
 *     multi-currency waits for fx handling in later phases);
 *   - SUM(debit) == SUM(credit) and the totals are > 0.
 */
export function normalizeJournalLines(
  lines: JournalLineInput[],
): NormalizedJournalLine[] {
  const problems: string[] = [];
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new UnprocessableEntityException({
      message: 'A journal entry needs at least 2 lines',
    });
  }

  const normalized = lines.map((line, i) => {
    const debit = parseMoney(line.debit);
    const credit = parseMoney(line.credit);
    if (debit > 0n === credit > 0n) {
      problems.push(
        `line ${i + 1}: exactly one of debit/credit must be > 0 ` +
          `(got debit=${debit}, credit=${credit})`,
      );
    }
    const currency = (line.currency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      problems.push(`line ${i + 1}: currency must be a 3-letter ISO code`);
    }
    return { accountId: line.accountId, debit, credit, currency };
  });

  const currencies = new Set(normalized.map((l) => l.currency));
  if (currencies.size > 1) {
    problems.push(
      `all lines must share one currency (got ${[...currencies].join(', ')})`,
    );
  }

  const totalDebit = normalized.reduce((s, l) => s + l.debit, 0n);
  const totalCredit = normalized.reduce((s, l) => s + l.credit, 0n);
  if (totalDebit !== totalCredit) {
    problems.push(
      `entry is not balanced: SUM(debit)=${totalDebit} != SUM(credit)=${totalCredit}`,
    );
  } else if (totalDebit === 0n) {
    problems.push('entry total must be > 0');
  }

  if (problems.length > 0) {
    throw new UnprocessableEntityException({
      message: 'Journal entry rejected: double-entry rules violated',
      details: problems,
    });
  }
  return normalized;
}

/** YYYY-MM-DD string → Date at UTC midnight; rejects impossible dates. */
function parseEntryDate(value: string): Date {
  if (!DATE_ONLY.test(value)) {
    throw new UnprocessableEntityException(
      'entry_date must be a YYYY-MM-DD date',
    );
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new UnprocessableEntityException(`Invalid entry_date: ${value}`);
  }
  return date;
}

/**
 * Double-entry journal service (Task 0.6, DESIGN.md §4.9 / E1).
 *
 * `post()` is the ONE AND ONLY path that writes journal_entries +
 * journal_lines — Phase 3's automatic posting (payments, GRNs, warranty,
 * COGS) will call it too, so the balance invariant can never be bypassed.
 *
 * MANUAL JOURNAL FLOW (approval-gated, §4.9 "never edited by hand except
 * through explicit, approval-gated manual journals" + §4.11):
 *
 *   1. POST /journal-entries → {@link proposeManual}: the payload is FULLY
 *      validated up front (balance, line rules, accounts, branch) and then
 *      parked as a PENDING approval of type MANUAL_JOURNAL via
 *      ApprovalsService.request(), payload_json carrying the whole entry.
 *      NO ledger rows are written. Returns 202 + the pending approval.
 *   2. A manager decides it through the generic approvals endpoints
 *      (POST /approvals/{id}/approve — Task 0.5). Still no ledger rows.
 *   3. POST /journal-entries/{approvalId}/post → {@link postApproved}: only
 *      once the approval is APPROVED, the stored payload is re-validated
 *      and posted via post(). The approval's ref_id is atomically claimed
 *      with the new entry id BEFORE posting (update .. WHERE ref_id IS
 *      NULL), so an approval can never be posted twice; the posted entry
 *      records source_id = approval id for two-way provenance.
 *
 * Manual journals are ALWAYS gated — approval_rules thresholds are not
 * consulted for MANUAL_JOURNAL (the design treats every hand-written ledger
 * mutation as sensitive, whatever its size).
 */
@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * Validate + write one balanced journal entry WITH its lines atomically.
   *
   * The write is a single nested `journalEntry.create` — entry + lines are
   * one statement-tree inside one transaction (the audit extension wraps it
   * together with its audit CREATE row). Rejects (422) unbalanced entries,
   * bad lines, mixed currencies; (400) unknown/inactive accounts or foreign
   * branches. Nothing is written on rejection.
   */
  async post(
    input: PostJournalEntryInput,
    tx?: Prisma.TransactionClient,
  ): Promise<JournalEntryWire> {
    const user = getCurrentUser();
    const companyId = user?.companyId ?? input.companyId;
    const postedById = input.postedById ?? user?.userId;
    if (!companyId || !postedById) {
      throw new UnauthorizedException(
        'JournalService.post requires a request context or explicit companyId + postedById',
      );
    }

    const entryDate = parseEntryDate(input.entryDate);
    const lines = normalizeJournalLines(input.lines);

    // Referential checks against THIS company (defense in depth on top of
    // the company-scope extension): accounts must exist, belong to the
    // company and be active; the branch (if any) must be the company's.
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await this.prisma.chartOfAccount.findMany({
      where: { id: { in: accountIds }, companyId },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const missing = accountIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown account(s) for this company: ${missing.join(', ')}`,
      );
    }
    const inactive = accounts.filter((a) => !a.isActive).map((a) => a.code);
    if (inactive.length > 0) {
      throw new BadRequestException(
        `Inactive account(s) cannot be posted to: ${inactive.join(', ')}`,
      );
    }
    if (input.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: input.branchId, companyId },
      });
      if (!branch) {
        throw new BadRequestException('Unknown branch for this company');
      }
    }

    const entryId = input.id ?? randomUUID();

    // AUTOMATIC-POSTING PATH (Task 3.3): when a caller transaction is passed
    // (payment/GRN/… posting inside its own txn), write entry + lines via raw
    // SQL on that txn. This bypasses the audit Prisma extension — which would
    // otherwise open its OWN nested transaction for the audited JournalEntry
    // create and escape the caller's txn (a documented limitation). Auto-posted
    // entries are immutable and source-linked (source_type/source_id), so the
    // entry itself IS the record; no separate audit row is needed. Validation
    // above (balance, accounts, branch) is identical to the manual path.
    if (tx) {
      await tx.$executeRaw`
        INSERT INTO journal_entries
          (id, company_id, branch_id, entry_date, source_type, source_id, memo,
           posted_by, created_at, updated_at)
        VALUES
          (${entryId}, ${companyId}, ${input.branchId ?? null}, ${entryDate},
           ${input.sourceType}, ${input.sourceId ?? null}, ${input.memo ?? null},
           ${postedById}, NOW(3), NOW(3))`;
      for (const l of lines) {
        await tx.$executeRaw`
          INSERT INTO journal_lines
            (id, entry_id, account_id, debit, credit, currency, created_at, updated_at)
          VALUES
            (${randomUUID()}, ${entryId}, ${l.accountId}, ${l.debit}, ${l.credit},
             ${l.currency}, NOW(3), NOW(3))`;
      }
      const posted = await tx.journalEntry.findUniqueOrThrow({
        where: { id: entryId },
        include: { lines: true },
      });
      return toWire(posted);
    }

    // MANUAL PATH: ONE nested create = ONE transaction for entry + lines (+
    // audit row, via the audit extension which wraps this create).
    const entry = await this.prisma.journalEntry.create({
      data: {
        id: entryId,
        companyId,
        branchId: input.branchId ?? null,
        entryDate,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        memo: input.memo ?? null,
        postedById,
        lines: {
          create: lines.map((l) => ({
            id: randomUUID(),
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            currency: l.currency,
          })),
        },
      },
      include: { lines: true },
    });

    return toWire(entry);
  }

  /**
   * Step 1 of the manual-journal flow: validate the proposed entry fully
   * (nothing reaches the approval queue unless it COULD post), then create
   * the PENDING MANUAL_JOURNAL approval carrying the entry as payload_json.
   * The approval is routed to the entry's branch when given, else the
   * requester's home branch, else the company HQ (approvals require a
   * branch for routing; the ENTRY itself keeps branch_id = null).
   */
  async proposeManual(
    dto: CreateManualJournalDto,
    user: AuthUser,
  ): Promise<ApprovalEntry> {
    // Full up-front validation — 422/400 BEFORE any approval is created.
    parseEntryDate(dto.entry_date);
    const lines = normalizeJournalLines(
      dto.lines.map((l) => ({
        accountId: l.account_id,
        debit: l.debit,
        credit: l.credit,
        currency: l.currency,
      })),
    );
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await this.prisma.chartOfAccount.findMany({
      where: { id: { in: accountIds }, companyId: user.companyId },
    });
    if (accounts.length !== accountIds.length) {
      throw new BadRequestException('Unknown account(s) for this company');
    }
    const inactive = accounts.filter((a) => !a.isActive).map((a) => a.code);
    if (inactive.length > 0) {
      throw new BadRequestException(
        `Inactive account(s) cannot be posted to: ${inactive.join(', ')}`,
      );
    }
    if (dto.branch_id) {
      assertBranchAccess(user, dto.branch_id);
    }

    const approvalBranchId =
      dto.branch_id ?? user.homeBranchId ?? (await this.hqBranchId(user));

    return this.approvals.request('MANUAL_JOURNAL', {
      branchId: approvalBranchId,
      refType: 'JournalEntry',
      refId: null, // backfilled with the entry id on post (claim protocol)
      payload: {
        branch_id: dto.branch_id ?? null,
        entry_date: dto.entry_date,
        memo: dto.memo ?? null,
        lines: lines.map((l) => ({
          account_id: l.accountId,
          debit: l.debit.toString(),
          credit: l.credit.toString(),
          currency: l.currency,
        })),
      },
      reason: dto.reason,
    });
  }

  /**
   * Step 3 of the manual-journal flow: post an APPROVED MANUAL_JOURNAL
   * approval's payload to the ledger.
   *
   * Refuses: 404 unknown/foreign approval, 400 wrong type, 409 not (yet)
   * approved or already posted. Double-post safety: the approval's ref_id
   * is claimed with a pre-allocated entry id via a conditional UPDATE
   * (WHERE ref_id IS NULL) BEFORE posting — a concurrent second post loses
   * the claim and gets 409. If posting then fails, the claim is released so
   * the approval can be retried.
   */
  async postApproved(
    approvalId: string,
    user: AuthUser,
  ): Promise<JournalEntryWire> {
    // Company-scope extension pins this read to the caller's tenant.
    const approval = await this.prisma.approval.findFirst({
      where: { id: approvalId },
    });
    if (!approval) {
      throw new NotFoundException('Approval not found');
    }
    if (approval.type !== 'MANUAL_JOURNAL') {
      throw new BadRequestException(
        `Approval ${approvalId} is not a MANUAL_JOURNAL approval`,
      );
    }
    assertBranchAccess(user, approval.branchId);
    if (approval.status === 'PENDING') {
      throw new ConflictException(
        'Approval is still PENDING — a manager must approve it first',
      );
    }
    if (approval.status === 'REJECTED') {
      throw new ConflictException('Approval was REJECTED — cannot post');
    }
    if (approval.refId) {
      throw new ConflictException(
        `Already posted as journal entry ${approval.refId}`,
      );
    }

    const payload = parseManualPayload(approval.payloadJson);

    // Claim the approval for this entry id BEFORE writing the ledger row —
    // the conditional WHERE closes the double-post race (P2025 = lost it).
    const entryId = randomUUID();
    try {
      await this.prisma.approval.update({
        where: { id: approvalId, status: 'APPROVED', refId: null },
        data: { refType: 'JournalEntry', refId: entryId },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new ConflictException('Approval already posted');
      }
      throw e;
    }

    try {
      return await this.post({
        id: entryId,
        companyId: approval.companyId,
        branchId: payload.branchId,
        entryDate: payload.entryDate,
        sourceType: 'MANUAL',
        sourceId: approval.id, // provenance: entry → gating approval
        memo: payload.memo,
        postedById: user.userId,
        lines: payload.lines,
      });
    } catch (e) {
      // Release the claim so a fixable failure can be retried.
      await this.prisma.approval
        .update({
          where: { id: approvalId, refId: entryId },
          data: { refId: null },
        })
        .catch(() => undefined);
      throw e;
    }
  }

  /** Company-scoped, filtered, paginated entries WITH lines (newest first). */
  async list(
    query: JournalEntryListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<JournalEntryWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const entryDate =
      query.from || query.to
        ? {
            ...(query.from ? { gte: parseEntryDate(query.from) } : {}),
            ...(query.to ? { lte: parseEntryDate(query.to) } : {}),
          }
        : undefined;

    // companyId explicit AND re-tightened by the scope extension.
    const where: Prisma.JournalEntryWhereInput = {
      companyId: user.companyId,
      ...(query.source_type ? { sourceType: query.source_type } : {}),
      ...(entryDate ? { entryDate } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.journalEntry.count({ where }),
      this.prisma.journalEntry.findMany({
        where,
        include: { lines: true },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** Approval routing fallback for company-level entries: the HQ branch. */
  private async hqBranchId(user: AuthUser): Promise<string> {
    const hq = await this.prisma.branch.findFirst({
      where: { companyId: user.companyId, isHq: true },
      orderBy: { code: 'asc' },
    });
    const branch =
      hq ??
      (await this.prisma.branch.findFirst({
        where: { companyId: user.companyId },
        orderBy: { code: 'asc' },
      }));
    if (!branch) {
      throw new BadRequestException(
        'Company has no branch to route the approval to',
      );
    }
    return branch.id;
  }
}

/** Parsed manual-journal approval payload (defensive: payloads may have
 *  been written through the generic POST /approvals endpoint). */
interface ManualPayload {
  branchId: string | null;
  entryDate: string;
  memo: string | null;
  lines: JournalLineInput[];
}

function parseManualPayload(payloadJson: Prisma.JsonValue): ManualPayload {
  const p = payloadJson as {
    branch_id?: unknown;
    entry_date?: unknown;
    memo?: unknown;
    lines?: unknown;
  } | null;
  if (
    !p ||
    typeof p !== 'object' ||
    typeof p.entry_date !== 'string' ||
    !Array.isArray(p.lines)
  ) {
    throw new UnprocessableEntityException(
      'Approval payload is not a valid journal entry — re-propose it via POST /journal-entries',
    );
  }
  return {
    branchId: typeof p.branch_id === 'string' ? p.branch_id : null,
    entryDate: p.entry_date,
    memo: typeof p.memo === 'string' ? p.memo : null,
    lines: p.lines.map((raw) => {
      const l = raw as Record<string, unknown>;
      return {
        accountId: typeof l.account_id === 'string' ? l.account_id : '',
        debit: l.debit as string | number | null | undefined,
        credit: l.credit as string | number | null | undefined,
        currency: typeof l.currency === 'string' ? l.currency : '',
      };
    }),
  };
}

function toWire(
  entry: JournalEntry & { lines: JournalLine[] },
): JournalEntryWire {
  return {
    id: entry.id,
    company_id: entry.companyId,
    branch_id: entry.branchId,
    entry_date: entry.entryDate.toISOString().slice(0, 10),
    source_type: entry.sourceType,
    source_id: entry.sourceId,
    memo: entry.memo,
    posted_by: entry.postedById,
    created_at: entry.createdAt.toISOString(),
    lines: entry.lines.map((l) => ({
      id: l.id,
      entry_id: l.entryId,
      account_id: l.accountId,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      currency: l.currency,
    })),
  };
}
