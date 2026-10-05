import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import type { LivePresence, PresenceObservation } from '../contracts/presence';
import { currentMediaRoom, isLive } from '../domain/live-session';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { normalizePresence } from '../domain/presence';
import {
  RTC_OBSERVER,
  type RtcParticipantObservation,
  type RtcParticipantObserver,
} from '../domain/rtc-provider';
import { LIVE_SETTINGS, type LiveSettings } from './live-settings';

/**
 * PROVISIONAL engineering bounds (attendance.md §5.4), calibrated by the load
 * test before production use. Each lives here, the file that owns the behaviour.
 */
const OBSERVATION_DEADLINE_MS = 15_000;
const MAX_OBSERVATIONS_IN_FLIGHT = 4;
const MAX_OBSERVED_ENTRIES = 10_000;

/** The deadline fired before the provider answered. */
const DEADLINE_EXCEEDED = Symbol('live.presence.deadline');

/**
 * `LIVE_PRESENCE` (attendance.md §5.1/§5.3, live.md §13). It takes **one**
 * reading of who the media provider holds in a live session's room and
 * normalizes it under `provider_registry_v1`. It stores nothing, caches
 * nothing, and labels nobody present (Q68).
 *
 * Who may ask is **not** decided here: the caller is a trusted in-process module
 * (attendance) that has already authorized. This service only reads Live's own
 * record (to gate and re-check the observation) and the provider (once).
 */
@Injectable()
export class LivePresenceService implements LivePresence {
  private readonly logger = new Logger(LivePresenceService.name);
  /** At most `MAX_OBSERVATIONS_IN_FLIGHT` listings in flight per process (§5.4). */
  private readonly slots = new Semaphore(MAX_OBSERVATIONS_IN_FLIGHT);

  constructor(
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(RTC_OBSERVER) private readonly observer: RtcParticipantObserver,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async observe(liveSessionId: string): Promise<PresenceObservation> {
    const session = await this.sessions.findById(liveSessionId);
    if (session === null) return { kind: 'not_found' };
    if (!isLive(session)) return { kind: 'not_active' };

    // A slot is taken only for a session worth observing, and always released.
    await this.slots.acquire();
    try {
      const room = currentMediaRoom(this.settings.roomNamePrefix, session);
      return await this.observeLive(session.id, session.communityId, room);
    } finally {
      this.slots.release();
    }
  }

  private async observeLive(
    liveSessionId: string,
    communityId: string,
    room: string,
  ): Promise<PresenceObservation> {
    const observationStartedAt = this.clock.now();

    let observed: readonly RtcParticipantObservation[] | typeof DEADLINE_EXCEEDED;
    try {
      observed = await this.withDeadline(this.observer.listParticipants(room));
    } catch (error) {
      this.logUnavailable(error);
      return { kind: 'unavailable' };
    }
    if (observed === DEADLINE_EXCEEDED) {
      this.logUnavailable('deadline');
      return { kind: 'unavailable' };
    }

    const observedAt = this.clock.now();
    if (observed.length > MAX_OBSERVED_ENTRIES) {
      this.logUnavailable('oversize');
      return { kind: 'unavailable' };
    }

    // Re-read Live's record: if it is no longer live, the room was being torn
    // down during the read, so the listing is discarded (attendance.md §5.3).
    const after = await this.sessions.findById(liveSessionId);
    if (after === null || !isLive(after)) return { kind: 'not_active' };

    return {
      kind: 'observed',
      liveSessionId,
      communityId,
      observationStartedAt,
      observedAt,
      participants: normalizePresence(observed),
    };
  }

  /**
   * One provider call raced against the 15 s deadline. A provider rejection
   * propagates (the caller turns it into `unavailable`); the timer is cleared
   * either way and never keeps the process alive.
   */
  private withDeadline<T>(call: Promise<T>): Promise<T | typeof DEADLINE_EXCEEDED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), OBSERVATION_DEADLINE_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
  }

  private logUnavailable(reason: unknown): void {
    this.logger.error(
      {
        event: 'live.presence.unavailable',
        reason: reason instanceof Error ? reason.name : String(reason),
      },
      'presence observation could not be taken; answering unavailable',
    );
  }
}

/**
 * A minimal counting semaphore: `acquire` waits for a free permit, `release`
 * hands one to the next waiter or returns it to the pool. It bounds the
 * listings in flight per process (§5.4) without reaching for a dependency.
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.available += 1;
  }
}
