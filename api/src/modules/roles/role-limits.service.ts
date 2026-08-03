import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type RoleLimitType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * Role financial ceilings (SCMS proposal Module 5, §6 approval matrix).
 *
 *   Front Counter Agent — "Can accept standard invoice payments, cannot grant
 *                          discounts or adjust prices."
 *   Repair Technician   — "Authorized to request parts matching diagnostic
 *                          codes up to a $5 minor consumable variance."
 *   Floor Supervisor    — "Can approve out-of-warranty price adjustments up to
 *                          $200… Requires Center Manager approval for full
 *                          write-offs."
 *   Center Manager      — "Full authorization."
 *
 * A PERMISSION answers "may you do this at all"; a LIMIT answers "how far".
 * Both are needed: `discount.apply` without a ceiling means a front-desk agent
 * can zero an invoice, and a ceiling without the permission means a role that
 * cannot reach the screen has a meaningless number attached to it.
 *
 * THREE-STATE SEMANTICS, and the distinction matters:
 *
 *   no row              → DENY. The role has no authority for this action.
 *   row, enabled=false  → UNLIMITED. Explicit full authorisation.
 *   row, enabled=true   → bounded by max_amount and/or max_percent.
 *
 * "Missing" meaning deny is the safe default, but it is indistinguishable from
 * "nobody has configured this yet" — which is why the seed writes an explicit
 * zero-amount row for the front counter rather than leaving it absent, and why
 * {@link check} returns a REASON rather than a bare boolean.
 */

export interface RoleLimitWire {
  id: string;
  role: string;
  type: RoleLimitType;
  max_amount: string | null;
  currency: string | null;
  max_percent: string | null;
  enabled: boolean;
  /** Human summary for the roles screen ("up to USD 200.00"). */
  summary: string;
}

/** The verdict on one attempted action. */
export interface LimitCheck {
  allowed: boolean;
  /** Present when refused; safe to show the user. */
  reason?: string;
  /** True when a manager approval could authorise it anyway. */
  escalatable: boolean;
}

