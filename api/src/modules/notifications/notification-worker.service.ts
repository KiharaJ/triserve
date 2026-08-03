import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DeliveryError,
  NOTIFICATION_DRIVERS,
  type NotificationDriver,
} from './notification.types';

/**
 * The asynchronous outbox worker (SCMS proposal Module 7 / §8).
 *
 * "Build the system using asynchronous worker queues to handle heavy
 * operations like third-party warranty verification lookups, SMS delivery,
 * invoice generation, and customer email alerts. This ensures the frontend
 * stays responsive for front-desk staff."
 *
 * This is that worker. The queue is the `notifications` table (see
 * NotificationsService for why a table rather than Redis), and this loop
 * drains it on a timer.
 *
 * SAFETY UNDER MULTIPLE INSTANCES. The API may run on more than one node, and
 * two nodes must never send the same SMS twice. Claiming is therefore a
 * conditional UPDATE, not a read-then-write:
 *
 *     UPDATE notifications
 *        SET status='SENDING', leased_until=?
 *      WHERE id=? AND status='QUEUED'
 *
 * MySQL reports how many rows changed. Exactly one claimant sees 1; everyone
 * else sees 0 and moves on. No advisory locks, no SELECT … FOR UPDATE held
 * across a network call to a third party.
 *
 * A crashed worker leaves rows stuck in SENDING. `leased_until` bounds that:
 * once the lease expires the row is reclaimable, so a hard kill costs a delay,
 * not a lost message.
 *
 * RETRIES are capped and backed off exponentially. A PERMANENT failure (bad
 * number, rejected credentials) is not retried at all — see DeliveryError.
 */

/** How long a claim is held before another worker may reclaim the row. */
const LEASE_MS = 2 * 60_000;

/** Give up after this many attempts. */
const MAX_ATTEMPTS = 5;

/** Backoff before attempt N (1-indexed): 30s, 2m, 8m, 32m. */
function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** (attempt - 1), 60 * 60_000);
}

@Injectable()
export class NotificationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow tick overlapping the next one. */
  private draining = false;
  private stopped = false;

  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(NOTIFICATION_DRIVERS)
    private readonly drivers: Map<NotificationChannel, NotificationDriver>,
  ) {
    this.pollMs = Number(config.get('NOTIFICATION_POLL_MS') ?? 15_000);
    this.batchSize = Number(config.get('NOTIFICATION_BATCH_SIZE') ?? 25);
    // Off in tests: an integration suite that creates jobs would otherwise
    // race a live worker mutating the same rows underneath its assertions.
    this.enabled =
      String(config.get('NOTIFICATION_WORKER_ENABLED') ?? 'true') !== 'false' &&
      config.get('NODE_ENV') !== 'test';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Notification worker disabled');
      return;
    }
    // `unref` so a pending timer never holds the process open during a
    // graceful shutdown or a one-shot script.
    this.timer = setInterval(() => void this.drain(), this.pollMs);
    this.timer.unref?.();
    this.logger.log(
      `Notification worker started (every ${this.pollMs}ms, batch ${this.batchSize}, ` +
        `channels: ${[...this.drivers.keys()].join(', ') || 'none'})`,
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One drain pass. Public so tests and an admin "send now" endpoint can
   * trigger it deterministically instead of waiting for the timer.
   */
  async drain(): Promise<{ claimed: number; sent: number; failed: number }> {
    if (this.draining) return { claimed: 0, sent: 0, failed: 0 };
    this.draining = true;
    let sent = 0;
    let failed = 0;
    let claimed = 0;

    try {
      const now = new Date();
      // Candidates: due and unclaimed, or claimed by a worker whose lease has
      // expired (it crashed). Read without locking — the claim below is what
      // actually arbitrates.
      const candidates = await this.prisma.notification.findMany({
        where: {
          OR: [
            { status: 'QUEUED', availableAt: { lte: now } },
            { status: 'SENDING', leasedUntil: { lt: now } },
          ],
        },
        orderBy: { availableAt: 'asc' },
        take: this.batchSize,
        select: {
          id: true,
          status: true,
          channel: true,
          toAddress: true,
          subject: true,
          body: true,
          attempts: true,
          eventCode: true,
        },
      });

      for (const row of candidates) {
        if (this.stopped) break;
        if (!(await this.claim(row.id, row.status))) continue;
        claimed++;

        const driver = this.drivers.get(row.channel);
        if (!driver) {
          // No driver configured for this channel. Permanent by definition —
          // retrying cannot conjure one — so fail it loudly rather than
          // cycling the row through the queue forever.
          await this.markFailed(
            row.id,
            row.attempts + 1,
            `No driver configured for channel ${row.channel}`,
          );
          failed++;
          continue;
        }

        try {
          const result = await driver.send({
            to: row.toAddress,
            subject: row.subject,
            body: row.body,
            reference: row.id,
          });
          await this.prisma.notification.update({
            where: { id: row.id },
            data: {
              status: 'SENT',
              sentAt: new Date(),
              attempts: row.attempts + 1,
              providerRef: result.providerRef ?? null,
              lastError: null,
              leasedUntil: null,
            },
          });
          sent++;
        } catch (e) {
          failed++;
          const attempts = row.attempts + 1;
          const err = e as Error;
          const retryable =
            e instanceof DeliveryError ? e.retryable : true;

          if (!retryable || attempts >= MAX_ATTEMPTS) {
            await this.markFailed(
              row.id,
              attempts,
              `${retryable ? 'Giving up after ' + attempts + ' attempts' : 'Permanent failure'}: ${err.message}`,
            );
            this.logger.warn(
              `${row.eventCode}/${row.channel} to ${row.toAddress} failed permanently: ${err.message}`,
            );
          } else {
            await this.prisma.notification.update({
              where: { id: row.id },
              data: {
                status: 'QUEUED',
                attempts,
                lastError: err.message.slice(0, 2000),
                availableAt: new Date(Date.now() + backoffMs(attempts)),
                leasedUntil: null,
              },
            });
          }
        }
      }
    } catch (e) {
      // The loop must survive anything — a worker that dies on one bad row
      // silently stops every notification in the system.
      this.logger.error(`Drain pass failed: ${(e as Error).message}`);
    } finally {
      this.draining = false;
    }

    return { claimed, sent, failed };
  }

  /**
   * Atomically take ownership of a row. Returns false when another worker won
   * the race (or the row changed underneath us), in which case we simply skip
   * it — it is somebody else's to deliver.
   */
  private async claim(
    id: string,
    expectedStatus: 'QUEUED' | 'SENDING' | string,
  ): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.notification.updateMany({
      where:
        expectedStatus === 'SENDING'
          ? // Reclaiming an expired lease: only if it is STILL expired, so we
            // cannot steal a row a healthy worker just renewed.
            { id, status: 'SENDING', leasedUntil: { lt: now } }
          : { id, status: 'QUEUED' },
      data: {
        status: 'SENDING',
        leasedUntil: new Date(now.getTime() + LEASE_MS),
      },
    });
    return count === 1;
  }

  private async markFailed(
    id: string,
    attempts: number,
    error: string,
  ): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: 'FAILED',
        attempts,
        lastError: error.slice(0, 2000),
        leasedUntil: null,
      },
    });
  }
}
