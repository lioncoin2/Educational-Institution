import { Logger } from '@nestjs/common';
import {
  AccessToken,
  ParticipantInfo_State,
  RoomServiceClient,
  ServerError,
  TrackSource,
  type ParticipantInfo,
  type ParticipantPermission,
} from 'livekit-server-sdk';

import type { AppConfig } from '../../../platform/config/app-config';
import {
  RtcUnavailableError,
  sourcesOf,
  type RtcAccessGrant,
  type RtcAccessToken,
  type RtcApplyOutcome,
  type RtcCapabilities,
  type RtcParticipantObservation,
  type RtcProvider,
  type RtcRoomObservation,
  type RtcRoomSpec,
  type RtcSource,
} from '../domain/rtc-provider';

/** The room-service calls this adapter makes — a structural subset, so tests can stand in. */
export type LiveKitRoomService = Pick<
  RoomServiceClient,
  | 'createRoom'
  | 'deleteRoom'
  | 'listRooms'
  | 'listParticipants'
  | 'getParticipant'
  | 'updateParticipant'
  | 'removeParticipant'
  | 'mutePublishedTrack'
>;

/** `ParticipantInfo_Kind.STANDARD` in LiveKit's protocol: a person, not a recorder, SIP line or agent. */
const STANDARD_PARTICIPANT_KIND = 0;

const SOURCE_TO_LIVEKIT: Readonly<Record<RtcSource, TrackSource>> = {
  microphone: TrackSource.MICROPHONE,
  screen_share: TrackSource.SCREEN_SHARE,
  screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO,
};

const LIVEKIT_TO_SOURCE = new Map<TrackSource, RtcSource>(
  (Object.entries(SOURCE_TO_LIVEKIT) as [RtcSource, TrackSource][]).map(([ours, theirs]) => [
    theirs,
    ours,
  ]),
);

/** How a failed LiveKit call is classified; see `classify`. */
type Failure = 'not_found' | 'unavailable' | 'misconfigured' | 'rejected';

/**
 * The LiveKit adapter — the only file in the system that imports LiveKit
 * (enforced by `livekit-sdk-only-in-the-live-adapter`).
 *
 * Everything above it speaks the RTC ports, so swapping providers, or running
 * the live feature against the fake, is a one-line change in `live.module.ts`.
 *
 * Hardening, each point a LiveKit behaviour verified in its source
 * (docs/architecture/live.md §9):
 *   - Capabilities are applied as the FULL permission set, every time: a
 *     LiveKit permission update resets every field it is not given, and an
 *     EMPTY source list means every source. So the source list is always
 *     explicit, `canPublish` is true exactly when it is non-empty, and data,
 *     `hidden` and metadata are always stated. The camera is never listed.
 *   - Client tokens carry `roomJoin` for one named room only — never
 *     `roomCreate`, `roomAdmin`, `roomList` or `roomRecord` — and a name from
 *     the account directory. The API secret never leaves the server.
 *   - Errors are reported, never swallowed: "not found" becomes the port's
 *     outcome, an outage becomes `RtcUnavailableError`, a rejected key is a
 *     misconfiguration fault. Logs carry an error's class and status, never
 *     its message, a token or the secret.
 */
export class LiveKitRtcProvider implements RtcProvider {
  private readonly logger = new Logger(LiveKitRtcProvider.name);
  private readonly rooms: LiveKitRoomService;

  constructor(
    private readonly config: AppConfig,
    rooms?: LiveKitRoomService,
  ) {
    // The client API speaks ws(s); the server API speaks http(s) to the same host.
    const httpUrl = config.livekit.url.replace(/^ws/, 'http');
    this.rooms =
      rooms ?? new RoomServiceClient(httpUrl, config.livekit.apiKey, config.livekit.apiSecret);
  }

  // ── Rooms ────────────────────────────────────────────────────────────────

  async ensureRoom(spec: RtcRoomSpec): Promise<void> {
    // Create-or-update on the server: an existing room is found and updated,
    // so this is idempotent without swallowing anything.
    await this.call('ensureRoom', () =>
      this.rooms.createRoom({
        name: spec.roomName,
        maxParticipants: spec.maxParticipants,
        emptyTimeout: spec.emptyTimeoutSeconds,
        departureTimeout: spec.departureTimeoutSeconds,
      }),
    );
  }

  async endRoom(roomName: string): Promise<void> {
    // A room that does not exist is already ended.
    await this.call('endRoom', () => this.rooms.deleteRoom(roomName), { onNotFound: 'absent' });
  }

