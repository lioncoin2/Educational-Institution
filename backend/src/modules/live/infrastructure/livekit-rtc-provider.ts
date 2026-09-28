import { Logger } from '@nestjs/common';
import {
  AccessToken,
  ParticipantInfo_State,
  RoomServiceClient,
  TrackSource,
  type ParticipantInfo,
  type ParticipantPermission,
} from 'livekit-server-sdk';

import type { AppConfig } from '../../../platform/config/app-config';
import { MAX_JOIN_TOKEN_TTL_SECONDS, isJoinTokenTtl } from '../domain/live-limits';
import {
  RtcMisconfiguredError,
  RtcUnavailableError,
  sourcesOf,
  type RtcAccessGrant,
  type RtcAccessToken,
  type RtcApplyOutcome,
  type RtcCapabilities,
  type RtcMisconfiguration,
  type RtcParticipantObservation,
  type RtcProvider,
  type RtcReadinessReport,
  type RtcRoomObservation,
  type RtcRoomSpec,
  type RtcSource,
} from '../domain/rtc-provider';
import { LiveKitReadiness } from './livekit-readiness';
import {
  LIVEKIT_CLIENT_OPTIONS,
  classify,
  describe,
  outageOf,
  type LiveKitFailure,
} from './livekit-transport';

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

/**
 * The LiveKit adapter — with its readiness probe (`livekit-readiness.ts`)
 * and its transport rules (`livekit-transport.ts`), the only code in the
 * system that imports LiveKit (enforced by
 * `livekit-sdk-only-in-the-live-adapter`).
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
 *     `roomCreate`, `roomAdmin`, `roomList` or `roomRecord` — a name from
 *     the account directory, and a lifetime of 1 to 600 seconds, checked here
 *     again: the SDK reads a falsy one as six hours. The API secret never
 *     leaves the server.
 *   - Two URLs: clients get LIVEKIT_URL in their tickets; the server API is
 *     called on LIVEKIT_API_URL, with the SDK's options stated — a 10-second
 *     timeout and no failover.
 *   - Errors are reported, never swallowed: LiveKit's own "not found" becomes
 *     the port's outcome — and nothing else does, so a wrong endpoint that
 *     answers 404 is never an absent room — an outage becomes
 *     `RtcUnavailableError` (with whether it timed out), refused
 *     credentials, a TLS failure or an answer that is not LiveKit's becomes
 *     `RtcMisconfiguredError` (P7.2, Q-B), and anything else is a fault.
 *     Logs carry an error's class, status and code, never its message, a
 *     token or the secret.
 *
 * Structured events (ids only): `live.provider.room_create`, `.room_delete`,
 * `.token_issue` and `.error`.
 */
export class LiveKitRtcProvider implements RtcProvider {
  private readonly logger = new Logger(LiveKitRtcProvider.name);
  private readonly rooms: LiveKitRoomService;
  private readonly readiness: LiveKitReadiness;

  /**
   * `rooms` and `http` stand in for the SDK's room service and the
   * platform's fetch in tests; by default the room service is the SDK's,
   * on the server-side API URL.
   */
  constructor(
    private readonly config: AppConfig,
    rooms?: LiveKitRoomService,
    http: typeof fetch = fetch,
  ) {
    this.rooms =
      rooms ??
      new RoomServiceClient(
        config.livekit.apiUrl,
        config.livekit.apiKey,
        config.livekit.apiSecret,
        LIVEKIT_CLIENT_OPTIONS,
      );
    this.readiness = new LiveKitReadiness(config, this.rooms, http);
  }

  // ── Readiness ────────────────────────────────────────────────────────────

  check(): Promise<RtcReadinessReport> {
    return this.readiness.check();
  }

  // ── Rooms ────────────────────────────────────────────────────────────────

