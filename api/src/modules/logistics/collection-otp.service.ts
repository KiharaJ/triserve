import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { JobsService } from '../jobs/jobs.service';

/**
 * The secure OTP handshake (SCMS proposal Module 6, §7 steps 1 & 4).
 *
 * "When a job transitions to READY_FOR_COLLECTION, the system generates a
 * secure, randomized, single-use 6-digit One-Time PIN (OTP) sent directly to
 * the customer's registered mobile number via SMS… The system blocks the agent
 * from selecting 'Delivered' until the entered PIN matches."
 *
 * THREE properties this implementation takes seriously:
 *
 *  1. The PIN is never stored. Only a SHA-256 hash, exactly like refresh
 *     tokens in `sessions`. A counter agent with database access must not be
 *     able to read the code that authorises a handover — that would defeat the
 *     entire control. `code_hint` (the last two digits) exists so staff can
 *     help a customer who says "…ends in 47" without ever seeing the whole
 *     code.
 *
 *  2. Generated with `crypto.randomInt`, not `Math.random`. A predictable
 *     collection code is a way to walk out with someone else's phone.
 *
 *  3. Attempts are capped and the code expires. Six digits is a million
 *     possibilities, which sounds ample until you notice nothing stops someone
 *     trying all of them at a counter terminal. The cap (default 5) turns a
 *     brute force into a burned code and a fresh SMS.
 *
 * Re-issuing SUPERSEDES rather than mutates, so the dispatch trail shows every
 * PIN ever sent for a job.
 */

export interface CollectionOtpWire {
  id: string;
  job_id: string;
  /** Last two digits only — see the note above. */
  code_hint: string;
  sent_to: string | null;
  sent_at: string | null;
  expires_at: string;
  attempts: number;
  attempts_remaining: number;
  verified_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  /** Derived: this PIN is the live one and can still be verified. */
  active: boolean;
}

