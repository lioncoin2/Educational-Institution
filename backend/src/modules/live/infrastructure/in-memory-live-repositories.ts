import { Injectable } from '@nestjs/common';

import {
  HANDS_PAGE_MAX,
  LIVE_SESSIONS_PAGE_MAX,
  PENDING_HANDS_COUNT_CAP,
} from '../domain/live-limits';
import {
  endSession,
  isLive,
  liveSessionOrder,
  type LiveSession,
  type LiveSessionKey,
} from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import type {
  EndInput,
  EndOutcome,
  GrantOutcome,
  IneligibleExpiry,
  LiveSessionRepository,
  PresenterCloseInput,
  PresenterCloseOutcome,
  PresenterGrantRepository,
  PresenterOpenOutcome,
  RaiseOutcome,
  SpeakerRequestRepository,
  StartOutcome,
  TransitionInput,
  TransitionOutcome,
} from '../domain/ports';
import { closePresenterGrant, isOpenGrant, type PresenterGrant } from '../domain/presenter-grant';
import {
  isOpen,
  judgeTransition,
  queueOrder,
  transition,
  type QueueKey,
  type SpeakerRequest,
} from '../domain/speaker-request';

/** The moderation rows kept in memory: the newest, for development and tests. */
export const MODERATION_LOG_LIMIT = 10_000;

/**
 * Live in memory — development without a database, and the store the
 * application tests run on. One store, three ports over one state, so a
 * session, its hands and its presenter grant are always read as written.
 *
 * Every method is one critical section: nothing is awaited between its first
 * read and its last write, so on Node's single thread each is atomic, exactly
 * as the Postgres adapter's transaction under the session's row lock is — the
 * same outcomes for the same sequence of calls, races included (mock parity:
 * test/support/live-contract-suite.ts runs against both). Entities are
 * immutable and replaced, never mutated in place.
 */
@Injectable()
export class InMemoryLiveStore {
  private readonly memory = new LiveMemory();
  readonly sessions: LiveSessionRepository = new InMemoryLiveSessions(this.memory);
  readonly requests: SpeakerRequestRepository = new InMemorySpeakerRequests(this.memory);
  readonly presenters: PresenterGrantRepository = new InMemoryPresenterGrants(this.memory);

  /** The moderation rows written for a session, oldest first — what no port reads back. */
  moderationOf(sessionId: string): readonly ModerationAction[] {
    return this.memory.moderation.filter((action) => action.sessionId === sessionId);
  }

  /** Every presenter grant of a session, oldest first, closed ones included. */
  presenterGrantsOf(sessionId: string): readonly PresenterGrant[] {
    return (this.memory.presentersBySession.get(sessionId) ?? []).flatMap((id) => {
      const grant = this.memory.presenterById.get(id);
      return grant === undefined ? [] : [grant];
    });
  }
}

/** The shared state, and the one place its indexes are kept in step with the records. */
class LiveMemory {
  readonly sessionById = new Map<string, LiveSession>();
  /** The partial unique index `(community_id) WHERE state = 'live'` (S1). */
  readonly liveByCommunity = new Map<string, string>();
  readonly requestById = new Map<string, SpeakerRequest>();
  /** The partial unique index `(session_id, user_id) WHERE state IN ('pending', 'granted')` (R1). */
  readonly openByPerson = new Map<string, string>();
  readonly pendingBySession = new Map<string, Set<string>>();
  readonly grantedBySession = new Map<string, Set<string>>();
  /** Requests that ever held the floor, per session — the targeted watch's rows. */
  readonly flooredBySession = new Map<string, Set<string>>();
  readonly presenterById = new Map<string, PresenterGrant>();
  /** The partial unique index `(session_id) WHERE ended_at IS NULL` (P1). */
  readonly openPresenterBySession = new Map<string, string>();
  readonly presentersBySession = new Map<string, string[]>();
  readonly moderation: ModerationAction[] = [];