  async ensureRoom(spec: RtcRoomSpec): Promise<void> {
    // Idempotent without swallowing anything: a room the server holds is
    // returned as it is, unchanged (SRV `pkg/service/roommanager.go:644-653`).
    await this.call('ensureRoom', () =>
      this.rooms.createRoom({
        name: spec.roomName,
        maxParticipants: spec.maxParticipants,
        emptyTimeout: spec.emptyTimeoutSeconds,
        departureTimeout: spec.departureTimeoutSeconds,
      }),
    );
    this.logger.log(
      { event: 'live.provider.room_create', room: spec.roomName },
      'media room ensured',
    );
  }

  async endRoom(roomName: string): Promise<void> {
    // A room LiveKit says does not exist is already ended.
    const deleted = await this.call('endRoom', () => this.rooms.deleteRoom(roomName), {
      onNotFound: 'absent',
    });
    this.logger.log(
      {
        event: 'live.provider.room_delete',
        room: roomName,
        outcome: deleted === null ? 'already_gone' : 'deleted',
      },
      'media room ended',
    );
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
    // Defence in depth (audit D24): the call site checks the lifetime too.
    if (!isJoinTokenTtl(grant.ttlSeconds)) {
      throw new RangeError(
        `A join token lasts 1 to ${MAX_JOIN_TOKEN_TTL_SECONDS} whole seconds, not ${grant.ttlSeconds}.`,
      );
    }
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
    const signed = await token.toJwt();
    this.logger.log(
      {
        event: 'live.provider.token_issue',
        room: grant.roomName,
        identity: grant.identity,
        ttlSeconds: grant.ttlSeconds,
      },
      'media join token issued',
    );
    return { token: signed, url: this.config.livekit.url, expiresInSeconds: grant.ttlSeconds };
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

  /** A participant change: LiveKit's own "not found" means the identity is not in the room. */
  private async apply(operation: string, run: () => Promise<unknown>): Promise<RtcApplyOutcome> {
    const outcome = await this.call(operation, run, { onNotFound: 'absent' });
    return outcome === null ? 'not_connected' : 'applied';
  }

  /**
   * Runs one provider call. `onNotFound: 'absent'` turns LiveKit's own "not
   * found" into null; otherwise it is a failure like any other. An outage
   * throws the domain's `RtcUnavailableError`; rejected credentials, a TLS
   * failure or an answer that is not LiveKit's throws its
   * `RtcMisconfiguredError`; any other refusal is a fault — never absence,
   * never success.
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
      const detail = { event: 'live.provider.error', operation, ...describe(error) };
      if (kind === 'unavailable') {
        const reason = outageOf(error);
        this.logger.warn({ ...detail, reason }, 'media provider unavailable');
        throw new RtcUnavailableError(operation, reason);
      }
      // Nothing a retry fixes: loud. A configuration the provider refuses is
      // the port's own error (503 live.media_misconfigured); anything else a
      // 500.
      this.logger.error(detail, FAULT_MESSAGES[kind]);
      const misconfiguration = MISCONFIGURATIONS[kind];
      if (misconfiguration !== undefined) {
        throw new RtcMisconfiguredError(operation, misconfiguration);
      }
      throw new Error(`The media provider refused ${operation} (${detail.status ?? kind}).`);
    }
  }
}

/** How each fault is logged — a wrong key or secret, a wrong URL or certificate, a wrong endpoint. */
const FAULT_MESSAGES: Readonly<Record<Exclude<LiveKitFailure, 'unavailable'>, string>> = {
  misconfigured: 'media provider rejected our credentials',
  tls: 'media provider TLS handshake or certificate failed',
  incompatible: 'media provider answered, but not as LiveKit does',
  not_found: 'media provider refused a request',
  rejected: 'media provider refused a request',
};

/**
 * The faults that are this deployment's configuration, not a request's: the
 * readiness reason each is. LiveKit refusing a request itself (`rejected`,
 * or `not_found` where absence is no answer) is neither.
 */
const MISCONFIGURATIONS: Readonly<Partial<Record<LiveKitFailure, RtcMisconfiguration>>> = {
  misconfigured: 'unauthorized',
  tls: 'tls_failure',
  incompatible: 'incompatible_response',
};

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