@Injectable()
export class CollectionOtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Issue a PIN and queue the SMS. Any previous live PIN for the job is voided
   * first — two valid codes for one handover is one code too many.
   *
   * Called automatically when a job reaches READY (see
   * {@link issueOnReady}) and manually when the customer never received the
   * first message.
   */
  async issue(
    jobId: string,
    sendTo: string | null,
    user: AuthUser,
  ): Promise<CollectionOtpWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    if (job.state.isTerminal) {
      throw new UnprocessableEntityException(
        'This job is already closed — there is nothing left to collect',
      );
    }

    const row = await this.mint(
      {
        id: job.id,
        companyId: job.companyId,
        branchId: job.branchId,
      },
      sendTo,
      user.userId,
    );

    await this.audit.record({
      entityType: 'Job',
      entityId: jobId,
      action: 'UPDATE',
      before: null,
      after: { collection_otp_issued: true, sent_to: row.sentTo },
      companyId: job.companyId,
      branchId: job.branchId,
      actorUserId: user.userId,
    });

    return toWire(row);
  }

  /**
   * Issue automatically when a job reaches READY, with no acting user (the
   * transition's actor is recorded on the job, not on the PIN). Swallows its
   * own errors: the job HAS reached READY and that must stand even if the
   * customer has no phone number on file — the counter can then issue one
   * manually, or the manager overrides the dispatch guard.
   */
  async issueOnReady(job: {
    id: string;
    companyId: string;
    branchId: string;
  }): Promise<void> {
    try {
      await this.mint(job, null, null);
    } catch {
      // Intentionally silent — see the doc comment. The dispatch guard will
      // still refuse a handover without a verified PIN, so nothing is
      // weakened by this failing quietly.
    }
  }

  /**
   * POST /jobs/{id}/collection-otp/verify — the counter checks the customer's
   * code before releasing the device.
   *
   * A wrong code increments `attempts`; hitting the cap VOIDS the PIN, so a
   * guesser has to get staff to send a new one rather than keep trying.
   */
  async verify(
    jobId: string,
    code: string,
    user: AuthUser,
  ): Promise<CollectionOtpWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);

    const latest = await this.prisma.jobCollectionOtp.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      throw new UnprocessableEntityException(
        'No collection PIN has been issued for this job',
      );
    }
    if (latest.verifiedAt) return toWire(latest); // Idempotent.
    if (latest.voidedAt) {
      throw new ConflictException(
        `That PIN is no longer valid (${latest.voidReason ?? 'voided'}) — issue a new one`,
      );
    }
    if (latest.expiresAt.getTime() < Date.now()) {
      await this.prisma.jobCollectionOtp.update({
        where: { id: latest.id },
        data: { voidedAt: new Date(), voidReason: 'Expired' },
      });
      throw new ConflictException(
        'That PIN has expired — issue a new one for the customer',
      );
    }

    const company = await this.prisma.company.findFirstOrThrow({
      where: { id: job.companyId },
      select: { otpMaxAttempts: true },
    });

    if (hash(code) !== latest.codeHash) {
      const attempts = latest.attempts + 1;
      const burned = attempts >= company.otpMaxAttempts;
      await this.prisma.jobCollectionOtp.update({
        where: { id: latest.id },
        data: {
          attempts,
          ...(burned
            ? { voidedAt: new Date(), voidReason: 'Too many failed attempts' }
            : {}),
        },
      });
      throw new UnprocessableEntityException(
        burned
          ? 'Too many incorrect attempts — that PIN has been cancelled. Issue a new one.'
          : `Incorrect PIN. ${company.otpMaxAttempts - attempts} attempt(s) remaining.`,
      );
    }

    const verified = await this.prisma.jobCollectionOtp.update({
      where: { id: latest.id },
      data: {
        verifiedAt: new Date(),
        verifiedById: user.userId,
        attempts: latest.attempts + 1,
      },
    });

    await this.audit.record({
      entityType: 'Job',
      entityId: jobId,
      action: 'UPDATE',
      before: null,
      after: { collection_otp_verified: true, otp_id: verified.id },
      companyId: job.companyId,
      branchId: job.branchId,
      actorUserId: user.userId,
    });

    return toWire(verified);
  }

  /** GET /jobs/{id}/collection-otp — the PIN's state (never the code). */
  async status(
    jobId: string,
    user: AuthUser,
  ): Promise<CollectionOtpWire | null> {
    await this.jobs.loadAccessibleJob(jobId, user);
    const latest = await this.prisma.jobCollectionOtp.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    });
    return latest ? toWire(latest) : null;
  }

  // ------------------------------------------------------------- internals

  /**
   * Mint a PIN, void any predecessor, and queue the SMS — all in one
   * transaction so a job can never end up with two live codes, or a code the
   * customer was never sent.
   */
  private async mint(
    job: { id: string; companyId: string; branchId: string },
    sendTo: string | null,
    actorUserId: string | null,
  ) {
    const detail = await this.prisma.job.findFirstOrThrow({
      where: { id: job.id },
      select: {
        jobNo: true,
        customerId: true,
        customer: {
          select: {
            name: true,
            phoneNormalized: true,
            phone: true,
            email: true,
            preferredLanguage: true,
          },
        },
        branch: { select: { name: true } },
        company: {
          select: { name: true, otpTtlMinutes: true },
        },
      },
    });

    const to =
      sendTo ?? detail.customer.phoneNormalized ?? detail.customer.phone;
    if (!to) {
      throw new UnprocessableEntityException(
        'This customer has no phone number on file — record one, or send the PIN to an alternative number',
      );
    }

    // 6 digits, uniformly distributed, from a CSPRNG. `randomInt` is
    // rejection-sampled internally, so no modulo bias.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(
      Date.now() + detail.company.otpTtlMinutes * 60_000,
    );

    // Resolved before the transaction: it is read-only reference data, and
    // keeping template lookup out of the write path keeps the transaction as
    // short as the row locks it holds.
    const template = await this.prisma.notificationTemplate.findFirst({
      where: {
        companyId: job.companyId,
        eventCode: 'COLLECTION_OTP',
        channel: 'SMS',
        language: detail.customer.preferredLanguage,
        active: true,
        deletedAt: null,
      },
      select: { body: true },
    });
    const smsBody = renderOtpBody(template?.body, {
      company: detail.company.name,
      branch: detail.branch.name,
      customer: detail.customer.name,
      job_no: detail.jobNo,
      otp: code,
    });

    return this.prisma.$transaction(async (tx) => {
      await tx.jobCollectionOtp.updateMany({
        where: { jobId: job.id, verifiedAt: null, voidedAt: null },
        data: {
          voidedAt: new Date(),
          voidReason: 'Superseded by a newly issued PIN',
        },
      });

      const row = await tx.jobCollectionOtp.create({
        data: {
          id: randomUUID(),
          companyId: job.companyId,
          branchId: job.branchId,
          jobId: job.id,
          codeHash: hash(code),
          codeHint: code.slice(-2),
          sentTo: to,
          sentAt: new Date(),
          expiresAt,
          createdById: actorUserId,
        },
      });

      // Queued in the SAME transaction as the PIN row: a code that exists but
      // was never sent leaves the customer unable to collect their device, and
      // a code sent but not recorded can never be verified. Both must commit
      // together or not at all.
      await tx.notification.create({
        data: {
          id: randomUUID(),
          companyId: job.companyId,
          branchId: job.branchId,
          customerId: detail.customerId,
          jobId: job.id,
          eventCode: 'COLLECTION_OTP',
          channel: 'SMS',
          language: detail.customer.preferredLanguage,
          toAddress: to,
          // Rendered inline rather than through NotificationsService.enqueue:
          // the PIN must not be written into `payload`, which is stored for
          // debugging and would otherwise persist the plaintext code we went
          // to the trouble of hashing.
          body: smsBody,
          payload: { job_no: detail.jobNo, otp: '******' },
          status: 'QUEUED',
          availableAt: new Date(),
        },
      });

      return row;
    });
  }
}

