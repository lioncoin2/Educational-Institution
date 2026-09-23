import type { Id } from '../../../shared';

export type LiveRoomId = Id<'LiveRoom'>;
export type LiveSessionId = Id<'LiveSession'>;

/**
 * A durable place where a class meets — the teaching counterpart of a halaqa.
 * It outlives any single broadcast.
 */
export interface LiveRoom {
  readonly id: LiveRoomId;
  /** The halaqa this room serves. Live does not own halaqat; it references one. */
  readonly halaqaId: string;
  readonly title: string;
  readonly hostUserId: string;
  readonly maxParticipants: number;
  readonly createdAt: Date;
}

export type LiveSessionState = 'scheduled' | 'live' | 'ended';

/** One actual broadcast of a room, and the unit attendance is tied to. */
export interface LiveSession {
  readonly id: LiveSessionId;
  readonly roomId: LiveRoomId;
  readonly state: LiveSessionState;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

export function isJoinable(session: LiveSession): boolean {
  return session.state === 'live';
}
