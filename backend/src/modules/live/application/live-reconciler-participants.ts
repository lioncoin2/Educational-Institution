import type { Clock } from '../../../shared';
import { MAX_AUTHORIZE_BATCH } from '../../communities/contracts/authorization';
import type { CommunityMembership } from '../../communities/contracts/membership';
import { screenShareStopped, speakerExpired, type LiveEvent } from '../domain/events';
import { isIssuedParticipantIdentity } from '../domain/live-ids';
import { ENFORCEMENT_WATCH_SECONDS } from '../domain/live-limits';
import { currentMediaRoom, isLive, type LiveSession } from '../domain/live-session';
import type {
  LiveSessionRepository,
  PresenterGrantRepository,
  SpeakerRequestRepository,
} from '../domain/ports';
import type {
  RtcApplyOutcome,
  RtcParticipantControl,
  RtcParticipantObservation,
  RtcParticipantObserver,
} from '../domain/rtc-provider';
import { capabilitiesFor, capabilityDrift } from '../domain/standing';
import type { LiveJournal } from './live-journal';
import type { LiveMedia } from './live-media';
import type { LiveSessionLifecycle } from './live-session-lifecycle';
import type { LiveSettings } from './live-settings';
import type { AccountStanding, LiveStanding } from './live-standing';
import type { Enforcement, Observation, StepOutcome } from './live-reconciler-enforcement';
import type { ForeignIdentities } from './live-reconciler-foreign';
import {
  NO_TALLY,
  noStep,
  type SessionCheckReport,
  type SessionStep,
} from './live-reconciler-reports';
import type { ReconcilerRuntime } from './live-reconciler-runtime';
import type { ReconcilerWatch } from './live-reconciler-watch';

/**
 * The reconciler's per-session steps for the people in a session (live.md
 * §11.3, §11.4), each run under the session's lock:
 *
 *   the sweep's    every PARTICIPANT_SWEEP_SECONDS: a community that no
 *                  longer lets the session run ends it; everyone connected,
 *                  and every holder of the floor or the presenter slot
 *                  connected or not (audit D21), goes through the
 *                  per-identity step
 *   the watch's    every WATCH_TICK_SECONDS: the per-identity step, through
 *                  `getParticipant`, for whoever lost the floor or the
 *                  presenter slot inside the enforcement window (from
 *                  Postgres, so a restart keeps it), whoever is under
 *                  enforcement here, and whoever's last push did not apply
 *
 * The per-identity step (§11.3.4) compares what Communities and identity say
 * a person may hold with what the provider holds, and corrects the
 * difference; a breach is `Enforcement`'s. Never on unknown state (audit
 * D23): everyone's standing is read before anyone is touched, and a failure
 * of any input skips the whole session.
 *
 * People are the standard identities this application issued (P7.1: the
 * account id, `isIssuedParticipantIdentity`). Any other standard identity
 * observed — by the sweep's list or the watch's look — is foreign: removed
 * at once, as soon as it is observed, by `ForeignIdentities`, and never
 * put through the per-identity step.
 */
export class ParticipantSteps {
  constructor(
    private readonly runtime: ReconcilerRuntime,
    private readonly watch: ReconcilerWatch,
    private readonly enforcement: Enforcement,
    private readonly foreign: ForeignIdentities,
    private readonly sessions: LiveSessionRepository,
    private readonly requests: SpeakerRequestRepository,
    private readonly presenters: PresenterGrantRepository,
    private readonly participants: RtcParticipantControl,
    private readonly observer: RtcParticipantObserver,
    private readonly membership: CommunityMembership,
    private readonly standing: LiveStanding,
    private readonly media: LiveMedia,
    private readonly lifecycle: LiveSessionLifecycle,
    private readonly journal: LiveJournal,
    private readonly settings: LiveSettings,
    private readonly clock: Clock,
  ) {}

