import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthUser } from '../auth/auth.types';
import type { ListQueryDto } from '../../common/dto/list-query.dto';

/**
 * Customer satisfaction surveys (SCMS proposal Module 6, §7 step 5).
 *
 * "Upon successful OTP entry, the system changes the status to 'CLOSED',
 * records the final time log for turnaround metrics, prompts the cash drawer
 * to settle open invoices, and fires a customer satisfaction (CSAT) survey
 * link."
 *
 * The link's TOKEN is the customer's entire credential, so it is:
 *   - 32 bytes from a CSPRNG, base64url — not guessable,
 *   - single-purpose: it grants read/write to exactly ONE survey row and
 *     nothing else, so a leaked link exposes one rating, not an account,
 *   - expiring: a survey link that works forever is a permanent unauthenticated
 *     endpoint against a customer's job.
 *
 * The survey is sent on a DELAY (default 1 hour). A satisfaction request that
 * arrives while the customer is still at the counter measures the queue, not
 * the repair.
 */

export interface CsatWire {
  id: string;
  job_id: string;
  job_no: string;
  branch_id: string;
  customer_id: string;
  customer_name: string;
  score: number | null;
  comment: string | null;
  sent_at: string | null;
  responded_at: string | null;
  expires_at: string;
}

/** What the public (unauthenticated) survey page needs to render itself. */
export interface PublicCsatWire {
  token: string;
  company: string;
  branch: string;
  job_no: string;
  device: string;
  /** Already answered — the page shows a thank-you rather than a form. */
  answered: boolean;
  score: number | null;
}

/** How long a survey link stays live. */
const SURVEY_TTL_DAYS = 30;
/** Delay before the request goes out, so it measures the repair not the queue. */
const SEND_DELAY_MS = 60 * 60_000;

@Injectable()
export class CsatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Raise (and queue) the survey for a job that has just been handed over.
   *
   * Idempotent per job: a job dispatched, reopened and dispatched again must
   * not spam the customer with a second link — the existing unanswered survey
   * is reused.
   *
   * Never throws for a business reason: the handover HAS happened, and a
   * survey problem must not undo it.
   */
  async requestForJob(jobId: string): Promise<void> {
    try {
      const existing = await this.prisma.csatSurvey.findFirst({
        where: { jobId },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return;

      const job = await this.prisma.job.findFirst({
        where: { id: jobId, deletedAt: null },
        select: {
          id: true,
          companyId: true,
          branchId: true,
          customerId: true,
          jobNo: true,
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
          company: { select: { name: true } },
        },
      });
      if (!job) return;

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(
        Date.now() + SURVEY_TTL_DAYS * 24 * 3_600_000,
      );

      await this.prisma.csatSurvey.create({
        data: {
          id: randomUUID(),
          companyId: job.companyId,
          branchId: job.branchId,
          jobId: job.id,
          customerId: job.customerId,
          token,
          expiresAt,
          sentAt: new Date(),
        },
      });

      await this.notifications.enqueue({
        companyId: job.companyId,
        branchId: job.branchId,
        customerId: job.customerId,
        jobId: job.id,
        eventCode: 'CSAT_REQUEST',
        language: job.customer.preferredLanguage,
        to: {
          sms: job.customer.phoneNormalized ?? job.customer.phone,
          email: job.customer.email,
        },
        payload: {
          company: job.company.name,
          branch: job.branch.name,
          customer: job.customer.name,
          job_no: job.jobNo,
          link: `${this.publicBaseUrl()}/csat/${token}`,
        },
        availableAt: new Date(Date.now() + SEND_DELAY_MS),
      });
    } catch {
      // Deliberately swallowed — see the doc comment.
    }
  }

  /** GET /public/csat/{token} — unauthenticated; renders the survey page. */
  async publicView(token: string): Promise<PublicCsatWire> {
    const survey = await this.loadByToken(token);
    return {
      token,
      company: survey.company.name,
      branch: survey.branch.name,
      job_no: survey.job.jobNo,
      device:
        [survey.job.device.brand, survey.job.device.model]
          .filter(Boolean)
          .join(' ') || 'your device',
      answered: survey.respondedAt !== null,
      score: survey.score,
    };
  }

  /** POST /public/csat/{token} — unauthenticated; records the answer. */
  async submit(
    token: string,
    score: number,
    comment: string | undefined,
  ): Promise<PublicCsatWire> {
    const survey = await this.loadByToken(token);
    if (survey.respondedAt) {
      throw new ConflictException(
        'Thanks — you have already rated this repair.',
      );
    }

    await this.prisma.csatSurvey.update({
      where: { id: survey.id },
      data: {
        score,
        comment: comment ?? null,
        respondedAt: new Date(),
      },
    });

    return { ...(await this.publicView(token)), answered: true, score };
  }

  /** GET /csat — the internal feedback queue. */
  async list(
    query: ListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<CsatWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 25;

    const where: Prisma.CsatSurveyWhereInput = {
      ...(query.q
        ? {
            OR: [
              { comment: { contains: query.q } },
              { job: { jobNo: { contains: query.q } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.csatSurvey.findMany({
        where,
        include: {
          job: { select: { jobNo: true } },
          customer: { select: { name: true } },
        },
        orderBy: [{ respondedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.csatSurvey.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        job_id: r.jobId,
        job_no: r.job.jobNo,
        branch_id: r.branchId,
        customer_id: r.customerId,
        customer_name: r.customer.name,
        score: r.score,
        comment: r.comment,
        sent_at: r.sentAt?.toISOString() ?? null,
        responded_at: r.respondedAt?.toISOString() ?? null,
        expires_at: r.expiresAt.toISOString(),
      })),
      page,
      page_size: pageSize,
      total,
    };
  }

  // ------------------------------------------------------------- helpers

  /**
   * Resolve a public token. NOTE the deliberate use of the raw findFirst with
   * no company filter: the caller is an unauthenticated customer with no
   * tenant, and the unguessable token IS the authorization. Every other read
   * path in the system stays company-scoped.
   */
  private async loadByToken(token: string) {
    const survey = await this.prisma.csatSurvey.findFirst({
      where: { token },
      include: {
        job: {
          select: {
            jobNo: true,
            device: { select: { brand: true, model: true } },
          },
        },
        branch: { select: { name: true } },
        company: { select: { name: true } },
      },
    });
    // One message for "no such token" and "expired token": distinguishing them
    // tells a probe which of its guesses were real survey links.
    if (!survey || survey.expiresAt.getTime() < Date.now()) {
      throw new NotFoundException('This feedback link is no longer valid');
    }
    return survey;
  }

  /** Where the customer-facing pages live, for building links. */
  private publicBaseUrl(): string {
    return (
      this.config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:5173'
    ).replace(/\/+$/, '');
  }
}
