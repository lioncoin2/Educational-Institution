import type { Clock } from '../../../shared';
import { MAX_AUTHORIZE_BATCH } from '../../communities/contracts/authorization';
import type { CommunityMembership } from '../../communities/contracts/membership';
import { screenShareStopped, speakerExpired, type LiveEvent } from '../domain/events';
import { baseAccountOf, isIssuedParticipantIdentity } from '../domain/live-ids';
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
import {
  breachedThrough,
  foreignAccounts,
  type ForeignIdentities,
  type ForeignSighting,
} from './live-reconciler-foreign';
import { NO_TALLY, noStep, type IdentityTally, type SessionStep } from './live-reconciler-reports';
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
 * put through the per-identity step. What it counts for is its account's
 * (P7.2 decision R1): the account whose token made it — the id before `#` —
 * is read with the people, and one that may not hold what the identity held
 * has breached: its first breaching sighting arms it, its reappearance under
 * any suffix is a violation (`Enforcement`), armed apart from its own
 * identity's corrections (`ReconcilerWatch`). While anything is watched in a
 * session — someone under enforcement, or a foreign identity — the watch
 * lists the room rather than looking names up: a client may come back under
 * any suffix, and the account behind each foreign identity it finds is
 * checked in the same step.
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
    //    before; who held what, and the mark, are taken now: all before the
    //    provider is observed.
    const before = await this.rightsBefore(session);
    const mark = this.media.pushMark();
    const connected = new Map<string, RtcParticipantObservation>();
    const foreign: RtcParticipantObservation[] = [];
    for (const participant of await this.runtime.provider(() =>
      this.observer.listParticipants(room),
    )) {
      if (!participant.standard) continue;
      if (isIssuedParticipantIdentity(participant.identity)) {
        connected.set(participant.identity, participant);
      } else {
        foreign.push(participant);
      }
    }
    const sightings = await this.removeForeign(session, room, foreign, { mark, before });
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
      return {
        report: { ...NO_TALLY, outcome: 'community_closed' },
        foreignRemoved: removedOf(sightings),
        foreignBreaches: 0,
      };
    }
    // 3. Everyone connected, and every holder of the floor or the presenter
    //    slot — connected or not (audit D21): a holder who lost standing
    //    through an event that was lost, or that never exists, must not keep
    //    a floor a later join would honour.
    const holders = (await this.requests.granted(session.id)).map((request) => request.userId);
    const presenter = await this.presenters.active(session.id);
    if (presenter !== null) holders.push(presenter.userId);
    const people = [...new Set([...connected.keys(), ...holders])];
    return this.stepAll(session, people, connected, { mark, before }, sightings);
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
   * Observes each identity, then runs the per-identity step for every one
   * this application issued. Any foreign identity found in the room is
   * removed before anyone's standing is read. Each is looked up through
   * `getParticipant` — unless anything is watched in the session (someone
   * under enforcement, or a foreign identity): then the room is listed once,
   * so every foreign identity in it is found, under whatever suffix a client
   * came back with (R1), and the account behind each is checked in the same
   * step, its own identity with them — one sighting.
   */
  async checkPeople(session: LiveSession, identities: readonly string[]): Promise<SessionStep> {
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    // `session` was read under the lock before any of this; who held what,
    // and the mark, are taken before the first observation.
    const before = await this.rightsBefore(session);
    const mark = this.media.pushMark();
    let people = identities.filter(isIssuedParticipantIdentity);
    const connected = new Map<string, RtcParticipantObservation>();
    const foreign: RtcParticipantObservation[] = [];
    if (this.watch.anyIn(session.id, this.clock.now())) {
      const listed = (
        await this.runtime.provider(() => this.observer.listParticipants(room))
      ).filter((participant) => participant.standard);
      for (const participant of listed) {
        if (!isIssuedParticipantIdentity(participant.identity)) foreign.push(participant);
      }
      const wanted = new Set([
        ...people,
        ...foreign.flatMap((participant) => baseAccountOf(participant.identity) ?? []),
      ]);
      for (const participant of listed) {
        if (wanted.has(participant.identity)) connected.set(participant.identity, participant);
      }
      people = [...wanted];
    } else {
      for (const identity of identities) {
        const participant = await this.runtime.provider(() =>
          this.observer.getParticipant(room, identity),
        );
        if (participant === null || !participant.standard) continue;
        if (isIssuedParticipantIdentity(identity)) connected.set(identity, participant);
        else foreign.push(participant);
      }
    }
    const sightings = await this.removeForeign(session, room, foreign, { mark, before });
    return this.stepAll(session, people, connected, { mark, before }, sightings);
  }

  /**
   * Who held the floor and the presenter slot as the step began — read only
   * when anything is watched in the session, the only time a step can find
   * a violation (`Observation`); otherwise null, and moot.
   */
  private async rightsBefore(session: LiveSession): Promise<HeldRights | null> {
    if (!this.watch.anyIn(session.id, this.clock.now())) return null;
    return this.rightsOf(session);
  }

  private async rightsOf(session: LiveSession): Promise<HeldRights> {
    const floor = new Set((await this.requests.granted(session.id)).map((r) => r.userId));
    return { floor, presenter: (await this.presenters.active(session.id))?.userId ?? null };
  }

  /**
   * Removes the foreign identities observed in `room`: what each removal came
   * to. Should any removal fail, what was seen is counted first — each
   * account's breach decided on its standing, which no provider failure
   * touches — and then the failure ends the step, as any failure does.
   */
  private async removeForeign(
    session: LiveSession,
    room: string,
    foreign: readonly RtcParticipantObservation[],
    taken: Taken,
  ): Promise<readonly ForeignSighting[]> {
    if (foreign.length === 0) return [];
    const { sightings, failure } = await this.foreign.remove(
      session,
      room,
      foreign,
      this.clock.now(),
    );
    if (failure !== null) {
      await this.stepAll(session, [], new Map(), taken, sightings);
      throw failure.error;
    }
    return sightings;
  }

  /**
   * Reads every standing FIRST — the people's, and the accounts' behind the
   * foreign identities removed — in batches of MAX_AUTHORIZE_BATCH, all of
   * them before anyone is touched, so a failure in any batch leaves everyone
   * as they are. Then the per-identity step for each person, then each such
   * account's breach, if it breached (R1). A media reset moves everyone to a
   * new room: the rest wait for the next tick.
   *
   * Whether an earlier sighting had armed each such account is taken as the
   * step begins: two of its identities seen in one step are one sighting,
   * never a breach and its own repeat.
   *
   * Between the standing and the first step, what raced the observation
   * (`Observation`) — read here, before this step's own writes (an expiry, a
   * presenter's close) change who holds what themselves.
   */
  private async stepAll(
    session: LiveSession,
    userIds: readonly string[],
    connected: ReadonlyMap<string, RtcParticipantObservation>,
    taken: Taken,
    sightings: readonly ForeignSighting[],
  ): Promise<SessionStep> {
    const began = this.clock.now();
    const accounts = foreignAccounts(sightings).map((account) => ({
      ...account,
      armedBefore: this.watch.foreignArmed(session.id, account.userId, began),
    }));
    const everyone = [...new Set([...userIds, ...accounts.map((account) => account.userId)])];
    const standings = new Map<string, AccountStanding>();
    for (let start = 0; start < everyone.length; start += MAX_AUTHORIZE_BATCH) {
      const batch = everyone.slice(start, start + MAX_AUTHORIZE_BATCH);
      for (const [userId, account] of await this.standing.ofAccounts(session, batch)) {
        standings.set(userId, account);
      }
    }
    const observation: Observation = {
      mark: taken.mark,
      raced: await this.racedSince(session, taken.before),
    };
    const step = (tally: IdentityTally, foreignBreaches: number): SessionStep => ({
      report: { ...tally, outcome: 'checked' },
      foreignRemoved: removedOf(sightings),
      foreignBreaches,
    });

    // The accounts behind foreign identities first: deciding what their
    // sightings count for asks the provider nothing (short of a reset), so no
    // failure of a person's step below can lose them.
    let tally = NO_TALLY;
    let foreignBreaches = 0;
    for (const account of accounts) {
      const standing = standings.get(account.userId);
      if (standing === undefined || !breachedThrough(account, standing)) continue;
      foreignBreaches += 1;
      const outcome = await this.enforcement.foreignBreach(
        session,
        account.userId,
        observation,
        this.clock.now(),
        account.armedBefore,
        account.applied,
      );
      tally = counted(tally, outcome, false);
      if (outcome.reset === true) return step(tally, foreignBreaches);
    }

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
      tally = counted(tally, outcome, true);
      if (outcome.reset === true) break;
    }
    return step(tally, foreignBreaches);
  }

  /**
   * For each person, whether their observation may be stale (`Observation`):
   * the session is no longer live on the epoch `session` was read at, or they
   * held the floor or the presenter slot as the step began (`before`) and no
   * longer do. Nobody else's change counts: it changes nothing they hold.
   * Read only when something is watched in the session (`before` taken) —
   * the only time a violation is possible — so an ordinary tick costs
   * nothing more; otherwise nobody raced, and it is moot.
   */
  private async racedSince(
    session: LiveSession,
    before: HeldRights | null,
  ): Promise<(userId: string) => boolean> {
    if (before === null) return () => false;
    const current = await this.sessions.findById(session.id);
    if (current === null || !isLive(current) || current.mediaRoomEpoch !== session.mediaRoomEpoch) {
      return () => true;
    }
    const after = await this.rightsOf(session);
    return (userId) =>
      (before.floor.has(userId) && !after.floor.has(userId)) ||
      (before.presenter === userId && after.presenter !== userId);
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
    // The person's set, read afresh and pushed in turn with any moderator's
    // push of theirs (`LiveMedia.pushNow`): a correction never lands an older
    // set over a newer one.
    const push = async (): Promise<RtcApplyOutcome> => {
      const outcome = await this.runtime.provider(() => this.media.pushNow(session, userId));
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

/** How many of the foreign identities' removals applied. */
const removedOf = (sightings: readonly ForeignSighting[]) =>
  sightings.filter((sighting) => sighting.applied).length;

/** The tally with one step's outcome added — a person's (`checked`), or an account's breach. */
function counted(tally: IdentityTally, outcome: StepOutcome, checked: boolean): IdentityTally {
  return {
    checked: tally.checked + (checked ? 1 : 0),
    removed: tally.removed + (outcome.removed === true ? 1 : 0),
    corrected: tally.corrected + (outcome.corrected === true ? 1 : 0),
    pushed: tally.pushed + (outcome.pushed === true ? 1 : 0),
    violations: tally.violations + (outcome.violation === true ? 1 : 0),
    resets: tally.resets + (outcome.reset === true ? 1 : 0),
  };
}

/** Who held the floor, and the presenter slot, at one moment of a step. */
interface HeldRights {
  readonly floor: ReadonlySet<string>;
  readonly presenter: string | null;
}

/** What a step takes before it observes the provider: the push mark, and who held what. */
interface Taken {
  readonly mark: number;
  readonly before: HeldRights | null;
}
