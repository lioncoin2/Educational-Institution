import type { LiveRoom, LiveRoomId, LiveSession, LiveSessionId } from '../domain/live-room';
import type { ModerationAction } from '../domain/moderation';
import type {
  GrantOutcome,
  LiveRoomRepository,
  LiveSessionRepository,
  RaiseOutcome,
  SpeakerRequestRepository,
  TransitionOutcome,
} from '../domain/ports';
import {
  isOpen,
  judgeTransition,
  transition,
  type SpeakerRequest,
  type SpeakerRequestState,
} from '../domain/speaker-request';

/**
 * In-memory adapters — the live module has no Postgres adapter until
 * community-scoped sessions land (P6), and implements the same ports.
 *
 * Every write below is synchronous from its first read to its last write:
 * there is no `await` in between, so in a single Node process each call is
 * atomic, exactly as the Postgres adapter will be under the session row lock.
 */
export class InMemoryLiveRoomRepository implements LiveRoomRepository {
  private readonly rooms = new Map<string, LiveRoom>();

  constructor(seed: readonly LiveRoom[] = []) {
    for (const room of seed) this.rooms.set(room.id, room);
  }

  async findById(id: LiveRoomId): Promise<LiveRoom | null> {
    return this.rooms.get(id) ?? null;
  }

  async save(room: LiveRoom): Promise<void> {
    this.rooms.set(room.id, room);
  }
}

export class InMemoryLiveSessionRepository implements LiveSessionRepository {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(seed: readonly LiveSession[] = []) {
    for (const session of seed) this.sessions.set(session.id, session);
  }

  async findById(id: LiveSessionId): Promise<LiveSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async save(session: LiveSession): Promise<void> {
    this.sessions.set(session.id, session);
  }
}

export class InMemorySpeakerRequestRepository implements SpeakerRequestRepository {
  private readonly byId = new Map<string, SpeakerRequest>();
  /** `${sessionId}\u0000${userId}` → the open request's id. */
  private readonly openByPerson = new Map<string, string>();
  /** sessionId → ids of its granted requests. */
  private readonly grantedBySession = new Map<string, Set<string>>();
  /** Live's own record of moderation, written with each change. */
  readonly moderation: ModerationAction[] = [];

  constructor(seed: readonly SpeakerRequest[] = []) {
    for (const request of seed) this.store(request);
  }

  async raise(request: SpeakerRequest): Promise<RaiseOutcome> {
    const existing = this.openFor(request.sessionId, request.userId);
    if (existing !== null) return { created: false, request: existing };
    this.store(request);
    return { created: true, request };
  }

  async findById(id: string): Promise<SpeakerRequest | null> {
    return this.byId.get(id) ?? null;
  }

  async findOpen(sessionId: string, userId: string): Promise<SpeakerRequest | null> {
    return this.openFor(sessionId, userId);
  }

  async granted(sessionId: string): Promise<readonly SpeakerRequest[]> {
    return [...(this.grantedBySession.get(sessionId) ?? [])].map(
      (id) => this.byId.get(id) as SpeakerRequest,
    );
  }

  async grantWithinCap(input: {
    readonly requestId: string;
    readonly cap: number;
    readonly at: Date;
    readonly by: string;
    readonly moderation: ModerationAction;
  }): Promise<GrantOutcome | null> {
    const request = this.byId.get(input.requestId);
    if (request === undefined) return null;
    const verdict = judgeTransition(request.state, 'granted');
    if (verdict === 'unchanged') return { kind: 'unchanged', request };
    if (verdict === 'invalid') return { kind: 'invalid', request };
    if ((this.grantedBySession.get(request.sessionId)?.size ?? 0) >= input.cap) {
      return { kind: 'slots_full', request };
    }
    const granted = transition(request, 'granted', input.at, input.by) as SpeakerRequest;
    this.store(granted);
    this.moderation.push(input.moderation);
    return { kind: 'granted', request: granted };
  }

  async transition(input: {
    readonly requestId: string;
    readonly from: readonly SpeakerRequestState[];
    readonly to: SpeakerRequestState;
    readonly at: Date;
    readonly by: string;
    readonly moderation: ModerationAction | null;
  }): Promise<TransitionOutcome | null> {
    const request = this.byId.get(input.requestId);
    if (request === undefined) return null;
    if (request.state === input.to) return { kind: 'unchanged', request };
    if (
      !input.from.includes(request.state) ||
      judgeTransition(request.state, input.to) !== 'apply'
    ) {
      return { kind: 'invalid', request };
    }
    const moved = transition(request, input.to, input.at, input.by) as SpeakerRequest;
    this.store(moved);
    if (input.moderation !== null) this.moderation.push(input.moderation);
    return { kind: 'applied', request: moved };
  }

  private openFor(sessionId: string, userId: string): SpeakerRequest | null {
    const id = this.openByPerson.get(personKey(sessionId, userId));
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  /** Keeps the indexes in step with the stored request. */
  private store(request: SpeakerRequest): void {
    this.byId.set(request.id, request);
    const key = personKey(request.sessionId, request.userId);
    if (isOpen(request)) this.openByPerson.set(key, request.id);
    else if (this.openByPerson.get(key) === request.id) this.openByPerson.delete(key);

    const granted = this.grantedBySession.get(request.sessionId) ?? new Set<string>();
    if (request.state === 'granted') granted.add(request.id);
    else granted.delete(request.id);
    this.grantedBySession.set(request.sessionId, granted);
  }
}

function personKey(sessionId: string, userId: string): string {
  return `${sessionId}\u0000${userId}`;
}