  session(id: string): LiveSession | null {
    return this.sessionById.get(id) ?? null;
  }

  /** A request's session: it always exists, as the foreign key guarantees. */
  sessionOf(request: SpeakerRequest): LiveSession {
    const session = this.sessionById.get(request.sessionId);
    if (session === undefined) throw new Error('a speaker request without its session');
    return session;
  }

  openRequest(sessionId: string, userId: string): SpeakerRequest | null {
    const id = this.openByPerson.get(pair(sessionId, userId));
    return id === undefined ? null : (this.requestById.get(id) ?? null);
  }

  openPresenter(sessionId: string): PresenterGrant | null {
    const id = this.openPresenterBySession.get(sessionId);
    return id === undefined ? null : (this.presenterById.get(id) ?? null);
  }

  /** The requests one of the per-session indexes names. */
  requestsIn(index: Map<string, Set<string>>, sessionId: string): SpeakerRequest[] {
    return [...(index.get(sessionId) ?? [])].flatMap((id) => {
      const request = this.requestById.get(id);
      return request === undefined ? [] : [request];
    });
  }

  putSession(session: LiveSession): void {
    this.sessionById.set(session.id, session);
    if (isLive(session)) this.liveByCommunity.set(session.communityId, session.id);
    else if (this.liveByCommunity.get(session.communityId) === session.id) {
      this.liveByCommunity.delete(session.communityId);
    }
  }

  /** One version later: the step every observable change takes with it. */
  bump(session: LiveSession): number {
    const stepped = { ...session, stateVersion: session.stateVersion + 1 };
    this.putSession(stepped);
    return stepped.stateVersion;
  }

  putRequest(request: SpeakerRequest): void {
    this.requestById.set(request.id, request);
    const person = pair(request.sessionId, request.userId);
    if (isOpen(request)) this.openByPerson.set(person, request.id);
    else if (this.openByPerson.get(person) === request.id) this.openByPerson.delete(person);
    index(this.pendingBySession, request.sessionId, request.id, request.state === 'pending');
    index(this.grantedBySession, request.sessionId, request.id, request.state === 'granted');
    if (request.grantedAt !== null)
      index(this.flooredBySession, request.sessionId, request.id, true);
  }

  putPresenter(grant: PresenterGrant): void {
    if (!this.presenterById.has(grant.id)) {
      const ids = this.presentersBySession.get(grant.sessionId) ?? [];
      ids.push(grant.id);
      this.presentersBySession.set(grant.sessionId, ids);
    }
    this.presenterById.set(grant.id, grant);
    if (isOpenGrant(grant)) this.openPresenterBySession.set(grant.sessionId, grant.id);
    else if (this.openPresenterBySession.get(grant.sessionId) === grant.id) {
      this.openPresenterBySession.delete(grant.sessionId);
    }
  }

  record(action: ModerationAction): void {
    this.moderation.push(action);
    if (this.moderation.length > MODERATION_LOG_LIMIT) {
      this.moderation.splice(0, this.moderation.length - MODERATION_LOG_LIMIT);
    }
  }
}

class InMemoryLiveSessions implements LiveSessionRepository {
  constructor(private readonly memory: LiveMemory) {}

  async findById(id: string): Promise<LiveSession | null> {
    return this.memory.session(id);
  }

  async findLiveByCommunity(communityId: string): Promise<LiveSession | null> {
    const id = this.memory.liveByCommunity.get(communityId);
    return id === undefined ? null : this.memory.session(id);
  }

  async start(session: LiveSession, moderation: ModerationAction): Promise<StartOutcome> {
    // One live session per community: a running one wins, and nothing is written.
    const runningId = this.memory.liveByCommunity.get(session.communityId);
    const running = runningId === undefined ? null : this.memory.session(runningId);
    if (running !== null) return { created: false, session: running };
    if (!isLive(session)) throw new RangeError('a start stores a live session');
    if (this.memory.sessionById.has(session.id)) throw new Error('duplicate live session id');
    this.memory.putSession(session);
    this.memory.record(moderation);
    return { created: true, session };
  }

