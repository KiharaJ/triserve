import { Logger } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import {
  DeliveryError,
  type DeliveryResult,
  type NotificationDriver,
  type OutboundMessage,
} from '../notification.types';

/** Config for {@link HttpSmsDriver}, read from `SMS_*` env vars. */
export interface HttpSmsConfig {
  url: string;
  /** Sent as `Authorization: <scheme> <key>`; scheme defaults to Bearer. */
  apiKey?: string;
  authScheme?: string;
  /** Sender id shown on the handset ("TRISERVE"). */
  senderId?: string;
  /** JSON field names, so one driver fits several gateways' payload shapes. */
  toField: string;
  bodyField: string;
  senderField?: string;
  /** Dotted path to the provider's message id in the response JSON. */
  refPath?: string;
  timeoutMs: number;
}

/**
 * A generic JSON-over-HTTP SMS gateway driver.
 *
 * Tanzania's usable gateways (Beem Africa, Africa's Talking, NextSMS) all
 * expose the same essential shape — POST a JSON body with a recipient, a
 * message and a sender id, get back a message id — differing mainly in field
 * NAMES and auth header. So rather than three near-identical vendor SDK
 * wrappers, the field names are configuration. A gateway that needs genuinely
 * different semantics gets its own driver implementing the same interface;
 * this one covers the common case without pulling in a dependency.
 *
 * Uses global `fetch` (Node 20+, which the repo already requires) — no HTTP
 * client dependency for what is one POST.
 */
export class HttpSmsDriver implements NotificationDriver {
  private readonly logger = new Logger('HttpSmsDriver');
  readonly isStub = false;

  constructor(
    readonly channel: NotificationChannel,
    private readonly config: HttpSmsConfig,
  ) {}

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    const payload: Record<string, unknown> = {
      [this.config.toField]: message.to,
      [this.config.bodyField]: message.body,
    };
    if (this.config.senderField && this.config.senderId) {
      payload[this.config.senderField] = this.config.senderId;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.config.apiKey) {
      headers.authorization = `${this.config.authScheme ?? 'Bearer'} ${this.config.apiKey}`;
    }

    // A hung gateway must not hold a worker slot open indefinitely — the whole
    // queue would stall behind one bad request.
    const abort = AbortSignal.timeout(this.config.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: abort,
      });
    } catch (e) {
      // Network failure / timeout: always worth another go.
      throw new DeliveryError(
        `SMS gateway unreachable: ${(e as Error).message}`,
        true,
      );
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // 4xx is the provider telling us the REQUEST is wrong (bad number, bad
      // credentials, no credit) — retrying cannot fix it, except 408/429 which
      // are explicitly "try again".
      const retryable =
        res.status >= 500 || res.status === 408 || res.status === 429;
      throw new DeliveryError(
        `SMS gateway returned ${res.status}: ${text.slice(0, 300)}`,
        retryable,
      );
    }

    return { providerRef: this.extractRef(text) };
  }

  /**
   * Pull the provider's message id out of the response. Best-effort by design:
   * a missing id costs us delivery-report correlation, not the delivery — so
   * it must never turn a successful send into a failure.
   */
  private extractRef(body: string): string | null {
    if (!this.config.refPath) return null;
    try {
      let cur: unknown = JSON.parse(body);
      for (const key of this.config.refPath.split('.')) {
        if (cur === null || typeof cur !== 'object') return null;
        cur = (cur as Record<string, unknown>)[key];
      }
      return cur == null ? null : String(cur);
    } catch {
      this.logger.debug('SMS gateway response was not JSON; no provider ref');
      return null;
    }
  }
}