  async listRooms(roomNames?: readonly string[]): Promise<readonly RtcRoomObservation[]> {
    const rooms = await this.call('listRooms', () =>
      this.rooms.listRooms(roomNames === undefined ? undefined : [...roomNames]),
    );
    return rooms.map((room) => ({
      roomName: room.name,
      participantCount: room.numParticipants,
      createdAt: new Date(Number(room.creationTime) * 1000),
    }));
  }

  // ── Tokens ───────────────────────────────────────────────────────────────

  async issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken> {
    const token = new AccessToken(this.config.livekit.apiKey, this.config.livekit.apiSecret, {
      identity: grant.identity,
      name: grant.displayName,
      ttl: grant.ttlSeconds,
    });
    const sources = sourcesOf(grant.capabilities).map((source) => SOURCE_TO_LIVEKIT[source]);
    token.addGrant({
      room: grant.roomName,
      roomJoin: true,
      canPublish: sources.length > 0,
      canPublishSources: sources,
      canSubscribe: grant.capabilities.canSubscribe,
      canPublishData: grant.capabilities.canPublishData,
      canUpdateOwnMetadata: false,
      hidden: grant.capabilities.hidden,
    });
    return {
      token: await token.toJwt(),
      url: this.config.livekit.url,
      expiresInSeconds: grant.ttlSeconds,
    };
  }

  // ── Participants ─────────────────────────────────────────────────────────

  async updateCapabilities(
    roomName: string,
    identity: string,
    capabilities: RtcCapabilities,
  ): Promise<RtcApplyOutcome> {
    return this.apply('updateCapabilities', () =>
      this.rooms.updateParticipant(roomName, identity, {
        permission: permissionOf(capabilities),
      }),
    );
  }

  async removeParticipant(
    roomName: string,
    identity: string,
    options?: { readonly revokeTokensIssuedBefore?: Date },
  ): Promise<RtcApplyOutcome> {
    const before = options?.revokeTokensIssuedBefore;
    return this.apply('removeParticipant', () =>
      this.rooms.removeParticipant(
        roomName,
        identity,
        // Passed for providers that honour it; the open-source server does not
        // (live.md §9), which is why removal is never the only enforcement.
        before === undefined
          ? undefined
          : { revokeTokenTs: BigInt(Math.floor(before.getTime() / 1000)) },
      ),
    );
  }

  async muteParticipant(
    roomName: string,
    identity: string,
    sources: readonly RtcSource[],
  ): Promise<RtcApplyOutcome> {
    const participant = await this.call(
      'muteParticipant',
      () => this.rooms.getParticipant(roomName, identity),
      { onNotFound: 'absent' },
    );
    if (participant === null) return 'not_connected';
    const wanted = new Set(sources.map((source) => SOURCE_TO_LIVEKIT[source]));
    for (const track of participant.tracks) {
      if (!wanted.has(track.source) || track.muted) continue;
      const outcome = await this.apply('muteParticipant', () =>
        this.rooms.mutePublishedTrack(roomName, identity, track.sid, true),
      );
      if (outcome === 'not_connected') return outcome;
    }
    return 'applied';
  }

  async listParticipants(roomName: string): Promise<readonly RtcParticipantObservation[]> {
    const participants = await this.call(
      'listParticipants',
      () => this.rooms.listParticipants(roomName),
      { onNotFound: 'absent' },
    );
    return (participants ?? []).flatMap((participant) => {
      const observed = observation(participant);
      return observed === null ? [] : [observed];
    });
  }

  async getParticipant(
    roomName: string,
    identity: string,
  ): Promise<RtcParticipantObservation | null> {
    const participant = await this.call(
      'getParticipant',
      () => this.rooms.getParticipant(roomName, identity),
      { onNotFound: 'absent' },
    );
    return participant === null ? null : observation(participant);
  }

  // ── Error handling ───────────────────────────────────────────────────────

  /** A participant change: "not found" means the identity is not in the room. */
  private async apply(operation: string, run: () => Promise<unknown>): Promise<RtcApplyOutcome> {
    const outcome = await this.call(operation, run, { onNotFound: 'absent' });
    return outcome === null ? 'not_connected' : 'applied';
  }

