import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../../../shared';
import {
  COMMUNITY_MEMBERSHIP,
  type CommunityMembership,
} from '../../communities/contracts/membership';
import {
  PARTICIPANT_SWEEP_SECONDS,
  ROOM_SWEEP_SECONDS,
  WATCH_TICK_SECONDS,
} from '../domain/live-limits';
import { isLive, type LiveSession } from '../domain/live-session';
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
  type RtcParticipantControl,
  type RtcParticipantObserver,
  type RtcRoomProvider,
} from '../domain/rtc-provider';
import { LiveJournal } from './live-journal';
import { LiveMedia } from './live-media';
import { LiveMediaReadiness } from './live-media-readiness';
import { Enforcement } from './live-reconciler-enforcement';
import { ForeignIdentities } from './live-reconciler-foreign';
import { ParticipantSteps } from './live-reconciler-participants';
import {
  NO_TALLY,
  addTally,
  emptyRooms,
  emptySweep,
  noStep,
  type RoomSweepReport,
  type SessionCheckReport,
  type SessionStep,
  type SessionSweepReport,
  type TickSkip,
} from './live-reconciler-reports';
import { RoomSweep } from './live-reconciler-rooms';
import { ReconcilerRuntime, errorName } from './live-reconciler-runtime';
import { ReconcilerWatch } from './live-reconciler-watch';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { LIVE_SETTINGS, type LiveSettings } from './live-settings';
import { LiveStanding } from './live-standing';
import { RoomOccupancy } from './room-occupancy';

export type {
  IdentityTally,
  RoomSweepReport,
  SessionCheckReport,
  SessionSweepReport,
  TickSkip,
} from './live-reconciler-reports';
export { WATCH_ENTRY_LIMIT } from './live-reconciler-watch';

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
 * Identities (P7.1): the application issues one media identity per
 * account, the account id. A standard participant with any other identity
 * — a client's `<account id>#<anything>` — is foreign: removed at once
 * wherever it is observed and looked for again by the watch; never put to
 * Communities or identity, never a violation and never a reset. The
 * participant sweep's and the watch's reports count the removals.
 *
 * Metrics are structured log lines with stable names (audit D15):
 * `live.reconciler.provider_unavailable` / `.provider_available`,
 * `.session_skipped`, `.tick_failed`, `.room_ensured`, `.orphan_ended`,
 * `.removed`, `.corrected`, `.violation`, `.foreign_identity_removed`, and
 * `live.session.media_reset`. They carry ids, epochs, counts and codes —
 * never a token, a name, or an identity a client chose.
 *
 * This class is the reconciler's lifecycle: the timers, the boot pass, the
 * single-flight ticks, the paging of live sessions and the per-session
 * serialization. The work is its parts', one responsibility each, all
 * sharing one `ReconcilerRuntime` and one `ReconcilerWatch`:
 *
 *   RoomSweep           the room sweep (§11.2), which also refreshes the
 *                       provider's readiness for Start (P7.1)
 *   ParticipantSteps    the sweep's and the watch's per-session steps, and
 *                       the per-identity step (§11.3, §11.4)
 *   Enforcement         a breach: the correction watched, a violation
 *                       counted, the media reset (§11.4)
 *   ForeignIdentities   the identities it never issued, removed (P7.1)
 */