  async end(input: EndInput): Promise<EndOutcome | null> {
    const session = this.memory.session(input.sessionId);
    if (session === null) return null;
    if (!isLive(session)) return { ended: false, session };
    const ended = endSession(session, input);
    // Every open hand expires and the presenter grant closes, in the same step
    // (S5): the one `live.session.ended` implies them all.
    const expiring = [
      ...this.memory.requestsIn(this.memory.pendingBySession, session.id),
      ...this.memory.requestsIn(this.memory.grantedBySession, session.id),
    ];
    const presenting = this.memory.openPresenter(session.id);
    this.memory.putSession(ended);
    for (const request of expiring) {
      const expired = transition(request, 'expired', input.at, null);
      if (expired !== null) this.memory.putRequest(expired);
    }
    if (presenting !== null) {
      this.memory.putPresenter(
        closePresenterGrant(presenting, {
          at: input.at,
          by: input.endedBy,
          reason: 'session_ended',
        }),
      );
    }
    this.memory.record(input.moderation);
    return { ended: true, session: ended };
  }

  async listLive(after: LiveSessionKey | null, limit: number): Promise<readonly LiveSession[]> {
    requireLimit('listLive', limit, LIVE_SESSIONS_PAGE_MAX);
    return [...this.memory.liveByCommunity.values()]
      .flatMap((id) => {
        const session = this.memory.session(id);
        return session === null ? [] : [session];
      })
      .filter((session) => after === null || liveSessionOrder(session, after) > 0)
      .sort(liveSessionOrder)
      .slice(0, limit);
  }

  async markEmpty(id: string, emptySince: Date | null): Promise<void> {
    const session = this.memory.session(id);
    if (session === null || !isLive(session)) return;
    // The first observation stands: a repeated mark never restarts the idle clock.
    const next = emptySince === null ? null : (session.emptySince ?? emptySince);
    if (next !== session.emptySince) this.memory.putSession({ ...session, emptySince: next });
  }

  async noteViolation(id: string, at: Date): Promise<number> {
    const session = this.memory.session(id);
    if (session === null || !isLive(session)) return 0;
    const noted = {
      ...session,
      enforcementViolations: session.enforcementViolations + 1,
      lastViolationAt: at,
    };
    this.memory.putSession(noted);
    return noted.enforcementViolations;
  }

  async bumpEpoch(
    id: string,
    expected: number,
    moderation: ModerationAction,
  ): Promise<LiveSession | null> {
    const session = this.memory.session(id);
    if (session === null || !isLive(session) || session.mediaRoomEpoch !== expected) return null;
    const reset = { ...session, mediaRoomEpoch: expected + 1 };
    this.memory.putSession(reset);
    this.memory.record(moderation);
    return reset;
  }
}

class InMemorySpeakerRequests implements SpeakerRequestRepository {
  constructor(private readonly memory: LiveMemory) {}

  async raise(request: SpeakerRequest): Promise<RaiseOutcome> {
    const session = this.memory.session(request.sessionId);
    if (session === null || !isLive(session)) return 'session_not_live';
    const open = this.memory.openRequest(request.sessionId, request.userId);
    if (open !== null) return { created: false, request: open, stateVersion: session.stateVersion };
    if (request.state !== 'pending') throw new RangeError('a raise stores a pending request');
    if (this.memory.requestById.has(request.id)) throw new Error('duplicate speaker request id');
    this.memory.putRequest(request);
    return { created: true, request, stateVersion: this.memory.bump(session) };
  }

  async findById(id: string): Promise<SpeakerRequest | null> {
    return this.memory.requestById.get(id) ?? null;
  }

  async findOpen(sessionId: string, userId: string): Promise<SpeakerRequest | null> {
    return this.memory.openRequest(sessionId, userId);
  }

