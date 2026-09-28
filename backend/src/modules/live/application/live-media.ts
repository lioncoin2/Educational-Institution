import { Inject, Injectable, Logger } from '@nestjs/common';

import { KeyedMutex } from '../../../platform/concurrency/keyed-mutex';
import { CLOCK, type Clock } from '../../../shared';
import { currentMediaRoom, type LiveSession } from '../domain/live-session';
import {
  RTC_PARTICIPANTS,
  RtcUnavailableError,
  type RtcApplyOutcome,
  type RtcCapabilities,
  type RtcParticipantControl,
} from '../domain/rtc-provider';
import { capabilitiesFor, type ParticipantStanding } from '../domain/standing';
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

/** No standing at all: what someone no longer eligible to stay may hold until they are removed. */
const NOBODY: ParticipantStanding = {
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
};

/**
 * The one way Live pushes a person's media rights — after a change it has
 * stored (a floor granted, revoked or yielded, a presenter slot opened or
 * closed), and for the reconciler's corrections (`pushNow`) — and what it
 * remembers of the answers (audit D11, which retires P1's
 * CapabilityConvergence in favour of the reconciler's targeted watch).
 *
 * A push sends the person's FULL current set, `capabilitiesFor` their
 * standing as it is now — recomputed through `LiveStanding`, never taken from
 * the act — so a host whose own hand is revoked keeps the microphone hosting
 * gives them. Someone Communities no longer lets stay gets the set of no
 * standing at all, whatever their hand says: the reconciler removes them
 * (P7.2).
 *
 * One push at a time per person, in the order they were asked for (P7.2):
 * each reads the standing only once the one before it has landed, so the
 * last to run carries the last stored change, and a grant and a revoke that
 * raced leave the provider holding whichever was stored last.
 *
 * `push` never throws: the change is already stored, and is audited and
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
 *   - when each person's pushes ran (`pushedSince`): a push changes the
 *     provider under a reconciler step's feet, so the step counts no
 *     violation on an observation a push may have overtaken (audit D22).
 *
 * All are dropped when the session ends — but a push still under way.
 */
@Injectable()
export class LiveMedia {
  private readonly logger = new Logger(LiveMedia.name);
  private readonly unsettledPushes = new Map<string, UnsettledPush>();
  private readonly observations = new Map<
    string,
    { readonly sessionId: string; readonly connected: boolean }
  >();
  /** Stepped as every push starts and as it ends; `pushMark` reads it. */
  private pushSequence = 0;
  /** Per person, the pushes under way; a person with none has no entry. */
  private readonly pushesUnderWay = new Map<string, number>();
  /**
   * Per person, `pushSequence` when their last push started or ended —
   * bounded like the rest: to lose one that still matters, MEDIA_RECORD_LIMIT
   * other people would have to be pushed during one reconciler step.
   */
  private readonly lastPushed = new Map<
    string,
    { readonly sessionId: string; readonly sequence: number }
  >();
  /** One push at a time per person — this class's and the reconciler's corrections alike. */
  private readonly perPerson = new KeyedMutex();

  constructor(
    @Inject(RTC_PARTICIPANTS) private readonly participants: RtcParticipantControl,
    private readonly standing: LiveStanding,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Pushes `userId`'s full current set in `session`'s media room, in turn; never throws. */
  async push(session: LiveSession, userId: string): Promise<PushOutcome> {
    const key = personKey(session.id, userId);
    // Under way from the moment it is asked for — waiting its turn included.
    this.pushesUnderWay.set(key, (this.pushesUnderWay.get(key) ?? 0) + 1);
    this.notePushed(session.id, key);
    let outcome: PushOutcome;
    try {
      outcome = await this.perPerson.run(key, () => this.attempt(session, userId));
    } finally {
      const left = (this.pushesUnderWay.get(key) ?? 1) - 1;
      if (left > 0) this.pushesUnderWay.set(key, left);
      else this.pushesUnderWay.delete(key);
      this.notePushed(session.id, key);
    }
    this.noteOutcome(session.id, userId, outcome);
    return outcome;
  }

  /**
   * The reconciler's correction: `userId`'s full current set, read afresh
   * and pushed in turn with every other push of theirs — so a correction
   * decided on an observation a moderator's push has since overtaken never
   * lands over it with an older set. The provider's answer, or its failure
   * — and a standing that cannot be read — thrown. Not one of this class's
   * pushes for `pushedSince`: the reconciler's corrections are serialized
   * with its own observations.
   */
  pushNow(session: LiveSession, userId: string): Promise<RtcApplyOutcome> {
    return this.perPerson.run(personKey(session.id, userId), async () =>
      this.participants.updateCapabilities(
        currentMediaRoom(this.settings.roomNamePrefix, session),
        userId,
        await this.setOf(session, userId),
      ),
    );
  }

  /** A point in the pushes' order, taken before the provider is observed (`pushedSince`). */
  pushMark(): number {
    return this.pushSequence;
  }

  /**
   * Whether a push of this person's set was under way at any time since
   * `mark` — one still going, or one that started or ended since. If so,
   * what the provider was observed holding after `mark` may be older than
   * what it holds now, or is about to. Only this class's pushes count: the
   * reconciler's own corrections are serialized with its observations.
   */
  pushedSince(sessionId: string, userId: string, mark: number): boolean {
    const key = personKey(sessionId, userId);
    return this.pushesUnderWay.has(key) || (this.lastPushed.get(key)?.sequence ?? 0) > mark;
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
    for (const [key, pushed] of this.lastPushed) {
      if (pushed.sessionId === sessionId) this.lastPushed.delete(key);
    }
  }

  private notePushed(sessionId: string, key: string): void {
    this.pushSequence += 1;
    bounded(this.lastPushed, key, { sessionId, sequence: this.pushSequence });
  }

  /**
   * The set `userId` may hold now: their standing's — or no standing's, once
   * Communities no longer lets them stay. Throws when it cannot be read.
   */
  private async setOf(session: LiveSession, userId: string): Promise<RtcCapabilities> {
    const account = (await this.standing.ofAccounts(session, [userId])).get(userId);
    // `ofAccounts` answers for every id it is asked about; never decided on a guess.
    if (account === undefined) throw new Error('No standing was read for the person pushed.');
    return capabilitiesFor(account.eligible ? account.standing : NOBODY);
  }

  private async attempt(session: LiveSession, userId: string): Promise<PushOutcome> {
    try {
      return await this.participants.updateCapabilities(
        currentMediaRoom(this.settings.roomNamePrefix, session),
        userId,
        await this.setOf(session, userId),
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
