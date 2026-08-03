import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Out-of-warranty financial authorization (SCMS proposal Module 5, §6).
 *
 * "Whenever a job is flagged as out-of-warranty, the system shifts into a
 * 'Pending Quote' hold state. The technician's screen is locked. The system
 * auto-generates a secure payment link via SMS/Email. The job cannot advance
 * to the REPAIRING state until the customer clicks 'Approve' and provides a
 * verified digital signature or prepayment."
 *
 * Three pieces, and this service owns two of them:
 *
 *   1. the hold + bench lock  — {@link send} sets `jobs.tech_locked`;
 *   2. the secure link        — an unguessable, expiring, single-purpose token;
 *   3. the gate               — the `ow_quote_approved` workflow guard, which
 *                               reads `customerApprovedAt` (or a payment).
 *
 * CONSENT can arrive three ways, and all three are real at a Tanzanian service
 * counter: the customer taps Approve on the link, they sign at the desk, or
 * they simply pay a deposit. The proposal accepts "a verified digital
 * signature OR prepayment", so recording a counter signature and treating a
 * PARTIAL/PAID invoice as consent are both faithful, not shortcuts.
 *
 * The TOKEN is hashed at rest, exactly like the collection PIN and refresh
 * tokens. A link that authorises spending the customer's money must not be
 * readable from the database by someone who can already see the invoice.
 */

export interface QuoteApprovalWire {
  invoice_id: string;
  invoice_no: string;
  job_id: string | null;
  total: string;
  currency: string;
  quote_sent_at: string | null;
  quote_sent_to: string | null;
  approval_expires_at: string | null;
  customer_approved_at: string | null;
  customer_declined_at: string | null;
  approval_via: string | null;
  /** Derived: this quote authorises work to start. */
  approved: boolean;
}

/** What the public approval page shows the customer. */
export interface PublicQuoteWire {
  token: string;
  company: string;
  branch: string;
  invoice_no: string;
  job_no: string | null;
  device: string;
  currency: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  lines: Array<{ description: string; qty: number; line_total: string }>;
  expires_at: string;
  /** Already decided — the page shows the outcome rather than the buttons. */
  decided: 'APPROVED' | 'DECLINED' | null;
}

/** How long an approval link stays live. */
const LINK_TTL_HOURS = 14 * 24;