  async granted(sessionId: string): Promise<readonly SpeakerRequest[]> {
    return this.memory.requestsIn(this.memory.grantedBySession, sessionId).sort(queueOrder);
  }

  async pendingPage(
    sessionId: string,
    after: QueueKey | null,
    limit: number,
  ): Promise<readonly SpeakerRequest[]> {
    requireLimit('pendingPage', limit, HANDS_PAGE_MAX);
    return this.memory
      .requestsIn(this.memory.pendingBySession, sessionId)
      .filter((request) => after === null || queueOrder(request, after) > 0)
      .sort(queueOrder)
      .slice(0, limit);
  }

  async countPending(sessionId: string, cap: number): Promise<number> {
    requireLimit('countPending', cap, PENDING_HANDS_COUNT_CAP);
    return Math.min(this.memory.pendingBySession.get(sessionId)?.size ?? 0, cap);
  }

  async grantWithinCap(input: {
    readonly requestId: string;
    readonly cap: number;
    readonly at: Date;
    readonly by: string;
    readonly moderation: ModerationAction;
  }): Promise<GrantOutcome | null> {
    const request = this.memory.requestById.get(input.requestId);
    if (request === undefined) return null;
    const session = this.memory.sessionOf(request);
    const answer = (kind: GrantOutcome['kind']): GrantOutcome => ({
      kind,
      request,
      stateVersion: session.stateVersion,
    });
    if (request.state === 'granted') return answer('unchanged');
    if (!isLive(session)) return answer('session_not_live');
    if (request.state !== 'pending') return answer('invalid');
    // The cap is counted in the same step as the grant (R2).
    if ((this.memory.grantedBySession.get(request.sessionId)?.size ?? 0) >= input.cap) {
      return answer('slots_full');
    }
    const granted = transition(request, 'granted', input.at, input.by);
    if (granted === null) return answer('invalid');
    this.memory.putRequest(granted);
    this.memory.record(input.moderation);
    return { kind: 'granted', request: granted, stateVersion: this.memory.bump(session) };
  }

  async transition(input: TransitionInput): Promise<TransitionOutcome | null> {
    if (input.to === 'pending' || input.to === 'granted') {
      throw new RangeError(`a transition never moves a request to ${input.to}`);
    }
    if ((input.to === 'expired') !== (input.by === null)) {
      throw new RangeError('a request is decided by a person, except an expiry');
    }
    const request = this.memory.requestById.get(input.requestId);
    if (request === undefined) return null;
    const session = this.memory.sessionOf(request);
    const answer = (kind: TransitionOutcome['kind']): TransitionOutcome => ({
      kind,
      request,
      stateVersion: session.stateVersion,
    });
    if (request.state === input.to) return answer('unchanged');
    if (!isLive(session)) return answer('session_not_live');
    if (
      !input.from.includes(request.state) ||
      judgeTransition(request.state, input.to) !== 'apply'
    ) {
      return answer('invalid');
    }
    const moved = transition(request, input.to, input.at, input.by);
    if (moved === null) return answer('invalid');
    this.memory.putRequest(moved);
    if (input.moderation !== null) this.memory.record(input.moderation);
    return { kind: 'applied', request: moved, stateVersion: this.memory.bump(session) };
  }

  async expireIneligible(sessionId: string, userId: string, at: Date): Promise<IneligibleExpiry> {
    const session = this.memory.session(sessionId);
    if (session === null) return { request: null, presenter: null, stateVersion: 0 };
    const nothing = { request: null, presenter: null, stateVersion: session.stateVersion };
    if (!isLive(session)) return nothing;
    const open = this.memory.openRequest(sessionId, userId);
    const presenting = this.memory.openPresenter(sessionId);
    const expired = open === null ? null : transition(open, 'expired', at, null);
    const closed =
      presenting !== null && presenting.userId === userId
        ? closePresenterGrant(presenting, { at, by: null, reason: 'ineligible' })
        : null;
    if (expired === null && closed === null) return nothing;
    if (expired !== null) this.memory.putRequest(expired);
    if (closed !== null) this.memory.putPresenter(closed);
    return { request: expired, presenter: closed, stateVersion: this.memory.bump(session) };
  }

