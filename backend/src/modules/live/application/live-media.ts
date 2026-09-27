import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import { currentMediaRoom, type LiveSession } from '../domain/live-session';
import {
  RTC_PARTICIPANTS,
  RtcUnavailableError,
  type RtcParticipantControl,
} from '../domain/rtc-provider';
import { capabilitiesFor } from '../domain/standing';
import { LIVE_SETTINGS, type LiveSettings } from './live-settings';
import { LiveStanding } from './live-standing';

/**
 * What a push reports (live.md §15.1): `applied` — the provider holds the new
 * set now; `not_connected` — the person is not in the room, and their next
 * join carries it; `pending` — no answer (the provider unreachable, a fault,
 * or the standing could not be read), and it converges later.
 */
export type PushOutcome = 'applied' | 'not_connected' | 'pending';

/** A speaker's connection as last observed (audit D7) — a display hint, never truth. */
export type ObservedMedia = 'connected' | 'not_connected' | 'unknown';

/** Someone whose last push did not report `applied`. */
export interface UnsettledPush {
  readonly sessionId: string;
  readonly userId: string;
  /** When the first push that did not apply was made; a later one keeps it. */
  readonly since: Date;
}

/**
 * How many people each record keeps. The oldest go first; losing one only
 * leaves it to the participant sweep (60 s), which re-checks everyone
 * connected anyway.
 */
export const MEDIA_RECORD_LIMIT = 10_000;

/**
 * The one way Live pushes a person's media rights after a change it has
 * stored — a floor granted, revoked or yielded, a presenter slot opened or
 * closed — and what it remembers of the answers (audit D11, which retires
 * P1's CapabilityConvergence in favour of the reconciler's targeted watch).
 *
 * A push sends the person's FULL current set, `capabilitiesFor` their
 * standing as it is now — recomputed through `LiveStanding`, never taken from
 * the act — so a host whose own hand is revoked keeps the microphone hosting
 * gives them, and two changes that raced are settled by whichever was stored
 * last.
 *
 * It never throws: the change is already stored, and is audited and
 * announced whatever the media plane says. A failure is `pending`, logged by
 * class only (an outage was logged by the adapter already).
 *
 * In memory, per process, and deliberately small:
 *
 *   - `unsettled` — whoever's last push did not report `applied`. The
 *     reconciler's targeted watch drains it, so a grant made while
 *     the provider was down, or a revoked speaker who comes back with a
 *     refreshed token, is corrected within a watch tick. A restart loses it;
 *     the participant sweep backstops it (live.md §11.5).
 *   - the last observation of each person's connection, for the hands page
 *     (audit D7): a push that reached the provider observed them `connected`
 *     or `not_connected`, and so does every reconciler check of them
 *     (`noteObserved`).
 *
 * Both are dropped when the session ends.
 */
@Injectable()
export class LiveMedia {
  private readonly logger = new Logger(LiveMedia.name);
  private readonly unsettledPushes = new Map<string, UnsettledPush>();
  private readonly observations = new Map<
    string,
    { readonly sessionId: string; readonly connected: boolean }
  >();

  constructor(
    @Inject(RTC_PARTICIPANTS) private readonly participants: RtcParticipantControl,
    private readonly standing: LiveStanding,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Pushes `userId`'s full current set in `session`'s media room; never throws. */
  async push(session: LiveSession, userId: string): Promise<PushOutcome> {
    const outcome = await this.attempt(session, userId);
    this.noteOutcome(session.id, userId, outcome);
    return outcome;
  }

  /**
   * What a push reported — this class's own, or the reconciler's corrective
   * one: `applied` settles the person and observes them connected;
   * `not_connected` leaves them unsettled (the watch looks again, in case
   * they come back holding what they had) and observes them gone; `pending`
   * leaves them unsettled and observes nothing.
   */
  noteOutcome(sessionId: string, userId: string, outcome: PushOutcome): void {
    const key = personKey(sessionId, userId);
    if (outcome === 'applied') {
      this.unsettledPushes.delete(key);
    } else {
      const earlier = this.unsettledPushes.get(key);
      bounded(this.unsettledPushes, key, {
        sessionId,
        userId,
        since: earlier?.since ?? this.clock.now(),
      });
    }
    if (outcome !== 'pending') this.noteObserved(sessionId, userId, outcome === 'applied');
  }

  /**
   * The reconciler found the person holding exactly their set, or found
   * nothing left to push (not connected — their next join computes it): no
   * push of theirs is outstanding any more.
   */
  settle(sessionId: string, userId: string): void {
    this.unsettledPushes.delete(personKey(sessionId, userId));
  }

  /** The reconciler observed the person in the room, or not (audit D7). */
  noteObserved(sessionId: string, userId: string, connected: boolean): void {
    bounded(this.observations, personKey(sessionId, userId), { sessionId, connected });
  }

  /** Everyone whose last push did not report `applied`, oldest first — the watch's to drain. */
  unsettled(): readonly UnsettledPush[] {
    return [...this.unsettledPushes.values()];
  }

  /** A speaker's connection as last observed; `unknown` when nothing was. */
  observed(sessionId: string, userId: string): ObservedMedia {
    const observation = this.observations.get(personKey(sessionId, userId));
    if (observation === undefined) return 'unknown';
    return observation.connected ? 'connected' : 'not_connected';
  }

  /** Drops everything remembered about an ended session: nobody is left in its room. */
  forget(sessionId: string): void {
    for (const [key, push] of this.unsettledPushes) {
      if (push.sessionId === sessionId) this.unsettledPushes.delete(key);
    }
    for (const [key, observation] of this.observations) {
      if (observation.sessionId === sessionId) this.observations.delete(key);
    }
  }

  private async attempt(session: LiveSession, userId: string): Promise<PushOutcome> {
    try {
      // `ofAccounts` answers for every id it is asked about.
      const account = (await this.standing.ofAccounts(session, [userId])).get(userId);
      if (account === undefined) return 'pending';
      return await this.participants.updateCapabilities(
        currentMediaRoom(this.settings.roomNamePrefix, session),
        userId,
        capabilitiesFor(account.standing),
      );
    } catch (error) {
      // The adapter has logged an outage as a warning. Anything else — a
      // refusal, or Communities or the directory failing — is a fault worth
      // an error, named by class only: never a message, which could echo a
      // request.
      if (!(error instanceof RtcUnavailableError)) {
        this.logger.error(
          {
            event: 'live.media.push_failed',
            sessionId: session.id,
            err: { name: error instanceof Error ? error.name : typeof error },
          },
          'could not push a participant’s live media rights; left to the watch',
        );
      }
      return 'pending';
    }
  }
}

const personKey = (sessionId: string, userId: string) => `${sessionId}\u0000${userId}`;

/** Sets `key` as the newest entry, dropping the oldest beyond MEDIA_RECORD_LIMIT. */
function bounded<T>(record: Map<string, T>, key: string, value: T): void {
  record.delete(key);
  record.set(key, value);
  for (const oldest of record.keys()) {
    if (record.size <= MEDIA_RECORD_LIMIT) break;
    record.delete(oldest);
  }
}
