import { Logger } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type {
  DeliveryResult,
  NotificationDriver,
  OutboundMessage,
} from '../notification.types';

/**
 * The default driver: log the message and report success.
 *
 * This is what runs until a real SMS gateway is configured, and it is a
 * deliberate choice rather than an oversight. The alternative — failing every
 * notification when no provider is set — would make the whole system
 * undemoable and would block the workflow gates that depend on a PIN having
 * been "sent". Logging keeps the pipeline honest end to end (row queued →
 * claimed → rendered → delivered → SENT) with the last hop stubbed.
 *
 * It is UNMISTAKABLE in the logs: every line is prefixed so nobody can look at
 * production output and think a real SMS went out.
 *
 * SECURITY NOTE: the body IS logged, and OTP/approval-link messages contain
 * secrets. That is acceptable for a stub whose whole purpose is local
 * development, and is exactly why {@link isStub} is true — the config check at
 * startup warns when this driver is live outside development.
 */
export class LogNotificationDriver implements NotificationDriver {
  private readonly logger = new Logger('NotificationDriver');
  readonly isStub = true;

  constructor(readonly channel: NotificationChannel) {}

  send(message: OutboundMessage): Promise<DeliveryResult> {
    this.logger.log(
      `[STUB ${this.channel} — NOT ACTUALLY SENT] to=${message.to} ` +
        `ref=${message.reference}` +
        (message.subject ? ` subject=${JSON.stringify(message.subject)}` : '') +
        ` body=${JSON.stringify(message.body)}`,
    );
    return Promise.resolve({ providerRef: `stub:${randomUUID()}` });
  }
}
