import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { KeyedMutex } from '../../../platform/concurrency/keyed-mutex';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../../../shared';
import { MAX_AUTHORIZE_BATCH } from '../../communities/contracts/authorization';
import {
  COMMUNITY_MEMBERSHIP,
  type CommunityMembership,
} from '../../communities/contracts/membership';
import { screenShareStopped, speakerExpired, type LiveEvent } from '../domain/events';
import {
  ENFORCEMENT_WATCH_SECONDS,
  IDLE_END_SECONDS,
  LIVE_SESSIONS_PAGE_MAX,
  ORPHAN_GRACE_SECONDS,
  PARTICIPANT_SWEEP_SECONDS,
  ROOM_PROVIDER_TIMEOUT_SECONDS,
  ROOM_SWEEP_SECONDS,
  WATCH_TICK_SECONDS,
} from '../domain/live-limits';
import {
  currentMediaRoom,
  isLive,
  parseMediaRoomName,
  type LiveSession,
  type LiveSessionKey,
} from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import {
  LIVE_SESSION_REPOSITORY,
  PRESENTER_GRANT_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type PresenterGrantRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import {
  RTC_OBSERVER,
  RTC_PARTICIPANTS,
  RTC_ROOMS,
  RtcUnavailableError,
  type RtcApplyOutcome,
  type RtcParticipantControl,
  type RtcParticipantObservation,
  type RtcParticipantObserver,
  type RtcRoomObservation,
  type RtcRoomProvider,
  type RtcRoomSpec,
} from '../domain/rtc-provider';
import { capabilitiesFor, capabilityDrift } from '../domain/standing';
import { LiveJournal, moderationAudit } from './live-journal';
import { LiveMedia } from './live-media';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { LIVE_SETTINGS, type LiveSettings } from './live-settings';
import { LiveStanding, type AccountStanding } from './live-standing';
import { RoomOccupancy } from './room-occupancy';

/**
 * Why a whole tick did nothing: another run of the same tick was still going
 * (ticks never queue), the media provider could not be reached, or an input
 * every step depends on — the live sessions, the room list — could not be
 * read completely.
 */
export type TickSkip = 'in_flight' | 'provider_unavailable' | 'failed';

/** What the per-identity steps of one or more sessions did. */
export interface IdentityTally {
  /** Identities that went through the per-identity step. */
  readonly checked: number;
  /** Removed from the room: not eligible to stay. */
  readonly removed: number;
  /** Held more than their set: the full set pushed, and watched. */
  readonly corrected: number;
  /** Held less than their set — a grant not yet applied: pushed, never a violation. */
  readonly pushed: number;
  /** Breaches seen again after a correction that reported `applied` (audit D22). */
  readonly violations: number;
  /** Media resets that moved a session to a new room (§11.4). */
  readonly resets: number;
}

/** The room sweep's report (design §11.2). */
export interface RoomSweepReport {
  readonly skipped: TickSkip | null;
  /** Live sessions paged. */
  readonly sessions: number;
  /** Of them, skipped on unknown state or a fault: nothing was done to them. */
  readonly sessionsSkipped: number;
  /** Missing current rooms ensured and kept (re-checked live on the same epoch). */
  readonly ensured: number;
  /** Sessions ended `idle`. */
  readonly idleEnded: number;
  /** Rooms of this deployment's form that no live session claims, ended after their grace. */
  readonly orphansEnded: number;
}

/** The participant sweep's and the targeted watch's report (design §11.3, §11.4). */
export interface SessionSweepReport extends IdentityTally {
  readonly skipped: TickSkip | null;
  /** Live sessions paged. */
  readonly sessions: number;
  /** Of them, skipped on unknown state or a fault: nobody in them was touched. */
  readonly sessionsSkipped: number;
  /** Sessions ended `community_closed`. */
  readonly ended: number;
}

/** One session's check — the sweep's, the watch's, or `ProtectLiveSessions`'. */
export interface SessionCheckReport extends IdentityTally {
  /**
   *   checked               every input was read, and every step ran
   *   not_live              the session is unknown or no longer live: nothing to do
   *   community_closed      Communities no longer lets it run: ended, nothing else
   *   skipped               an input could not be read, or a fault: nothing decided
   *   provider_unavailable  the media provider could not be reached: nothing decided
   */
  readonly outcome:
    'checked' | 'not_live' | 'community_closed' | 'skipped' | 'provider_unavailable';
}

/** How many (session, identity) enforcement entries are kept; the oldest go first. */
export const WATCH_ENTRY_LIMIT = 10_000;

/** One identity under enforcement (design §11.4; audit D10, D22). */
interface WatchEntry {
  readonly sessionId: string;
  readonly userId: string;
  /** Watched until then; extended on every correction and violation. */
  readonly until: Date;
  /** Whether the last correction REPORTED `applied` — only then is a repeat a violation. */
  readonly applied: boolean;
}

const NO_TALLY: IdentityTally = Object.freeze({
  checked: 0,
  removed: 0,
  corrected: 0,
  pushed: 0,
  violations: 0,
  resets: 0,
});

/** What one per-identity step did. */
interface StepOutcome {
  readonly removed?: boolean;
  readonly corrected?: boolean;
  readonly pushed?: boolean;
  readonly violation?: boolean;
  readonly reset?: boolean;
}

/**
 * What a step's comparison rests on (audit D22): the provider was observed
 * after `mark` (`LiveMedia.pushMark`), and `unchanged` says whether the
 * session stayed as it was read before that observation — live, on the same
 * epoch, at the same state version — until the standing it is compared with
 * had been read.
 */
interface Observation {
  readonly mark: number;
  readonly unchanged: boolean;
}

/**
 * The level-triggered reconciler (live.md §11): Postgres, Communities and
 * identity say what should be; the media provider says what is; this brings
 * the provider in line with the record, on a period, and never the reverse.
 *
 * Three ticks, each on `setInterval(...).unref()` and each single-flight — a
 * tick that finds its previous run still going is skipped, never queued:
 *
 *   rooms          every ROOM_SWEEP_SECONDS: a live session's missing room is
 *                  ensured, then the session re-read (§4.4); `empty_since`
 *                  is kept, and a room empty for IDLE_END_SECONDS ends its
 *                  session `idle`; a room of this deployment's form that no
 *                  live session claims is ended after ORPHAN_GRACE_SECONDS
 *   participants   every PARTICIPANT_SWEEP_SECONDS: per live session, a
 *                  community that no longer lets it run ends it; everyone
 *                  connected, and every holder of the floor or the presenter
 *                  slot connected or not (audit D21), goes through the
 *                  per-identity step
 *   watch          every WATCH_TICK_SECONDS: the per-identity step, through
 *                  `getParticipant`, for whoever lost the floor or the
 *                  presenter slot inside the enforcement window (from
 *                  Postgres, so a restart keeps it), whoever is under
 *                  enforcement here, and whoever's last push did not apply
 *
 * A boot pass runs rooms, participants, then the watch. All work for one
 * session — from any tick, and from `ProtectLiveSessions` — is serialized per
 * session id, and sessions are taken one at a time, so the provider never
 * gets one call per session at once.
 *
 * Never on unknown state (audit D23): every input a step needs is read
 * before it acts, and if any of them — Postgres, Communities'
 * `permittedAmong` and `heads`, identity's `live.speak`, the provider —
 * fails, that session's step (or the whole tick, for the room sweep's pages)
 * is skipped: nobody is ejected, demoted or expired, no session is ended and
 * no room deleted on a guess. An outage is logged once when it starts and
 * once when it ends, never per tick; any other failure by class name only.
 *
 * Metrics are structured log lines with stable names (audit D15):
 * `live.reconciler.provider_unavailable` / `.provider_available`,
 * `.session_skipped`, `.tick_failed`, `.room_ensured`, `.orphan_ended`,
 * `.removed`, `.corrected`, `.violation`, and `live.session.media_reset`.
 * They carry ids, epochs, counts and codes — never a token or a name.
 */
@Injectable()
export class LiveReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LiveReconciler.name);
  /** Every step for one session runs alone (the key is the session id). */
  private readonly perSession = new KeyedMutex();
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly running = new Map<'rooms' | 'participants' | 'watch', Promise<unknown>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly watch = new Map<string, WatchEntry>();
  /** The provider's last known state; an outage is logged when it changes, never per tick. */
  private providerAvailable = true;

  constructor(
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(PRESENTER_GRANT_REPOSITORY) private readonly presenters: PresenterGrantRepository,
    @Inject(RTC_ROOMS) private readonly rooms: RtcRoomProvider,
    @Inject(RTC_PARTICIPANTS) private readonly participants: RtcParticipantControl,
    @Inject(RTC_OBSERVER) private readonly observer: RtcParticipantObserver,
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
    private readonly standing: LiveStanding,
    private readonly media: LiveMedia,
    private readonly occupancy: RoomOccupancy,
    private readonly lifecycle: LiveSessionLifecycle,
    private readonly journal: LiveJournal,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onApplicationBootstrap(): void {
    // The boot pass: after a restart nothing in memory survives, and this
    // re-ensures every live room, ends orphans past their grace, re-checks
    // everyone connected and rebuilds the watch from Postgres (§11.5). It is
    // not awaited, so a slow provider never holds the application's boot.
    void this.track(this.bootPass());
    this.timers.push(
      setInterval(() => void this.sweepRooms(), ROOM_SWEEP_SECONDS * 1000).unref(),
      setInterval(() => void this.sweepParticipants(), PARTICIPANT_SWEEP_SECONDS * 1000).unref(),
      setInterval(() => void this.watchTick(), WATCH_TICK_SECONDS * 1000).unref(),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * Clears the timers and waits for whatever is running — the boot pass
   * included. The ticks and checks can still be called directly afterwards.
   */
  async stop(): Promise<void> {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async bootPass(): Promise<void> {
    await this.sweepRooms();
    await this.sweepParticipants();
    await this.watchTick();
  }

  // ── The ticks ──────────────────────────────────────────────────────────

  /** The room sweep (§11.2; audit D23); single-flight, never throws. */
  sweepRooms(): Promise<RoomSweepReport> {
    return this.singleFlight('rooms', () => this.roomSweep(), emptyRooms);
  }

  /** The participant sweep (§11.3; audit D21, D23); single-flight, never throws. */
  sweepParticipants(): Promise<SessionSweepReport> {
    return this.singleFlight(
      'participants',
      () => this.sessionSweep((session) => this.sweepStep(session)),
      emptySweep,
    );
  }

  /** The targeted watch (§11.4; audit D10, D11); single-flight, never throws. */
  watchTick(): Promise<SessionSweepReport> {
    return this.singleFlight(
      'watch',
      () => this.sessionSweep((session) => this.watchStep(session)),
      emptySweep,
    );
  }

  // ── The per-session steps, for `ProtectLiveSessions` ───────────────────

  /**
   * The per-identity step for these people in one session, now: each is
   * observed through `getParticipant`, their standing read before anyone is
   * touched, and each corrected as the sweep would. Serialized with every other step
   * for the session; never throws.
   */
  checkIdentities(sessionId: string, userIds: readonly string[]): Promise<SessionCheckReport> {
    return this.forSession(sessionId, (session) =>
      this.checkPeople(session, [...new Set(userIds)]),
    );
  }

  /**
   * The participant sweep's step for one session, now: Communities' lifecycle
   * (`heads`), then everyone connected and every holder of the floor or the
   * presenter slot. Serialized with every other step for the session; never
   * throws.
   */
  checkSession(sessionId: string): Promise<SessionCheckReport> {
    return this.forSession(sessionId, (session) => this.sweepStep(session));
  }

  // ── Room sweep ─────────────────────────────────────────────────────────

  private async roomSweep(): Promise<RoomSweepReport> {
    // 1. Every live session, or nothing at all: an incomplete set would make
    //    a live room look orphaned (audit D23). The orphans' grace (step 4) is
    //    measured from this read, not from the end of the sweep: a session
    //    started after it has a room listed below but is not claimed here,
    //    and the grace protects it only while it counts from before its start
    //    — however long the steps between take.
    const readAt = this.clock.now();
    let live: readonly LiveSession[];
    try {
      live = await this.allLiveSessions();
    } catch (error) {
      this.logTickSkipped('rooms', error);
      return emptyRooms('failed');
    }
    // 2. One list of rooms; only this deployment's are ever looked at.
    let listed: readonly RtcRoomObservation[];
    try {
      listed = await this.provider(() => this.rooms.listRooms());
    } catch (error) {
      if (!(error instanceof RtcUnavailableError)) this.logTickSkipped('rooms', error);
      return {
        ...emptyRooms(error instanceof RtcUnavailableError ? 'provider_unavailable' : 'failed'),
        sessions: live.length,
      };
    }
    const prefix = this.settings.roomNamePrefix;
    const ours = new Map(
      listed
        .filter((room) => parseMediaRoomName(prefix, room.roomName) !== null)
        .map((room) => [room.roomName, room]),
    );

    // 3. Each live session's current room.
    let sessionsSkipped = 0;
    let ensured = 0;
    let idleEnded = 0;
    for (const session of live) {
      let step: RoomStep;
      try {
        step = await this.perSession.run(session.id, () =>
          this.roomStep(session, ours.get(currentMediaRoom(prefix, session)) ?? null),
        );
      } catch (error) {
        if (error instanceof RtcUnavailableError) {
          return {
            skipped: 'provider_unavailable',
            sessions: live.length,
            sessionsSkipped,
            ensured,
            idleEnded,
            orphansEnded: 0,
          };
        }
        this.logSkipped('rooms', session.id, error);
        sessionsSkipped += 1;
        continue;
      }
      if (step.ensured) ensured += 1;
      if (step.idleEnded) idleEnded += 1;
    }

    // 4. Orphans: this deployment's rooms no live session claims, past the
    //    grace that protects a start still in flight — old epochs of a reset
    //    session among them.
    const claimed = new Set(live.map((session) => currentMediaRoom(prefix, session)));
    const graceEnds = readAt.getTime() - ORPHAN_GRACE_SECONDS * 1000;
    let orphansEnded = 0;
    for (const room of ours.values()) {
      if (claimed.has(room.roomName) || room.createdAt.getTime() > graceEnds) continue;
      const parsed = parseMediaRoomName(prefix, room.roomName);
      if (parsed === null) continue;
      try {
        await this.perSession.run(parsed.sessionId, () =>
          this.provider(() => this.rooms.endRoom(room.roomName)),
        );
      } catch (error) {
        if (error instanceof RtcUnavailableError) {
          return {
            skipped: 'provider_unavailable',
            sessions: live.length,
            sessionsSkipped,
            ensured,
            idleEnded,
            orphansEnded,
          };
        }
        this.logSkipped('rooms', parsed.sessionId, error);
        continue;
      }
      orphansEnded += 1;
      this.logger.log(
        { event: 'live.reconciler.orphan_ended', sessionId: parsed.sessionId, epoch: parsed.epoch },
        'ended a media room no live session claims',
      );
    }
    return {
      skipped: null,
      sessions: live.length,
      sessionsSkipped,
      ensured,
      idleEnded,
      orphansEnded,
    };
  }

  /**
   * One live session's room, under the session's lock. `observed` is the
   * room as the sweep's one list saw it; null when it was missing.
   */
  private async roomStep(
    listed: LiveSession,
    observed: RtcRoomObservation | null,
  ): Promise<RoomStep> {
    const session = await this.sessions.findById(listed.id);
    // Ended, or moved to a new room by a reset since the list: the room seen
    // is not its current one, and the next sweep looks again.
    if (session === null || !isLive(session) || session.mediaRoomEpoch !== listed.mediaRoomEpoch) {
      return {};
    }
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    const now = this.clock.now();
    let ensured = false;
    if (observed === null) {
      // Ensure-then-recheck (§4.4): an end, or a reset, that committed while
      // the room was being made leaves it nobody's.
      await this.provider(() => this.rooms.ensureRoom(roomSpec(room, session)));
      const after = await this.sessions.findById(session.id);
      if (after === null || !isLive(after) || after.mediaRoomEpoch !== session.mediaRoomEpoch) {
        await this.provider(() => this.rooms.endRoom(room));
        return {};
      }
      this.occupancy.ensured(room);
      ensured = true;
      this.logger.log(
        {
          event: 'live.reconciler.room_ensured',
          sessionId: session.id,
          epoch: session.mediaRoomEpoch,
        },
        'ensured a live session’s missing media room',
      );
    }
    // A missing room counts as observed empty, so a session whose room keeps
    // disappearing still ends idle.
    const empty = observed === null || observed.participantCount === 0;
    const emptySince = session.emptySince;
    if (
      empty &&
      emptySince !== null &&
      now.getTime() - emptySince.getTime() >= IDLE_END_SECONDS * 1000
    ) {
      await this.lifecycle.endBySystem(session.id, 'idle');
      this.forgetSession(session.id);
      this.logger.log(
        { event: 'live.reconciler.session_ended', sessionId: session.id, reason: 'idle' },
        'ended a live session whose room stayed empty',
      );
      return { ensured, idleEnded: true };
    }
    // The repository keeps a date already set; writing only on a change
    // spares a statement per session per tick.
    if (empty && emptySince === null) await this.sessions.markEmpty(session.id, now);
    if (!empty && emptySince !== null) await this.sessions.markEmpty(session.id, null);
    return { ensured };
  }

  // ── Participant sweep and watch ────────────────────────────────────────

  /** Pages every live session, then runs `step` for each, one at a time, under its lock. */
  private async sessionSweep(
    step: (session: LiveSession) => Promise<SessionCheckReport>,
  ): Promise<SessionSweepReport> {
    let live: readonly LiveSession[];
    try {
      live = await this.allLiveSessions();
    } catch (error) {
      this.logTickSkipped('sessions', error);
      return emptySweep('failed');
    }
    // Enforcement entries of sessions no longer live are dropped. (One made
    // meanwhile for a session started after this read would go too: the safe
    // direction — its next breach is a correction, never a violation.)
    const liveIds = new Set<string>(live.map((session) => session.id));
    for (const [key, entry] of this.watch) {
      if (!liveIds.has(entry.sessionId)) this.watch.delete(key);
    }

    let tally = NO_TALLY;
    let sessionsSkipped = 0;
    let ended = 0;
    for (const listed of live) {
      const report = await this.forSession(listed.id, step);
      tally = addTally(tally, report);
      if (report.outcome === 'provider_unavailable') {
        return {
          ...tally,
          skipped: 'provider_unavailable',
          sessions: live.length,
          sessionsSkipped,
          ended,
        };
      }
      if (report.outcome === 'skipped') sessionsSkipped += 1;
      if (report.outcome === 'community_closed') ended += 1;
    }
    return { ...tally, skipped: null, sessions: live.length, sessionsSkipped, ended };
  }

  /** The participant sweep's step for one live session (§11.3), under its lock. */
  private async sweepStep(session: LiveSession): Promise<SessionCheckReport> {
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    // 1. Who is in the room. Only standard identities are people. `session`
    //    was read under the lock just before, and the mark is taken now:
    //    both before the provider is observed.
    const mark = this.media.pushMark();
    const connected = new Map<string, RtcParticipantObservation>();
    for (const participant of await this.provider(() => this.observer.listParticipants(room))) {
      if (participant.standard) connected.set(participant.identity, participant);
    }
    // 2. The community's lifecycle, as Communities reports it.
    const [head] = await this.membership.heads([session.communityId]);
    if (head === undefined || !head.effects.runningLiveContinues) {
      await this.lifecycle.endBySystem(session.id, 'community_closed');
      this.forgetSession(session.id);
      this.logger.log(
        {
          event: 'live.reconciler.session_ended',
          sessionId: session.id,
          reason: 'community_closed',
        },
        'ended a live session its community no longer lets run',
      );
      return { ...NO_TALLY, outcome: 'community_closed' };
    }
    // 3. Everyone connected, and every holder of the floor or the presenter
    //    slot — connected or not (audit D21): a holder who lost standing
    //    through an event that was lost, or that never exists, must not keep
    //    a floor a later join would honour.
    const holders = (await this.requests.granted(session.id)).map((request) => request.userId);
    const presenter = await this.presenters.active(session.id);
    if (presenter !== null) holders.push(presenter.userId);
    const people = [...new Set([...connected.keys(), ...holders])];
    return this.stepAll(session, people, connected, mark);
  }

  /** The targeted watch's step for one live session (§11.4), under its lock. */
  private async watchStep(session: LiveSession): Promise<SessionCheckReport> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - ENFORCEMENT_WATCH_SECONDS * 1000);
    const people = new Set<string>([
      // From Postgres, so the watch survives a restart.
      ...(await this.requests.floorClosedSince(session.id, since)),
      ...(await this.presenters.closedSince(session.id, since)),
    ]);
    for (const [key, entry] of this.watch) {
      if (entry.sessionId !== session.id) continue;
      if (entry.until.getTime() > now.getTime()) people.add(entry.userId);
      else this.watch.delete(key);
    }
    for (const push of this.media.unsettled()) {
      if (push.sessionId === session.id) people.add(push.userId);
    }
    if (people.size === 0) return { ...NO_TALLY, outcome: 'checked' };
    return this.checkPeople(session, [...people]);
  }

  /** Observes each person through `getParticipant`, then runs the per-identity step for all. */
  private async checkPeople(
    session: LiveSession,
    userIds: readonly string[],
  ): Promise<SessionCheckReport> {
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    // `session` was read under the lock before any of this; the mark is taken
    // before the first observation.
    const mark = this.media.pushMark();
    const connected = new Map<string, RtcParticipantObservation>();
    for (const userId of userIds) {
      const participant = await this.provider(() => this.observer.getParticipant(room, userId));
      if (participant !== null && participant.standard) connected.set(userId, participant);
    }
    return this.stepAll(session, userIds, connected, mark);
  }

  /**
   * Reads every person's standing FIRST — in batches of MAX_AUTHORIZE_BATCH,
   * all of them before anyone is touched, so a failure in any batch leaves
   * everyone as they are — then runs the per-identity step for each. A media
   * reset moves everyone to a new room: the rest wait for the next tick.
   *
   * Between the standing and the first step, whether the session changed
   * since it was read before the observation (`Observation`) — read here,
   * before this step's own writes (an expiry, a presenter's close) step the
   * version themselves.
   */
  private async stepAll(
    session: LiveSession,
    userIds: readonly string[],
    connected: ReadonlyMap<string, RtcParticipantObservation>,
    mark: number,
  ): Promise<SessionCheckReport> {
    const standings = new Map<string, AccountStanding>();
    for (let start = 0; start < userIds.length; start += MAX_AUTHORIZE_BATCH) {
      const batch = userIds.slice(start, start + MAX_AUTHORIZE_BATCH);
      for (const [userId, account] of await this.standing.ofAccounts(session, batch)) {
        standings.set(userId, account);
      }
    }
    const observation: Observation = {
      mark,
      unchanged: await this.unchangedSince(session, userIds, connected),
    };
    let tally = NO_TALLY;
    for (const userId of userIds) {
      const account = standings.get(userId);
      // `ofAccounts` answers for every id it is asked about; nothing is
      // decided for one it did not.
      if (account === undefined) continue;
      const outcome = await this.identityStep(
        session,
        userId,
        connected.get(userId) ?? null,
        account,
        observation,
        this.clock.now(),
      );
      tally = {
        checked: tally.checked + 1,
        removed: tally.removed + (outcome.removed === true ? 1 : 0),
        corrected: tally.corrected + (outcome.corrected === true ? 1 : 0),
        pushed: tally.pushed + (outcome.pushed === true ? 1 : 0),
        violations: tally.violations + (outcome.violation === true ? 1 : 0),
        resets: tally.resets + (outcome.reset === true ? 1 : 0),
      };
      if (outcome.reset === true) break;
    }
    return { ...tally, outcome: 'checked' };
  }

  /**
   * Whether the session is still live, on the same epoch and at the same
   * state version as `session`, read before the observation. Every change a
   * moderator can see steps the version (an epoch move does not: compared on
   * its own). Read only when a violation is possible — someone connected is
   * under the watch of an applied correction — so an ordinary tick costs
   * nothing more; otherwise true, and moot.
   */
  private async unchangedSince(
    session: LiveSession,
    userIds: readonly string[],
    connected: ReadonlyMap<string, RtcParticipantObservation>,
  ): Promise<boolean> {
    const now = this.clock.now();
    if (!userIds.some((userId) => connected.has(userId) && this.armed(session.id, userId, now))) {
      return true;
    }
    const current = await this.sessions.findById(session.id);
    return (
      current !== null &&
      isLive(current) &&
      current.mediaRoomEpoch === session.mediaRoomEpoch &&
      current.stateVersion === session.stateVersion
    );
  }

  // ── The per-identity step ──────────────────────────────────────────────

  /**
   * One person, as the record says they should be against what the provider
   * holds (§11.3.4). `observed` is null when they are not connected.
   */
  private async identityStep(
    session: LiveSession,
    userId: string,
    observed: RtcParticipantObservation | null,
    account: AccountStanding,
    observation: Observation,
    now: Date,
  ): Promise<StepOutcome> {
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    this.media.noteObserved(session.id, userId, observed !== null);

    if (!account.eligible) {
      // Their hand expires and their presenter grant closes, together —
      // announced, not audited: the system's bookkeeping, not a moderator's act.
      const expiry = await this.requests.expireIneligible(session.id, userId, now);
      const events: LiveEvent[] = [];
      if (expiry.request !== null) {
        events.push(speakerExpired(session, expiry.request, expiry.stateVersion));
      }
      if (expiry.presenter !== null) {
        events.push(screenShareStopped(session, expiry.presenter, expiry.stateVersion));
      }
      if (events.length > 0) await this.journal.record(null, events);
      if (observed === null) {
        this.media.settle(session.id, userId);
        return {};
      }
      return this.breach(session, userId, observation, now, 'removed', async () => {
        const outcome = await this.provider(() =>
          this.participants.removeParticipant(room, userId, { revokeTokensIssuedBefore: now }),
        );
        // Out of the room, or already gone: nothing of theirs is left to push.
        this.media.settle(session.id, userId);
        return outcome;
      });
    }

    let standing = account.standing;
    if (standing.presenter && !standing.moderator) {
      // The slot is a moderator's: it closes before the capability step.
      const closed = await this.presenters.close({
        sessionId: session.id,
        userId,
        by: null,
        reason: 'ineligible',
        at: now,
        moderation: null,
      });
      if (closed.grant !== null) {
        await this.journal.record(null, [
          screenShareStopped(session, closed.grant, closed.stateVersion),
        ]);
      }
      standing = { ...standing, presenter: false };
    }

    if (observed === null) {
      // Their next join computes their set.
      this.media.settle(session.id, userId);
      return {};
    }
    const desired = capabilitiesFor(standing);
    const drift = capabilityDrift(observed, desired);
    if (drift === 'none') {
      this.media.settle(session.id, userId);
      return {};
    }
    const push = async (): Promise<RtcApplyOutcome> => {
      const outcome = await this.provider(() =>
        this.participants.updateCapabilities(room, userId, desired),
      );
      this.media.noteOutcome(session.id, userId, outcome);
      return outcome;
    };
    if (drift === 'below') {
      // A right not yet applied — a grant made during an outage, say. Never
      // a violation (audit D22).
      await push();
      return { pushed: true };
    }
    return this.breach(session, userId, observation, now, 'corrected', push);
  }

  /**
   * A breach: not eligible and connected, or holding more than the set.
   *
   * With no live enforcement entry, or one whose correction did not report
   * `applied` (a failed push, `not_connected`, an outage): corrected and
   * watched — not a violation (audit D22). Seen again while the entry is
   * live AND its correction applied: a violation — counted, the window
   * extended, corrected again, and the media reset (§11.4).
   *
   * But only on a current observation. The provider is observed first and
   * the standing read after, with no lock shared with moderators' commands:
   * a revoke, a yield or a presenter's close that commits in between — and
   * its own push, which may land before or after the observation — makes
   * the comparison show a breach the person never committed. So a breach
   * counts as a violation only if the session was unchanged from before the
   * observation until the standing was read (`Observation`), and no push of
   * the person's set ran meanwhile (`LiveMedia.pushedSince`): otherwise it is
   * a correction — the full set pushed and the window refreshed, nothing
   * counted and nothing reset. A genuine repeat is counted on the next tick.
   *
   * Communities needs no such guard, and steps no version. A standing lost
   * there is never pushed out of band: the provider moves only through this
   * reconciler, whose steps for a session run one at a time, so an
   * observation taken before the loss shows what the provider still held
   * when the standing was read. The breach is real either way, and the race
   * changes nothing: after an applied correction the person holds what it
   * left them, and more only through a join or a push made on standing they
   * had regained — each checked against Communities when it was made. (Who
   * regains it, joins again and loses it again inside the window is counted
   * — with or without a race: that is the rule above, not an ordering.)
   */
  private async breach(
    session: LiveSession,
    userId: string,
    observation: Observation,
    now: Date,
    kind: 'removed' | 'corrected',
    correct: () => Promise<RtcApplyOutcome>,
  ): Promise<StepOutcome> {
    const violation =
      this.armed(session.id, userId, now) &&
      observation.unchanged &&
      !this.media.pushedSince(session.id, userId, observation.mark);
    const until = new Date(now.getTime() + ENFORCEMENT_WATCH_SECONDS * 1000);
    if (violation) {
      const count = await this.sessions.noteViolation(session.id, now);
      this.logger.warn(
        { event: 'live.reconciler.violation', sessionId: session.id, userId, violations: count },
        'a participant breached their media rights again after a correction applied',
      );
    }
    let outcome: RtcApplyOutcome;
    try {
      outcome = await correct();
    } catch (error) {
      // No answer is not `applied`: a repeat after this is a correction.
      this.remember({ sessionId: session.id, userId, until, applied: false });
      throw error;
    }
    this.remember({ sessionId: session.id, userId, until, applied: outcome === 'applied' });
    this.logger.log(
      {
        event: kind === 'removed' ? 'live.reconciler.removed' : 'live.reconciler.corrected',
        sessionId: session.id,
        userId,
        outcome,
      },
      kind === 'removed'
        ? 'removed a participant no longer eligible to stay'
        : 'pushed a participant’s full media rights over more than they may hold',
    );
    const reset = violation ? await this.resetMedia(session, userId, now) : false;
    return {
      removed: kind === 'removed' && outcome === 'applied',
      corrected: kind === 'corrected' && outcome === 'applied',
      violation,
      reset,
    };
  }

  /**
   * The media reset (§11.4), at most once per violation and exactly once per
   * epoch: the compare-and-set epoch bump with its `reset_media` row decides
   * it — null means another reset, or the end, won — then the new room is
   * ensured and the old one ended. Every token the violator holds names the
   * deleted room; eligible clients follow the provider's room-deleted signal
   * and join again. A provider failure after the bump is left to the room
   * sweep: the new room is ensured as missing, the old one ends as an orphan
   * after its grace. Audited with a null actor; no event.
   *
   * Ensure-then-recheck (§4.4), as join and the room sweep do: an End — which
   * takes no lock of the reconciler's — or another reset that committed while
   * the new room was being made has ended, or will never use, the room this
   * call has just created. The session is read again: unless it is still
   * live on the new epoch, the new room is ended (best effort) and never
   * reported ensured. The old room is ended either way.
   */
  private async resetMedia(session: LiveSession, violator: string, now: Date): Promise<boolean> {
    const action: ModerationAction = {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: session.id,
      actorUserId: null,
      targetUserId: violator,
      type: 'reset_media',
      at: now,
    };
    const moved = await this.sessions.bumpEpoch(session.id, session.mediaRoomEpoch, action);
    if (moved === null) return false;
    const prefix = this.settings.roomNamePrefix;
    const from = currentMediaRoom(prefix, session);
    const to = currentMediaRoom(prefix, moved);
    try {
      await this.provider(() => this.rooms.ensureRoom(roomSpec(to, moved)));
      const after = await this.sessions.findById(session.id);
      if (after !== null && isLive(after) && after.mediaRoomEpoch === moved.mediaRoomEpoch) {
        this.occupancy.ensured(to);
      } else {
        await this.endQuietly(session.id, to);
      }
      await this.provider(() => this.rooms.endRoom(from));
    } catch (error) {
      if (!(error instanceof RtcUnavailableError)) this.logSkipped('reset', session.id, error);
    }
    const detail = { fromEpoch: session.mediaRoomEpoch, toEpoch: moved.mediaRoomEpoch };
    await this.journal.record(
      moderationAudit(action, { communityId: session.communityId, detail }),
      [],
    );
    this.logger.warn(
      {
        event: 'live.session.media_reset',
        sessionId: session.id,
        targetUserId: violator,
        ...detail,
      },
      'reset a live session’s media room after a repeated violation',
    );
    return true;
  }

  /** Ends a room nobody may use, best effort: what is left is the orphan sweep's. */
  private async endQuietly(sessionId: string, roomName: string): Promise<void> {
    try {
      await this.provider(() => this.rooms.endRoom(roomName));
    } catch (error) {
      if (!(error instanceof RtcUnavailableError)) this.logSkipped('reset', sessionId, error);
    }
  }

  // ── Plumbing ───────────────────────────────────────────────────────────

  /**
   * Runs `work` for one session under its lock, on the session as stored
   * now — a reset or an end that committed while it waited is seen — and
   * turns every failure into a report: never throws.
   */
  private forSession(
    sessionId: string,
    work: (session: LiveSession) => Promise<SessionCheckReport>,
  ): Promise<SessionCheckReport> {
    return this.track(
      this.perSession
        .run(sessionId, async () => {
          const session = await this.sessions.findById(sessionId);
          if (session === null || !isLive(session)) {
            this.forgetSession(sessionId);
            return { ...NO_TALLY, outcome: 'not_live' as const };
          }
          return work(session);
        })
        .catch((error: unknown): SessionCheckReport => {
          if (error instanceof RtcUnavailableError) {
            return { ...NO_TALLY, outcome: 'provider_unavailable' };
          }
          this.logSkipped('session', sessionId, error);
          return { ...NO_TALLY, outcome: 'skipped' };
        }),
    );
  }

  /** A tick that never overlaps itself: a second call while one runs is skipped, not queued. */
  private singleFlight<R>(
    tick: 'rooms' | 'participants' | 'watch',
    run: () => Promise<R>,
    skippedReport: (skipped: TickSkip) => R,
  ): Promise<R> {
    if (this.running.has(tick)) return Promise.resolve(skippedReport('in_flight'));
    const running = run()
      .catch((error: unknown) => {
        this.logger.error(
          {
            event: 'live.reconciler.tick_failed',
            tick,
            err: { name: errorName(error) },
          },
          'a reconciler tick failed; the next one starts over',
        );
        return skippedReport('failed');
      })
      .finally(() => {
        this.running.delete(tick);
      });
    this.running.set(tick, running);
    return this.track(running);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work)).catch(() => undefined);
    return work;
  }

  /** Every live session, 100 at a time; a failed page rejects the whole read. */
  private async allLiveSessions(): Promise<readonly LiveSession[]> {
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
  private async provider<T>(call: () => Promise<T>): Promise<T> {
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

  /** Under the watch of a correction that reported `applied`: a breach now may be a violation. */
  private armed(sessionId: string, userId: string, now: Date): boolean {
    const entry = this.watch.get(watchKey(sessionId, userId));
    return entry !== undefined && entry.until.getTime() > now.getTime() && entry.applied;
  }

  private remember(entry: WatchEntry): void {
    const key = watchKey(entry.sessionId, entry.userId);
    this.watch.delete(key);
    this.watch.set(key, entry);
    // The oldest go first. Losing one is the safe direction: the next breach
    // of that identity is a correction, never a violation.
    for (const oldest of this.watch.keys()) {
      if (this.watch.size <= WATCH_ENTRY_LIMIT) break;
      this.watch.delete(oldest);
    }
  }

  /** Drops the enforcement entries of a session that ended. */
  private forgetSession(sessionId: string): void {
    for (const [key, entry] of this.watch) {
      if (entry.sessionId === sessionId) this.watch.delete(key);
    }
  }

  /** A session's step skipped, by the error's class only — never its message. */
  private logSkipped(stage: string, sessionId: string, error: unknown): void {
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
  private logTickSkipped(tick: string, error: unknown): void {
    this.logger.error(
      { event: 'live.reconciler.tick_skipped', tick, err: { name: errorName(error) } },
      'the reconciler could not read what every step needs; the tick did nothing',
    );
  }
}

interface RoomStep {
  readonly ensured?: boolean;
  readonly idleEnded?: boolean;
}

function roomSpec(roomName: string, session: LiveSession): RtcRoomSpec {
  return {
    roomName,
    maxParticipants: session.participantCap + session.moderatorReserve,
    emptyTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
    departureTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
  };
}

function emptyRooms(skipped: TickSkip): RoomSweepReport {
  return { skipped, sessions: 0, sessionsSkipped: 0, ensured: 0, idleEnded: 0, orphansEnded: 0 };
}

function emptySweep(skipped: TickSkip): SessionSweepReport {
  return { ...NO_TALLY, skipped, sessions: 0, sessionsSkipped: 0, ended: 0 };
}

function addTally(a: IdentityTally, b: IdentityTally): IdentityTally {
  return {
    checked: a.checked + b.checked,
    removed: a.removed + b.removed,
    corrected: a.corrected + b.corrected,
    pushed: a.pushed + b.pushed,
    violations: a.violations + b.violations,
    resets: a.resets + b.resets,
  };
}

const watchKey = (sessionId: string, userId: string) => `${sessionId}\u0000${userId}`;

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);