@Injectable()
export class QuoteApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * POST /invoices/{id}/send-quote — issue the secure approval link, put the
   * job on hold and lock the bench.
   *
   * Re-sending mints a FRESH token and invalidates the old one: a link
   * forwarded to the wrong person should stop working the moment the customer
   * asks for a new one.
   */
  async send(
    invoiceId: string,
    sendTo: string | null,
    user: AuthUser,
  ): Promise<QuoteApprovalWire> {
    const invoice = await this.load(invoiceId);

    if (invoice.type !== 'REPAIR_OW') {
      throw new UnprocessableEntityException(
        'Only an out-of-warranty repair quote can be sent for customer approval',
      );
    }
    if (invoice.status === 'VOID') {
      throw new ConflictException('This quote has been voided');
    }
    if (invoice.customerApprovedAt) {
      throw new ConflictException(
        'The customer has already approved this quote',
      );
    }
    if (invoice.total <= 0n) {
      throw new UnprocessableEntityException(
        'Add the repair lines before sending the quote — there is nothing to approve',
      );
    }

    const to =
      sendTo ??
      invoice.customer?.phoneNormalized ??
      invoice.customer?.phone ??
      invoice.customer?.email ??
      null;
    if (!to) {
      throw new UnprocessableEntityException(
        'This customer has no phone or email on file — record one, or take their decision at the counter',
      );
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_TTL_HOURS * 3_600_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          approvalTokenHash: hash(token),
          approvalExpiresAt: expiresAt,
          quoteSentAt: new Date(),
          quoteSentTo: to,
          // A previous decline is superseded by a re-quote: the customer is
          // being asked again, about a quote that may well have changed.
          customerDeclinedAt: null,
          updatedById: user.userId,
        },
      });

      // §6: "The technician's screen is locked." The bench must not keep
      // working on something the customer has not agreed to pay for.
      if (invoice.jobId) {
        await tx.job.update({
          where: { id: invoice.jobId },
          data: {
            techLocked: true,
            techLockReason: 'Awaiting the customer’s decision on the repair quote',
            updatedById: user.userId,
          },
        });
      }
    });

    await this.notifications.enqueue({
      companyId: invoice.companyId,
      branchId: invoice.branchId,
      customerId: invoice.customerId,
      jobId: invoice.jobId,
      eventCode: 'QUOTE_APPROVAL',
      language: invoice.customer?.preferredLanguage ?? 'EN',
      to: {
        sms: invoice.customer?.phoneNormalized ?? invoice.customer?.phone,
        email: invoice.customer?.email,
      },
      payload: {
        company: invoice.company.name,
        branch: invoice.branch.name,
        customer: invoice.customer?.name ?? 'Customer',
        job_no: invoice.job?.jobNo ?? invoice.invoiceNo,
        amount: `${invoice.currency} ${formatMinor(invoice.total)}`,
        link: `${this.publicBaseUrl()}/quote/${token}`,
        expires: expiresAt.toISOString().slice(0, 10),
      },
    });

    await this.audit.record({
      entityType: 'Invoice',
      entityId: invoiceId,
      action: 'UPDATE',
      before: null,
      after: { quote_sent_to: to, expires_at: expiresAt.toISOString() },
      companyId: invoice.companyId,
      branchId: invoice.branchId,
      actorUserId: user.userId,
    });

    return toWire(await this.load(invoiceId));
  }

  /**
   * POST /invoices/{id}/record-approval — the customer decided AT THE COUNTER.
   *
   * The proposal's happy path is the portal link, but plenty of customers are
   * standing right there. A counter approval requires a SIGNATURE attachment
   * for exactly the same reason the portal requires a click: a verbal yes that
   * nobody can produce afterwards is what this whole gate exists to replace.
   * PHONE approvals are allowed without one but are recorded as such, so the
   * weaker evidence is visible rather than disguised.
   */
  async recordCounterDecision(
    invoiceId: string,
    input: {
      decision: 'APPROVED' | 'DECLINED';
      via: 'COUNTER' | 'PHONE';
      signature_attachment_id?: string;
      note?: string;
    },
    user: AuthUser,
  ): Promise<QuoteApprovalWire> {
    const invoice = await this.load(invoiceId);
    if (invoice.status === 'VOID') {
      throw new ConflictException('This quote has been voided');
    }

    if (input.decision === 'APPROVED' && input.via === 'COUNTER') {
      if (!input.signature_attachment_id) {
        throw new UnprocessableEntityException(
          'Capture the customer’s signature to record a counter approval',
        );
      }
      const sig = await this.prisma.attachment.findFirst({
        where: {
          id: input.signature_attachment_id,
          kind: 'SIGNATURE',
          ...(invoice.jobId
            ? { ownerType: 'JOB', ownerId: invoice.jobId }
            : { ownerType: 'INVOICE', ownerId: invoiceId }),
        },
        select: { id: true },
      });
      if (!sig) {
        throw new UnprocessableEntityException(
          'signature_attachment_id must be a SIGNATURE uploaded against this job or invoice',
        );
      }
    }

    await this.applyDecision(invoiceId, input.decision, {
      via: input.via,
      signatureAttachmentId: input.signature_attachment_id ?? null,
      recordedById: user.userId,
      note: input.note ?? null,
    });

    await this.audit.record({
      entityType: 'Invoice',
      entityId: invoiceId,
      action: 'UPDATE',
      before: null,
      after: {
        customer_decision: input.decision,
        via: input.via,
        signature_attachment_id: input.signature_attachment_id ?? null,
      },
      companyId: invoice.companyId,
      branchId: invoice.branchId,
      actorUserId: user.userId,
    });

    return toWire(await this.load(invoiceId));
  }

  /** GET /invoices/{id}/approval — the gate's state. */
  async status(invoiceId: string): Promise<QuoteApprovalWire> {
    return toWire(await this.load(invoiceId));
  }

  // ------------------------------------------------- public (customer) side

  /** GET /public/quote/{token} — unauthenticated; renders the approval page. */
  async publicView(token: string): Promise<PublicQuoteWire> {
    const invoice = await this.loadByToken(token);
    return {
      token,
      company: invoice.company.name,
      branch: invoice.branch.name,
      invoice_no: invoice.invoiceNo,
      job_no: invoice.job?.jobNo ?? null,
      device:
        [invoice.job?.device.brand, invoice.job?.device.model]
          .filter(Boolean)
          .join(' ') || 'your device',
      currency: invoice.currency,
      subtotal: invoice.subtotal.toString(),
      discount: invoice.discount.toString(),
      tax: invoice.tax.toString(),
      total: invoice.total.toString(),
      lines: invoice.lines.map((l) => ({
        description: l.description,
        qty: l.qty,
        line_total: l.lineTotal.toString(),
      })),
      expires_at: invoice.approvalExpiresAt?.toISOString() ?? '',
      decided: invoice.customerApprovedAt
        ? 'APPROVED'
        : invoice.customerDeclinedAt
          ? 'DECLINED'
          : null,
    };
  }

  /** POST /public/quote/{token}/decision — unauthenticated; the customer answers. */
  async publicDecide(
    token: string,
    decision: 'APPROVED' | 'DECLINED',
  ): Promise<PublicQuoteWire> {
    const invoice = await this.loadByToken(token);
    if (invoice.customerApprovedAt || invoice.customerDeclinedAt) {
      // Idempotent rather than an error: a customer double-tapping Approve on
      // a slow connection should see confirmation, not a failure.
      return this.publicView(token);
    }

    await this.applyDecision(invoice.id, decision, {
      via: 'PORTAL',
      signatureAttachmentId: null,
      // Nobody on staff touched it — that is the point of self-service, and
      // recording a staff member here would be a fabricated actor.
      recordedById: null,
      note: null,
    });

    await this.audit.record({
      entityType: 'Invoice',
      entityId: invoice.id,
      action: 'UPDATE',
      before: null,
      after: { customer_decision: decision, via: 'PORTAL' },
      companyId: invoice.companyId,
      branchId: invoice.branchId,
      // No authenticated actor: the CUSTOMER acted. A null actor is the
      // truthful record; attributing it to whoever sent the link would be a lie
      // in the audit trail.
      actorUserId: null,
    });

    return this.publicView(token);
  }

  // ------------------------------------------------------------- internals

  /**
   * Apply a decision and release (or keep) the bench lock. One transaction:
   * an approval that did not unlock the technician leaves the job stuck, and
   * an unlock without the approval opens the gate for free.
   */
  private async applyDecision(
    invoiceId: string,
    decision: 'APPROVED' | 'DECLINED',
    meta: {
      via: string;
      signatureAttachmentId: string | null;
      recordedById: string | null;
      note: string | null;
    },
  ): Promise<void> {
    const invoice = await this.prisma.invoice.findFirstOrThrow({
      where: { id: invoiceId },
      select: { jobId: true },
    });
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          customerApprovedAt: decision === 'APPROVED' ? now : null,
          customerDeclinedAt: decision === 'DECLINED' ? now : null,
          approvalVia: meta.via,
          approvalSignatureAttachmentId: meta.signatureAttachmentId,
          approvalRecordedById: meta.recordedById,
          approvalNote: meta.note,
          // Burn the link on ANY decision: a token that still works after the
          // customer has answered is a way to change their answer.
          approvalTokenHash: null,
        },
      });

      if (invoice.jobId) {
        await tx.job.update({
          where: { id: invoice.jobId },
          data:
            decision === 'APPROVED'
              ? { techLocked: false, techLockReason: null }
              : {
                  // A decline does NOT unlock the bench: there is still no
                  // authority to work on the device. The front desk resolves
                  // it by re-quoting or returning the unit.
                  techLockReason:
                    'Customer declined the quote — re-quote or return the unit',
                },
        });
      }
    });
  }

  private async load(id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, deletedAt: null },
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
            phoneNormalized: true,
            email: true,
            preferredLanguage: true,
          },
        },
        company: { select: { name: true } },
        branch: { select: { name: true } },
        job: {
          select: {
            jobNo: true,
            device: { select: { brand: true, model: true } },
          },
        },
        lines: true,
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  /**
   * Resolve a public approval token. NOTE the deliberate absence of a company
   * filter: the caller is the customer, who has no tenant. The hashed,
   * unguessable, expiring token IS the authorization — and it is single-
   * purpose, granting exactly one invoice's quote and nothing else.
   */
  private async loadByToken(token: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { approvalTokenHash: hash(token), deletedAt: null },
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
            phoneNormalized: true,
            email: true,
            preferredLanguage: true,
          },
        },
        company: { select: { name: true } },
        branch: { select: { name: true } },
        job: {
          select: {
            jobNo: true,
            device: { select: { brand: true, model: true } },
          },
        },
        lines: true,
      },
    });
    // One message for every failure mode — an unknown token, an expired one
    // and a voided invoice must be indistinguishable to a prober.
    if (
      !invoice ||
      invoice.status === 'VOID' ||
      !invoice.approvalExpiresAt ||
      invoice.approvalExpiresAt.getTime() < Date.now()
    ) {
      throw new NotFoundException('This quote link is no longer valid');
    }
    return invoice;
  }

  private publicBaseUrl(): string {
    return (
      this.config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:5173'
    ).replace(/\/+$/, '');
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function formatMinor(amount: bigint): string {
  const whole = amount / 100n;
  const cents = amount % 100n;
  return `${whole}.${cents.toString().padStart(2, '0')}`;
}

function toWire(i: {
  id: string;
  invoiceNo: string;
  jobId: string | null;
  total: bigint;
  currency: string;
  quoteSentAt: Date | null;
  quoteSentTo: string | null;
  approvalExpiresAt: Date | null;
  customerApprovedAt: Date | null;
  customerDeclinedAt: Date | null;
  approvalVia: string | null;
  status: string;
}): QuoteApprovalWire {
  return {
    invoice_id: i.id,
    invoice_no: i.invoiceNo,
    job_id: i.jobId,
    total: i.total.toString(),
    currency: i.currency,
    quote_sent_at: i.quoteSentAt?.toISOString() ?? null,
    quote_sent_to: i.quoteSentTo,
    approval_expires_at: i.approvalExpiresAt?.toISOString() ?? null,
    customer_approved_at: i.customerApprovedAt?.toISOString() ?? null,
    customer_declined_at: i.customerDeclinedAt?.toISOString() ?? null,
    approval_via: i.approvalVia,
    // Mirrors the `ow_quote_approved` guard: an explicit approval, or money
    // actually received (the proposal accepts prepayment in place of a
    // signature).
    approved:
      (i.customerApprovedAt !== null && i.customerDeclinedAt === null) ||
      i.status === 'PARTIAL' ||
      i.status === 'PAID',
  };
}