  /**
   * Runs one provider call. `onNotFound: 'absent'` turns LiveKit's "not found"
   * into null; otherwise it is a failure like any other. An outage throws the
   * domain's `RtcUnavailableError`; a rejected key or anything else is a fault.
   */
  private async call<T>(operation: string, run: () => Promise<T>): Promise<T>;
  private async call<T>(
    operation: string,
    run: () => Promise<T>,
    options: { readonly onNotFound: 'absent' },
  ): Promise<T | null>;
  private async call<T>(
    operation: string,
    run: () => Promise<T>,
    options?: { readonly onNotFound: 'absent' },
  ): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      const kind = classify(error);
      if (kind === 'not_found' && options?.onNotFound === 'absent') return null;
      const detail = describe(error);
      if (kind === 'unavailable') {
        this.logger.warn({ operation, ...detail }, 'media provider unavailable');
        throw new RtcUnavailableError(operation);
      }
      if (kind === 'misconfigured') {
        // Wrong key or secret: nothing a retry fixes. Loud, and a 500.
        this.logger.error({ operation, ...detail }, 'media provider rejected our credentials');
      } else {
        this.logger.error({ operation, ...detail }, 'media provider refused a request');
      }
      throw new Error(`The media provider refused ${operation} (${detail.status ?? 'no status'}).`);
    }
  }
}

/** The full LiveKit permission set for a capability set — every field stated. */
export function permissionOf(capabilities: RtcCapabilities): Partial<ParticipantPermission> {
  const sources = sourcesOf(capabilities).map((source) => SOURCE_TO_LIVEKIT[source]);
  return {
    canPublish: sources.length > 0,
    canPublishSources: sources,
    canSubscribe: capabilities.canSubscribe,
    canPublishData: capabilities.canPublishData,
    canUpdateMetadata: false,
    hidden: capabilities.hidden,
  };
}

/** LiveKit's view of a participant, in the port's terms; null for one that has left. */
function observation(participant: ParticipantInfo): RtcParticipantObservation | null {
  const state =
    participant.state === ParticipantInfo_State.ACTIVE
      ? 'active'
      : participant.state === ParticipantInfo_State.JOINED
        ? 'joined'
        : participant.state === ParticipantInfo_State.JOINING
          ? 'joining'
          : null;
  if (state === null) return null;
  const permission = participant.permission;
  const allowed = new Set(permission?.canPublishSources ?? []);
  const may = (source: TrackSource) =>
    (permission?.canPublish ?? false) && (allowed.size === 0 || allowed.has(source));
  return {
    identity: participant.identity,
    state,
    standard: Number(participant.kind) === STANDARD_PARTICIPANT_KIND,
    joinedAt: new Date(Number(participant.joinedAtMs) || Number(participant.joinedAt) * 1000),
    publishing: participant.tracks
      .filter((track) => !track.muted)
      .map((track) => LIVEKIT_TO_SOURCE.get(track.source))
      .filter((source): source is RtcSource => source !== undefined),
    capabilities: {
      canPublishAudio: may(TrackSource.MICROPHONE),
      canPublishScreen: may(TrackSource.SCREEN_SHARE),
      canPublishScreenAudio: may(TrackSource.SCREEN_SHARE_AUDIO),
      canSubscribe: permission?.canSubscribe ?? false,
      canPublishData: permission?.canPublishData ?? false,
      hidden: permission?.hidden ?? false,
    },
  };
}

/**
 * Sorts a failure by what the caller can do about it. The SDK throws its own
 * `ServerError` for any HTTP answer, and the platform's fetch errors
 * (TypeError, AbortError, TimeoutError) when nothing answered.
 */
export function classify(error: unknown): Failure {
  if (error instanceof ServerError) {
    const code = typeof error.code === 'string' ? error.code : '';
    if (error.status === 404 || code === 'not_found') return 'not_found';
    if (error.status === 401 || error.status === 403) return 'misconfigured';
    if (code === 'unauthenticated' || code === 'permission_denied') return 'misconfigured';
    if (error.status >= 500 || code === 'unavailable' || code === 'deadline_exceeded') {
      return 'unavailable';
    }
    return 'rejected';
  }
  if (error instanceof Error) {
    const name = error.name;
    if (name === 'TypeError' || name === 'AbortError' || name === 'TimeoutError') {
      return 'unavailable';
    }
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|UND_ERR)/.test(code)
    ) {
      return 'unavailable';
    }
  }
  return 'rejected';
}

/**
 * What of an error may be logged: its class, and the HTTP status and code if
 * there was an answer. Never the message — a provider message could echo a
 * request — and so never a token, a JWT or the secret.
 */
export function describe(error: unknown): { name: string; status?: number; code?: string } {
  if (error instanceof ServerError) {
    return {
      name: 'ServerError',
      status: error.status,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  }
  return { name: error instanceof Error ? error.name : typeof error };
}
