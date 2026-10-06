import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { MESSAGE_MODERATION } from './messaging-settings';

export interface RetentionReport {
  /** Messages whose content was wiped this sweep. */
  readonly wiped: number;
  /** How many purge statements it took to drain the backlog. */
  readonly batches: number;
}

/**
 * Message retention (Q51/Q23, ADR 0029): after a deleted message's 7-day review
 * window passes, its original content — body and attachment rows — is wiped,
 * and only the tombstone row remains. At boot and every
 * `retentionSweepIntervalMs` it purges in batches until the backlog is clear.
 *
 * The cutoff is `now - reviewWindowMs`, computed once per sweep, so a message
 * deleted during a sweep waits for the next one — the review window is never
 * cut short. It never hard-deletes a message ROW and never touches a file asset
 * (Files owns asset retention; there is no Files deletion contract — ADR 0029).
 *
 * Stateless and a pure backstop: a failed tick is logged and the next starts
 * over. Correctness of the review gate does not depend on it — the use case
 * refuses a review past the window whether or not retention has run — but
 * without it expired originals would linger in storage.
 */
@Injectable()
export class MessageRetentionSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MessageRetentionSweeper.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<RetentionReport | null> | undefined;

  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    // The boot sweep clears whatever expired while the process was down.
    void this.tick();
    if (MESSAGE_MODERATION.retentionSweepIntervalMs > 0) {
      this.timer = setInterval(() => void this.tick(), MESSAGE_MODERATION.retentionSweepIntervalMs);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.running;
  }

  /** One sweep; single-flight, never throws (null when it failed), awaitable by tests. */
  tick(): Promise<RetentionReport | null> {
    this.running ??= this.sweep()
      .catch((error: unknown) => {
        this.logger.warn(
          { err: { name: error instanceof Error ? error.name : typeof error } },
          'message retention sweep failed; the next tick starts over',
        );
        return null;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async sweep(): Promise<RetentionReport> {
    const before = new Date(this.clock.now().getTime() - MESSAGE_MODERATION.reviewWindowMs);
    let wiped = 0;
    let batches = 0;
    let purged = 0;
    do {
      purged = await this.repository.purgeDeletedBefore(before, MESSAGE_MODERATION.retentionBatch);
      wiped += purged;
      if (purged > 0) batches += 1;
    } while (purged === MESSAGE_MODERATION.retentionBatch);
    const report = { wiped, batches };
    if (wiped > 0) this.logger.log(report, 'message retention wiped expired deleted content');
    return report;
  }
}
