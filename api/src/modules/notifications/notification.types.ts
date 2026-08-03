import type { NotificationChannel } from '@prisma/client';

/**
 * Delivery drivers (SCMS proposal Module 7 / DESIGN.md §9 "Integrations").
 *
 * One interface, several backends — exactly the shape StorageService uses for
 * object storage, and for the same reason: the SMS gateway is a per-deployment
 * choice (Beem and Africa's Talking both serve Tanzania) and the code that
 * decides "the customer should be told the device is ready" must not know or
 * care which one is wired up.
 *
 * A driver's ONLY job is to hand the message to a provider and report what
 * happened. Retry policy, backoff and the outbox live in the worker, because
 * they are the same for every channel.
 */

/** One message, fully rendered and addressed, ready to go out. */
export interface OutboundMessage {
  /** Phone number (E.164) or email address, already resolved. */
  to: string;
  /** Email subject; ignored by SMS drivers. */
  subject?: string | null;
  body: string;
  /** For correlating provider logs back to our row. */
  reference: string;
}

/** What a driver reports back. */
export interface DeliveryResult {
  /** Provider's own message id, for delivery-report lookup. */
  providerRef?: string | null;
  /**
   * True when the failure is worth retrying (network blip, 5xx, rate limit).
   * A rejected number or a malformed address is PERMANENT — retrying it 5
   * times just burns the queue and delays everything behind it.
   */
  retryable?: boolean;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** See {@link DeliveryResult.retryable}. Defaults to retryable. */
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export interface NotificationDriver {
  readonly channel: NotificationChannel;
  /** Deliver, or throw {@link DeliveryError}. */
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

/** DI token for the set of configured drivers. */
export const NOTIFICATION_DRIVERS = Symbol('NOTIFICATION_DRIVERS');