@Injectable()
export class LiveReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly runtime: ReconcilerRuntime;
  private readonly watch = new ReconcilerWatch();
  private readonly roomSweep: RoomSweep;
  private readonly steps: ParticipantSteps;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly running = new Map<'rooms' | 'participants' | 'watch', Promise<unknown>>();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) requests: SpeakerRequestRepository,
    @Inject(PRESENTER_GRANT_REPOSITORY) presenters: PresenterGrantRepository,
    @Inject(RTC_ROOMS) rooms: RtcRoomProvider,
    @Inject(RTC_PARTICIPANTS) participants: RtcParticipantControl,
    @Inject(RTC_OBSERVER) observer: RtcParticipantObserver,
    @Inject(COMMUNITY_MEMBERSHIP) membership: CommunityMembership,
    standing: LiveStanding,
    media: LiveMedia,
    occupancy: RoomOccupancy,
    lifecycle: LiveSessionLifecycle,
    journal: LiveJournal,
    @Inject(LIVE_SETTINGS) settings: LiveSettings,
    @Inject(CLOCK) clock: Clock,
    @Inject(ID_GENERATOR) ids: IdGenerator,
    readiness: LiveMediaReadiness,
  ) {
    this.runtime = new ReconcilerRuntime(new Logger(LiveReconciler.name), sessions);
    const enforcement = new Enforcement(
      this.runtime,
      this.watch,
      sessions,
      rooms,
      occupancy,
      media,
      journal,
      settings,
      ids,
    );
    this.roomSweep = new RoomSweep(
      this.runtime,
      this.watch,
      sessions,
      rooms,
      occupancy,
      lifecycle,
      settings,
      clock,
      readiness,
    );
    this.steps = new ParticipantSteps(
      this.runtime,
      this.watch,
      enforcement,
      new ForeignIdentities(this.runtime, this.watch, participants),
      sessions,
      requests,
      presenters,
      participants,
      observer,
      membership,
      standing,
      media,
      lifecycle,
      journal,
      settings,
      clock,
    );
  }

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
    return this.singleFlight('rooms', () => this.roomSweep.run(), emptyRooms);
  }

  /** The participant sweep (§11.3; audit D21, D23); single-flight, never throws. */
  sweepParticipants(): Promise<SessionSweepReport> {
    return this.singleFlight(
      'participants',
      () => this.sessionSweep((session) => this.steps.sweepStep(session)),
      emptySweep,
    );
  }

  /** The targeted watch (§11.4; audit D10, D11); single-flight, never throws. */
  watchTick(): Promise<SessionSweepReport> {
    return this.singleFlight(
      'watch',
      () => this.sessionSweep((session) => this.steps.watchStep(session)),
      emptySweep,
    );
  }

  // ── The per-session steps, for `ProtectLiveSessions` ───────────────────

  /**
   * The per-identity step for these people in one session, now: each is
   * observed through `getParticipant`, their standing read before anyone is
   * touched, and each corrected as the sweep would. Serialized with every other step
   * for the session; never throws. An identity named here that this
   * application never issues is only looked for — and removed if found.
   */
  checkIdentities(sessionId: string, userIds: readonly string[]): Promise<SessionCheckReport> {
    return this.forSession(sessionId, (session) =>
      this.steps.checkPeople(session, [...new Set(userIds)]),
    ).then((step) => step.report);
  }

  /**
   * The participant sweep's step for one session, now: Communities' lifecycle
   * (`heads`), then everyone connected and every holder of the floor or the
   * presenter slot. Serialized with every other step for the session; never
   * throws.
   */
  checkSession(sessionId: string): Promise<SessionCheckReport> {
    return this.forSession(sessionId, (session) => this.steps.sweepStep(session)).then(
      (step) => step.report,
    );
  }

  // ── Plumbing ───────────────────────────────────────────────────────────

  /** Pages every live session, then runs `step` for each, one at a time, under its lock. */
  private async sessionSweep(
    step: (session: LiveSession) => Promise<SessionStep>,
  ): Promise<SessionSweepReport> {
    let live: readonly LiveSession[];
    try {
      live = await this.runtime.allLiveSessions();
    } catch (error) {
      this.runtime.logTickSkipped('sessions', error);
      return emptySweep('failed');
    }
    // Watch entries of sessions no longer live are dropped, foreign
    // identities' too. (One made meanwhile for a session started after this
    // read would go as well: the safe direction — its next breach is a
    // correction, never a violation, and the next sweep lists the room.)
    this.watch.keepOnly(new Set<string>(live.map((session) => session.id)));

    let tally = NO_TALLY;
    let sessionsSkipped = 0;
    let ended = 0;
    let foreignRemoved = 0;
    for (const listed of live) {
      const { report, foreignRemoved: foreign } = await this.forSession(listed.id, step);
      tally = addTally(tally, report);
      foreignRemoved += foreign;
      if (report.outcome === 'provider_unavailable') {
        return {
          ...tally,
          skipped: 'provider_unavailable',
          sessions: live.length,
          sessionsSkipped,
          ended,
          foreignRemoved,
        };
      }
      if (report.outcome === 'skipped') sessionsSkipped += 1;
      if (report.outcome === 'community_closed') ended += 1;
    }
    return {
      ...tally,
      skipped: null,
      sessions: live.length,
      sessionsSkipped,
      ended,
      foreignRemoved,
    };
  }

  /**
   * Runs `work` for one session under its lock, on the session as stored
   * now — a reset or an end that committed while it waited is seen — and
   * turns every failure into a report: never throws.
   */
  private forSession(
    sessionId: string,
    work: (session: LiveSession) => Promise<SessionStep>,
  ): Promise<SessionStep> {
    return this.track(
      this.runtime.perSession
        .run(sessionId, async () => {
          const session = await this.sessions.findById(sessionId);
          if (session === null || !isLive(session)) {
            this.watch.forget(sessionId);
            return noStep('not_live');
          }
          return work(session);
        })
        .catch((error: unknown): SessionStep => {
          if (error instanceof RtcUnavailableError) return noStep('provider_unavailable');
          this.runtime.logSkipped('session', sessionId, error);
          return noStep('skipped');
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
        this.runtime.logger.error(
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
}
