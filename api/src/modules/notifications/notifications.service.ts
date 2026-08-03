import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type NotificationChannel,
  type PreferredLanguage,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The notification event engine (SCMS proposal Module 7; DESIGN.md §4.13/E6).
 *
 * Operational code NEVER calls an SMS gateway. It publishes an EVENT —
 * `JOB_READY`, `COLLECTION_OTP`, `QUOTE_APPROVAL` — and this service renders
 * the company's template for the recipient's channel and language and drops a
 * row in the outbox. A background worker drains it.
 *
 * Two properties matter and both come from the outbox being a table:
 *
 *  - The enqueue is TRANSACTIONAL with the business write. Pass `tx` and
 *    "the job moved to READY" and "the customer will be told" commit or roll
 *    back together. There is no window where the state changed but the SMS
 *    was lost, and none where an SMS goes out for a transition that failed.
 *  - The enqueue is FAST. It is one INSERT; nothing at the front desk ever
 *    waits on a third-party gateway. That is the proposal's stated reason for
 *    asking for worker queues at all: "This ensures the frontend stays
 *    responsive for front-desk staff."
 *
 * `notifications` doubles as the CRM communication log (§4.13), which is why
 * the RENDERED body is stored rather than re-rendered on read: the log must
 * show what the customer actually received, not what today's template would
 * produce.
 */

/** The facts a template is rendered against. Values are stringified. */
export type NotificationPayload = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface EnqueueInput {
  companyId: string;
  eventCode: string;
  /** Omit to fan out to every channel that has an active template. */
  channels?: NotificationChannel[];
  branchId?: string | null;
  customerId?: string | null;
  jobId?: string | null;
  userId?: string | null;
  /** Recipient per channel; SMS/WHATSAPP take a phone, EMAIL an address. */
  to: { sms?: string | null; email?: string | null };
  language?: PreferredLanguage;
  payload: NotificationPayload;
  /** Delay first delivery (e.g. send the CSAT survey an hour after handover). */
  availableAt?: Date;
}

/** The Prisma client or an interactive-transaction handle. */
type Db = PrismaService | Prisma.TransactionClient;

/** Channels that address a phone number rather than an email box. */
const PHONE_CHANNELS: ReadonlySet<NotificationChannel> = new Set([
  'SMS',
  'WHATSAPP',
]);

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Publish an event. Returns the ids of the rows queued (possibly none).
   *
   * Never throws for a business reason — a missing template or an unreachable
   * customer must not fail the operation that triggered it. A device really is
   * ready for collection even if we cannot tell anyone by SMS; failing the
   * transition instead would be strictly worse. Anything skipped is logged.
   */
  async enqueue(input: EnqueueInput, db: Db = this.prisma): Promise<string[]> {
    const language = input.language ?? 'EN';

    const templates = await db.notificationTemplate.findMany({
      where: {
        companyId: input.companyId,
        eventCode: input.eventCode,
        active: true,
        deletedAt: null,
        ...(input.channels ? { channel: { in: input.channels } } : {}),
      },
    });

    if (templates.length === 0) {
      this.logger.debug(
        `No active template for ${input.eventCode} (company ${input.companyId}) — nothing queued`,
      );
      return [];
    }

    // One template per channel: the requested language, else EN as the
    // documented fallback. A Swahili-preferring customer should get the
    // English message rather than silence when only EN is configured.
    const byChannel = new Map<NotificationChannel, (typeof templates)[number]>();
    for (const t of templates) {
      const chosen = byChannel.get(t.channel);
      if (!chosen) {
        byChannel.set(t.channel, t);
        continue;
      }
      if (chosen.language !== language && t.language === language) {
        byChannel.set(t.channel, t);
      }
    }

    const ids: string[] = [];
    for (const [channel, template] of byChannel) {
      const to = PHONE_CHANNELS.has(channel)
        ? input.to.sms
        : channel === 'EMAIL'
          ? input.to.email
          : // IN_APP has no external address; it is read in-product.
            (input.to.email ?? input.to.sms ?? 'in-app');
      if (!to) {
        this.logger.debug(
          `${input.eventCode}/${channel}: no recipient address — skipped`,
        );
        continue;
      }

      const id = randomUUID();
      await db.notification.create({
        data: {
          id,
          companyId: input.companyId,
          branchId: input.branchId ?? null,
          customerId: input.customerId ?? null,
          jobId: input.jobId ?? null,
          userId: input.userId ?? null,
          eventCode: input.eventCode,
          channel,
          language: template.language,
          toAddress: to,
          subject: template.subject ? render(template.subject, input.payload) : null,
          body: render(template.body, input.payload),
          payload: input.payload as Prisma.InputJsonValue,
          status: 'QUEUED',
          availableAt: input.availableAt ?? new Date(),
        },
      });
      ids.push(id);
    }
    return ids;
  }

  /**
   * Fire-and-forget enqueue for callers that are NOT inside a transaction and
   * genuinely must not be blocked or broken by the notification path (the
   * transition handler, say). Errors are logged, never propagated.
   */
  enqueueDetached(input: EnqueueInput): void {
    void this.enqueue(input).catch((e: unknown) => {
      this.logger.error(
        `Failed to queue ${input.eventCode}: ${(e as Error).message}`,
      );
    });
  }
}

/**
 * Substitute `{{token}}` placeholders. Unknown tokens are replaced with an
 * empty string rather than left as literal `{{name}}` text: a customer must
 * never receive a message with template syntax in it, and a silently missing
 * word reads far better than `{{branch}}`.
 *
 * Whitespace inside the braces is tolerated (`{{ job_no }}`) because template
 * bodies are edited by humans in a textarea.
 */
export function render(template: string, payload: NotificationPayload): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = payload[key];
    return value === null || value === undefined ? '' : String(value);
  });
}
