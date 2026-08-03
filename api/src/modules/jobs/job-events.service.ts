import { Injectable, Logger } from '@nestjs/common';
import type { WorkflowStage } from '@prisma/client';

/**
 * A tiny in-process event bus for job lifecycle events.
 *
 * WHY THIS EXISTS. Several things must happen when a job changes state, and
 * they live in modules that already depend on JobsModule:
 *
 *   → READY       issue the collection PIN and SMS it   (LogisticsModule)
 *   → DISPATCHED  fire the CSAT survey                  (LogisticsModule)
 *
 * Having JobsService call those services directly would make JobsModule and
 * LogisticsModule import each other. The usual Nest answer is `forwardRef`,
 * but a circular module graph is a real cost — it makes initialisation order
 * subtle and the dependency direction unreadable — for what is, in substance,
 * a one-way notification.
 *
 * So the dependency points ONE way: JobsService publishes, and modules that
 * already depend on it subscribe at startup. Jobs knows nothing about
 * logistics, which is the correct direction: a repair shop can exist without
 * couriers, but not the reverse.
 *
 * SUBSCRIBERS MUST NOT THROW. This is a notification, not a transaction: by
 * the time it fires the state change is committed and audited, and a
 * subscriber failure must never surface as a failed transition to the person
 * who made it. Errors are caught and logged here so a subscriber cannot break
 * the front desk by being broken itself.
 */

/** What a subscriber is told when a job moves. */
export interface JobStateChangedEvent {
  jobId: string;
  companyId: string;
  branchId: string;
  fromStateCode: string;
  toStateCode: string;
  toStage: WorkflowStage;
  actorUserId: string;
  at: Date;
}

export type JobStateChangedHandler = (
  event: JobStateChangedEvent,
) => void | Promise<void>;

@Injectable()
export class JobEventsService {
  private readonly logger = new Logger(JobEventsService.name);
  private readonly handlers: Array<{
    name: string;
    fn: JobStateChangedHandler;
  }> = [];

  /**
   * Register a subscriber. `name` appears in the log if it throws, so a
   * failing subscriber is identifiable without a stack trace archaeology
   * session.
   */
  onStateChanged(name: string, fn: JobStateChangedHandler): void {
    this.handlers.push({ name, fn });
  }

  /**
   * Publish. Awaited so the caller's response reflects work that finished,
   * but INDIVIDUALLY guarded so one broken subscriber cannot stop the others
   * or fail the transition.
   */
  async publishStateChanged(event: JobStateChangedEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler.fn(event);
      } catch (e) {
        this.logger.error(
          `Job lifecycle subscriber '${handler.name}' failed for job ${event.jobId} ` +
            `(${event.fromStateCode} → ${event.toStateCode}): ${(e as Error).message}`,
        );
      }
    }
  }
}
