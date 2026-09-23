import type { LiveRoom, LiveRoomId, LiveSession, LiveSessionId } from './live-room';
import type { ModerationAction } from './moderation';
import type { SpeakerRequest } from './speaker-request';

export interface LiveRoomRepository {
  findById(id: LiveRoomId): Promise<LiveRoom | null>;
  save(room: LiveRoom): Promise<void>;
}

export interface LiveSessionRepository {
  findById(id: LiveSessionId): Promise<LiveSession | null>;
  save(session: LiveSession): Promise<void>;
}

/**
 * The raise-hand queue.
 *
 * Reads are hot (the host polls or subscribes while hundreds of hands move), so
 * the adapter is expected to keep the live queue in Redis and the durable record
 * in Postgres. The port hides that split — see docs/architecture/realtime.md.
 */
export interface SpeakerRequestRepository {
  findBySession(sessionId: string): Promise<readonly SpeakerRequest[]>;
  findById(id: string): Promise<SpeakerRequest | null>;
  save(request: SpeakerRequest): Promise<void>;
}

export interface ModerationLog {
  record(action: ModerationAction): Promise<void>;
}

export const LIVE_ROOM_REPOSITORY = Symbol('LIVE_ROOM_REPOSITORY');
export const LIVE_SESSION_REPOSITORY = Symbol('LIVE_SESSION_REPOSITORY');
export const SPEAKER_REQUEST_REPOSITORY = Symbol('SPEAKER_REQUEST_REPOSITORY');
export const MODERATION_LOG = Symbol('MODERATION_LOG');
