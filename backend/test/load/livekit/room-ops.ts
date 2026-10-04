/**
 * P8.4 — the controller's RoomService port and its LiveKit implementation
 * (design §2, §7, §12). Only the controller holds this: workers and agents have
 * no RoomService credential at all, so no shard can delete the shared room.
 * Unlike the P8.3 helpers, errors are SURFACED, never swallowed — an
 * unverifiable room operation must fail the rung, not pass silently.
 */
import { ParticipantInfo_State, type RoomServiceClient, TrackType } from 'livekit-server-sdk';

import { LOAD_ROOM_PREFIX } from '../core/identity';
import { type LivekitEnv, roomService } from './tokens';

export interface RunParticipant {
  readonly identity: string;
  readonly active: boolean;
  readonly audioTracks: number;
}

export interface RoomOps {
  /** Fails unless no room with this name exists (room names are never reused). */
  assertAbsent(room: string): Promise<void>;
  create(room: string, maxParticipants: number): Promise<void>;
  participants(room: string): Promise<RunParticipant[]>;
  remove(room: string): Promise<void>;
  /** Every `loadtest-` room still on the SFU, with its participant count. */
  loadtestRooms(): Promise<Array<{ readonly name: string; readonly participants: number }>>;
}

/** Seconds an empty run room survives if the controller dies before deleting it. */
const EMPTY_TIMEOUT_SECONDS = 120;

/** The RoomService calls the controller makes (the SDK client satisfies it; tests fake it). */
export type RoomServiceCalls = Pick<
  RoomServiceClient,
  'listRooms' | 'createRoom' | 'listParticipants' | 'deleteRoom'
>;

export function roomOps(env: LivekitEnv): RoomOps {
  return roomOpsFrom(roomService(env));
}

export function roomOpsFrom(svc: RoomServiceCalls): RoomOps {
  return {
    async assertAbsent(room) {
      const existing = await svc.listRooms([room]);
      if (existing.length > 0)
        throw new Error(`room ${room} already exists — refusing to reuse it`);
    },
    async create(room, maxParticipants) {
      await svc.createRoom({ name: room, maxParticipants, emptyTimeout: EMPTY_TIMEOUT_SECONDS });
    },
    async participants(room) {
      const list = await svc.listParticipants(room);
      return list.map((p) => ({
        identity: p.identity,
        active: p.state === ParticipantInfo_State.ACTIVE,
        audioTracks: p.tracks.filter((t) => t.type === TrackType.AUDIO).length,
      }));
    },
    async remove(room) {
      await svc.deleteRoom(room);
    },
    async loadtestRooms() {
      const rooms = await svc.listRooms();
      return rooms
        .filter((r) => r.name.startsWith(LOAD_ROOM_PREFIX))
        .map((r) => ({ name: r.name, participants: r.numParticipants }));
    },
  };
}
