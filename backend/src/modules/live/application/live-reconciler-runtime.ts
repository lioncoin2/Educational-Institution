import type { Logger } from '@nestjs/common';

import { KeyedMutex } from '../../../platform/concurrency/keyed-mutex';
import { LIVE_SESSIONS_PAGE_MAX } from '../domain/live-limits';
import type { LiveSession, LiveSessionKey } from '../domain/live-session';
import type { LiveSessionRepository } from '../domain/ports';
import { RtcUnavailableError } from '../domain/rtc-provider';

/**
 * What every part of one reconciler shares (live.md §11): its logger — so
 * every line it writes carries the `LiveReconciler` context — the lock that
 * serializes all work for one session, whichever tick or check asks, the
 * media provider's last known state, and the read of every live session
 * that each sweep starts from.
 *
 * Failures are logged by the error's class name only, never its message,
 * which could echo a request.
 */
export class ReconcilerRuntime {
  /** Every step for one session runs alone (the key is the session id). */
  readonly perSession = new KeyedMutex();
  /** The provider's last known state; an outage is logged when it changes, never per tick. */
  private providerAvailable = true;

  constructor(
    readonly logger: Logger,
    private readonly sessions: LiveSessionRepository,
  ) {}

  /** Every live session, 100 at a time; a failed page rejects the whole read. */
  async allLiveSessions(): Promise<readonly LiveSession[]> {
    const all: LiveSession[] = [];
    let after: LiveSessionKey | null = null;
    for (;;) {
      const page = await this.sessions.listLive(after, LIVE_SESSIONS_PAGE_MAX);
      all.push(...page);
      const last = page[page.length - 1];
      if (last === undefined || page.length < LIVE_SESSIONS_PAGE_MAX) return all;
      after = { startedAt: last.startedAt, id: last.id };
    }
  }

  /**
   * A provider call, noting whether the provider answered. An outage is
   * logged when it starts and when it ends — never once per call or tick.
   */
  async provider<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      if (!this.providerAvailable) {
        this.providerAvailable = true;
        this.logger.log(
          { event: 'live.reconciler.provider_available' },
          'the media provider answers again; reconciling resumes',
        );
      }
      return result;
    } catch (error) {
      if (error instanceof RtcUnavailableError && this.providerAvailable) {
        this.providerAvailable = false;
        this.logger.warn(
          { event: 'live.reconciler.provider_unavailable' },
          'the media provider is unavailable; reconciler ticks are skipped until it answers',
        );
      }
      throw error;
    }
  }

  /** A session's step skipped, by the error's class only — never its message. */
  logSkipped(stage: string, sessionId: string, error: unknown): void {
    this.logger.error(
      {
        event: 'live.reconciler.session_skipped',
        stage,
        sessionId,
        err: { name: errorName(error) },
      },
      'the reconciler could not read or change something; nothing was decided on unknown state',
    );
  }

  /** A whole tick skipped because an input every step needs could not be read completely. */
  logTickSkipped(tick: string, error: unknown): void {
    this.logger.error(
      { event: 'live.reconciler.tick_skipped', tick, err: { name: errorName(error) } },
      'the reconciler could not read what every step needs; the tick did nothing',
    );
  }
}

export const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);
