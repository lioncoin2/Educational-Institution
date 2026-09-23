import type { LiveRoom, LiveRoomId, LiveSession, LiveSessionId } from '../domain/live-room';
import type { ModerationAction } from '../domain/moderation';
import type {
  LiveRoomRepository,
  LiveSessionRepository,
  ModerationLog,
  SpeakerRequestRepository,
} from '../domain/ports';
import type { SpeakerRequest } from '../domain/speaker-request';

/**
 * Foundation adapters.
 *
 * The Postgres/Drizzle and Redis adapters slot in behind the same ports; these
 * keep the module runnable and fully testable until they do.
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
  private readonly requests = new Map<string, SpeakerRequest>();

  async findBySession(sessionId: string): Promise<readonly SpeakerRequest[]> {
    return [...this.requests.values()].filter((request) => request.sessionId === sessionId);
  }

  async findById(id: string): Promise<SpeakerRequest | null> {
    return this.requests.get(id) ?? null;
  }

  async save(request: SpeakerRequest): Promise<void> {
    this.requests.set(request.id, request);
  }
}

export class InMemoryModerationLog implements ModerationLog {
  readonly actions: ModerationAction[] = [];

  async record(action: ModerationAction): Promise<void> {
    this.actions.push(action);
  }
}