/** SHA-256 hex — the same one-way store `sessions.refresh_token_hash` uses. */
function hash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Render the COLLECTION_OTP body from the company's template, falling back to
 * a built-in message. The fallback matters: a company that deleted the
 * template must still be able to hand devices back, and an empty SMS would
 * strand the customer at the counter.
 */
function renderOtpBody(
  templateBody: string | undefined,
  vars: Record<string, string>,
): string {
  const body =
    templateBody ??
    '{{company}}: your collection PIN for job {{job_no}} is {{otp}}. Show it at the counter. Do not share it.';
  return body.replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (_m, key: string) => vars[key] ?? '',
  );
}

function toWire(
  o: {
    id: string;
    jobId: string;
    codeHint: string;
    sentTo: string | null;
    sentAt: Date | null;
    expiresAt: Date;
    attempts: number;
    verifiedAt: Date | null;
    voidedAt: Date | null;
    voidReason: string | null;
  },
  /** The company's configured cap; the seeded default when not supplied. */
  maxAttempts = 5,
): CollectionOtpWire {
  const live =
    o.verifiedAt === null &&
    o.voidedAt === null &&
    o.expiresAt.getTime() > Date.now();
  return {
    id: o.id,
    job_id: o.jobId,
    code_hint: o.codeHint,
    sent_to: o.sentTo,
    sent_at: o.sentAt?.toISOString() ?? null,
    expires_at: o.expiresAt.toISOString(),
    attempts: o.attempts,
    attempts_remaining: Math.max(0, maxAttempts - o.attempts),
    verified_at: o.verifiedAt?.toISOString() ?? null,
    voided_at: o.voidedAt?.toISOString() ?? null,
    void_reason: o.voidReason,
    active: live,
  };
}