  /** The participant sweep's step for one live session (§11.3), under its lock. */
  async sweepStep(session: LiveSession): Promise<SessionStep> {
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    // 1. Who is in the room. Only standard identities are people, and only
    //    those this application issued: any other is foreign, and removed
    //    now, on its identity alone. `session` was read under the lock just
    //    before, and the mark is taken now: both before the provider is
    //    observed.
    const mark = this.media.pushMark();
    const connected = new Map<string, RtcParticipantObservation>();
    const foreign: string[] = [];
    for (const participant of await this.runtime.provider(() =>
      this.observer.listParticipants(room),
    )) {
      if (!participant.standard) continue;
      if (isIssuedParticipantIdentity(participant.identity)) {
        connected.set(participant.identity, participant);
      } else {
        foreign.push(participant.identity);
      }
    }
    const foreignRemoved = await this.removeForeign(session, room, foreign);
    // 2. The community's lifecycle, as Communities reports it.
    const [head] = await this.membership.heads([session.communityId]);
    if (head === undefined || !head.effects.runningLiveContinues) {
      await this.lifecycle.endBySystem(session.id, 'community_closed');
      this.watch.forget(session.id);
      this.runtime.logger.log(
        {
          event: 'live.reconciler.session_ended',
          sessionId: session.id,
          reason: 'community_closed',
        },
        'ended a live session its community no longer lets run',
      );
      return { report: { ...NO_TALLY, outcome: 'community_closed' }, foreignRemoved };
    }
    // 3. Everyone connected, and every holder of the floor or the presenter
    //    slot — connected or not (audit D21): a holder who lost standing
    //    through an event that was lost, or that never exists, must not keep
    //    a floor a later join would honour.
    const holders = (await this.requests.granted(session.id)).map((request) => request.userId);
    const presenter = await this.presenters.active(session.id);
    if (presenter !== null) holders.push(presenter.userId);
    const people = [...new Set([...connected.keys(), ...holders])];
    return { report: await this.stepAll(session, people, connected, mark), foreignRemoved };
  }

  /** The targeted watch's step for one live session (§11.4), under its lock. */
  async watchStep(session: LiveSession): Promise<SessionStep> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - ENFORCEMENT_WATCH_SECONDS * 1000);
    const identities = new Set<string>([
      // From Postgres, so the watch survives a restart.
      ...(await this.requests.floorClosedSince(session.id, since)),
      ...(await this.presenters.closedSince(session.id, since)),
    ]);
    for (const userId of this.watch.watchedIn(session.id, now)) identities.add(userId);
    for (const push of this.media.unsettled()) {
      if (push.sessionId === session.id) identities.add(push.userId);
    }
    // And every foreign identity removed inside the window: found back in
    // the room, it is removed again (P7.1).
    for (const identity of this.watch.foreignIn(session.id, now)) identities.add(identity);
    if (identities.size === 0) return noStep('checked');
    return this.checkPeople(session, [...identities]);
  }

  /**
   * Observes each identity through `getParticipant`, then runs the
   * per-identity step for every one this application issued. Any other
   * found in the room is foreign, removed before anyone's standing is read.
   */
  async checkPeople(session: LiveSession, identities: readonly string[]): Promise<SessionStep> {
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    // `session` was read under the lock before any of this; the mark is taken
    // before the first observation.
    const mark = this.media.pushMark();
    const people: string[] = [];
    const connected = new Map<string, RtcParticipantObservation>();
    const foreign: string[] = [];
    for (const identity of identities) {
      const participant = await this.runtime.provider(() =>
        this.observer.getParticipant(room, identity),
      );
      if (!isIssuedParticipantIdentity(identity)) {
        if (participant !== null && participant.standard) foreign.push(identity);
        continue;
      }
      people.push(identity);
      if (participant !== null && participant.standard) connected.set(identity, participant);
    }
    const foreignRemoved = await this.removeForeign(session, room, foreign);
    return { report: await this.stepAll(session, people, connected, mark), foreignRemoved };
  }

  /** Removes the foreign identities observed in `room`: how many removals applied. */
  private async removeForeign(
    session: LiveSession,
    room: string,
    foreign: readonly string[],
  ): Promise<number> {
    if (foreign.length === 0) return 0;
    return this.foreign.remove(session, room, foreign, this.clock.now());
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
    if (
      !userIds.some((userId) => connected.has(userId) && this.watch.armed(session.id, userId, now))
    ) {
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
      return this.enforcement.breach(session, userId, observation, now, 'removed', async () => {
        const outcome = await this.runtime.provider(() =>
          this.participants.removeParticipant(room, userId, { revokeTokensIssuedBefore: now }),
        );
        // Out of the room, or already gone: nothing of theirs is left to push.
        this.media.settle(session.id, userId);
        return outcome;
      });
    }

    let standing = account.standing;
    if (standing.presenter && !standing.publishesByRight) {
      // The slot is a moderator's who holds `live.speak` (P6 decision 1): a
      // presenter who is no longer a moderator, or who lost `live.speak`
      // and stays one, has it closed before the capability step. A later
      // `live.speak` restores nothing: presenting again is a new claim.
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
      const outcome = await this.runtime.provider(() =>
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
    return this.enforcement.breach(session, userId, observation, now, 'corrected', push);
  }
}