  async floorClosedSince(sessionId: string, since: Date): Promise<readonly string[]> {
    const lost = this.memory
      .requestsIn(this.memory.flooredBySession, sessionId)
      .filter(
        (request) =>
          request.state !== 'granted' &&
          request.decidedAt !== null &&
          request.decidedAt.getTime() >= since.getTime(),
      )
      .map((request) => request.userId);
    return distinctInOrder(lost);
  }
}

class InMemoryPresenterGrants implements PresenterGrantRepository {
  constructor(private readonly memory: LiveMemory) {}

  async active(sessionId: string): Promise<PresenterGrant | null> {
    return this.memory.openPresenter(sessionId);
  }

  async open(grant: PresenterGrant, moderation: ModerationAction): Promise<PresenterOpenOutcome> {
    const session = this.memory.session(grant.sessionId);
    if (session === null) return { kind: 'session_not_live', grant: null, stateVersion: 0 };
    if (!isLive(session)) {
      return { kind: 'session_not_live', grant: null, stateVersion: session.stateVersion };
    }
    // The open grant is read first, so a repeat and a rival are told apart.
    const holding = this.memory.openPresenter(grant.sessionId);
    if (holding !== null) {
      return {
        kind: holding.userId === grant.userId ? 'held' : 'occupied',
        grant: holding,
        stateVersion: session.stateVersion,
      };
    }
    if (!isOpenGrant(grant)) throw new RangeError('a claim stores an open grant');
    if (this.memory.presenterById.has(grant.id)) throw new Error('duplicate presenter grant id');
    this.memory.putPresenter(grant);
    this.memory.record(moderation);
    return { kind: 'opened', grant, stateVersion: this.memory.bump(session) };
  }

  async close(input: PresenterCloseInput): Promise<PresenterCloseOutcome> {
    const session = this.memory.session(input.sessionId);
    if (session === null) return { grant: null, stateVersion: 0 };
    const holding = this.memory.openPresenter(input.sessionId);
    if (!isLive(session) || holding === null || holding.userId !== input.userId) {
      return { grant: null, stateVersion: session.stateVersion };
    }
    const closed = closePresenterGrant(holding, {
      at: input.at,
      by: input.by,
      reason: input.reason,
    });
    this.memory.putPresenter(closed);
    if (input.moderation !== null) this.memory.record(input.moderation);
    return { grant: closed, stateVersion: this.memory.bump(session) };
  }

  async closedSince(sessionId: string, since: Date): Promise<readonly string[]> {
    const closed = (this.memory.presentersBySession.get(sessionId) ?? [])
      .flatMap((id) => {
        const grant = this.memory.presenterById.get(id);
        return grant === undefined ? [] : [grant];
      })
      .filter((grant) => grant.endedAt !== null && grant.endedAt.getTime() >= since.getTime())
      .map((grant) => grant.userId);
    return distinctInOrder(closed);
  }
}

const pair = (sessionId: string, userId: string) => `${sessionId}\u0000${userId}`;

/** Adds `id` to, or removes it from, `key`'s set — dropping a set once it is empty. */
function index(byKey: Map<string, Set<string>>, key: string, id: string, member: boolean): void {
  const ids = byKey.get(key);
  if (member) {
    if (ids === undefined) byKey.set(key, new Set([id]));
    else ids.add(id);
  } else if (ids !== undefined) {
    ids.delete(id);
    if (ids.size === 0) byKey.delete(key);
  }
}

/** Each id once, in ascending text order — Postgres' order for these ASCII ids. */
function distinctInOrder(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function requireLimit(method: string, limit: number, max: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new RangeError(`${method} takes a whole number from 1 to ${max}`);
  }
}