@Injectable()
export class RoleLimitsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /roles/limits — the whole matrix, for the admin screen. */
  async list(user: AuthUser): Promise<RoleLimitWire[]> {
    const rows = await this.prisma.roleLimit.findMany({
      where: { companyId: user.companyId },
      orderBy: [{ role: 'asc' }, { type: 'asc' }],
    });
    return rows.map(toWire);
  }

  /** PUT /roles/{role}/limits — upsert one ceiling. */
  async upsert(
    role: string,
    type: RoleLimitType,
    input: {
      max_amount?: string | null;
      currency?: string | null;
      max_percent?: string | null;
      enabled?: boolean;
    },
    user: AuthUser,
  ): Promise<RoleLimitWire> {
    const data = {
      maxAmount:
        input.max_amount === undefined || input.max_amount === null
          ? null
          : BigInt(input.max_amount),
      currency: input.currency ?? null,
      maxPercent:
        input.max_percent === undefined || input.max_percent === null
          ? null
          : new Prisma.Decimal(input.max_percent),
      enabled: input.enabled ?? true,
      updatedById: user.userId,
    };

    const row = await this.prisma.roleLimit.upsert({
      where: {
        companyId_role_type: { companyId: user.companyId, role, type },
      },
      update: data,
      create: {
        ...data,
        id: randomUUID(),
        companyId: user.companyId,
        role,
        type,
        createdById: user.userId,
      },
    });
    return toWire(row);
  }

  /** DELETE /roles/{role}/limits/{type} — remove a ceiling (reverts to DENY). */
  async remove(
    role: string,
    type: RoleLimitType,
    user: AuthUser,
  ): Promise<{ role: string; type: RoleLimitType }> {
    const { count } = await this.prisma.roleLimit.deleteMany({
      where: { companyId: user.companyId, role, type },
    });
    if (count === 0) throw new NotFoundException('Role limit not found');
    return { role, type };
  }

  /**
   * May this user perform an action of `type` at this size?
   *
   * `amount` is minor units of `currency`; `percent` is a share of the
   * document total. Both are optional — a discount may be expressed either
   * way, and BOTH ceilings must hold when both are supplied and configured.
   *
   * SUPER_ADMIN passes unconditionally, matching how the permission resolver
   * treats it: a tenant must never be able to lock its own administrator out.
   */
  async check(
    user: AuthUser,
    type: RoleLimitType,
    value: { amount?: bigint; percent?: number; currency?: string },
  ): Promise<LimitCheck> {
    if (user.role === 'SUPER_ADMIN') {
      return { allowed: true, escalatable: false };
    }

    const limit = await this.prisma.roleLimit.findFirst({
      where: { companyId: user.companyId, role: user.role, type },
    });

    if (!limit) {
      return {
        allowed: false,
        escalatable: true,
        reason: `Your role is not authorised to ${ACTION_VERB[type]}. Ask a manager to approve it.`,
      };
    }
    if (!limit.enabled) return { allowed: true, escalatable: false };

    if (limit.maxAmount !== null && value.amount !== undefined) {
      // Comparing across currencies would silently compare shillings to
      // dollars — a 200-unit ceiling would then wave through TZS 200 as if it
      // were USD 200, or block a legitimate TZS amount. Refusing is the honest
      // answer; converting would need an FX rate this check has no business
      // choosing.
      if (
        limit.currency &&
        value.currency &&
        limit.currency !== value.currency
      ) {
        return {
          allowed: false,
          escalatable: true,
          reason:
            `Your ${ACTION_VERB[type]} limit is set in ${limit.currency} but this is in ` +
            `${value.currency}. A manager must approve it, or the limit needs restating in ${value.currency}.`,
        };
      }
      if (value.amount > limit.maxAmount) {
        return {
          allowed: false,
          escalatable: true,
          reason: `That exceeds your limit of ${formatMinor(limit.maxAmount, limit.currency)}. A manager must approve it.`,
        };
      }
    }

    if (limit.maxPercent !== null && value.percent !== undefined) {
      if (new Prisma.Decimal(value.percent).gt(limit.maxPercent)) {
        return {
          allowed: false,
          escalatable: true,
          reason: `That exceeds your limit of ${limit.maxPercent.toString()}%. A manager must approve it.`,
        };
      }
    }

    return { allowed: true, escalatable: false };
  }

  /**
   * The caller's OWN ceilings, so the UI can pre-empt a refusal — grey the
   * discount field out rather than let someone type a number and be told no.
   */
  async forCurrentUser(user: AuthUser): Promise<RoleLimitWire[]> {
    if (user.role === 'SUPER_ADMIN') return [];
    const rows = await this.prisma.roleLimit.findMany({
      where: { companyId: user.companyId, role: user.role },
      orderBy: { type: 'asc' },
    });
    return rows.map(toWire);
  }
}

/** Reads naturally inside "Your role is not authorised to …". */
const ACTION_VERB: Record<RoleLimitType, string> = {
  DISCOUNT: 'grant discounts',
  PRICE_ADJUSTMENT: 'adjust prices',
  PARTS_VARIANCE: 'commit parts beyond the diagnosis',
  WRITE_OFF: 'write off charges',
  REFUND: 'issue refunds',
};

/** Minor units → a readable amount. Integer arithmetic; no float round-trip. */
function formatMinor(amount: bigint, currency: string | null): string {
  const whole = amount / 100n;
  const cents = amount % 100n;
  return `${currency ?? ''} ${whole}.${cents.toString().padStart(2, '0')}`.trim();
}

function toWire(l: {
  id: string;
  role: string;
  type: RoleLimitType;
  maxAmount: bigint | null;
  currency: string | null;
  maxPercent: Prisma.Decimal | null;
  enabled: boolean;
}): RoleLimitWire {
  const parts: string[] = [];
  if (!l.enabled) {
    parts.push('No limit');
  } else {
    if (l.maxAmount !== null) {
      parts.push(
        l.maxAmount === 0n
          ? 'Not permitted'
          : `up to ${formatMinor(l.maxAmount, l.currency)}`,
      );
    }
    if (l.maxPercent !== null) parts.push(`up to ${l.maxPercent.toString()}%`);
    if (parts.length === 0) parts.push('No limit set');
  }

  return {
    id: l.id,
    role: l.role,
    type: l.type,
    max_amount: l.maxAmount?.toString() ?? null,
    currency: l.currency,
    max_percent: l.maxPercent?.toString() ?? null,
    enabled: l.enabled,
    summary: parts.join(', '),
  };
}
