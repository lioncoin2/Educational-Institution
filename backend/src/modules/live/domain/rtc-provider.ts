/**
 * The RTC port.
 *
 * Everything the platform needs from a realtime audio provider, expressed in the
 * institution's own vocabulary. No LiveKit type appears here — the LiveKit SDK
 * is confined to `infrastructure/livekit-rtc-provider.ts`, so replacing the
 * provider (or running a fake in tests) touches exactly one file.
 */

/** What a participant is allowed to do on the wire. */
export interface RtcCapabilities {
  /** Listeners are false. This is what keeps a 2500-person room viable. */
  readonly canPublishAudio: boolean;
  readonly canSubscribe: boolean;
  /** Data messages (raise-hand signalling, queue updates). */
  readonly canPublishData: boolean;
}

export const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canSubscribe: true,
  canPublishData: true,
};

export const SPEAKER: RtcCapabilities = {
  canPublishAudio: true,
  canSubscribe: true,
  canPublishData: true,
};

export interface RtcRoomSpec {
  /** Provider-facing room name; we use the LiveSession id. */
  readonly roomName: string;
  /** Provider may reap the room this long after it empties. */
  readonly emptyTimeoutSeconds: number;
  /** Hard ceiling enforced by the provider, independent of our own checks. */
  readonly maxParticipants: number;
}

export interface RtcAccessGrant {
  readonly roomName: string;
  /** Stable per-user identity; we use the platform userId. */
  readonly identity: string;
  readonly displayName: string;
  readonly capabilities: RtcCapabilities;
  readonly ttlSeconds: number;
}

export interface RtcAccessToken {
  readonly token: string;
  /** Where the client should connect. Comes from configuration, not the client. */
  readonly url: string;
  readonly expiresInSeconds: number;
}

export interface RtcProvider {
  /** Idempotent: safe to call on every session start. */
  ensureRoom(spec: RtcRoomSpec): Promise<void>;

  /**
   * Mints a join token. This is the security boundary: capabilities are decided
   * here, server-side. A client never asks for permissions — it receives them.
   */
  issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken>;

  /** Promotes or demotes a participant already in the room. */
  updateCapabilities(
    roomName: string,
    identity: string,
    capabilities: RtcCapabilities,
  ): Promise<void>;

  /** Server-side mute. Distinct from demotion: the grant may remain. */
  muteParticipant(roomName: string, identity: string): Promise<void>;

  removeParticipant(roomName: string, identity: string): Promise<void>;

  endRoom(roomName: string): Promise<void>;
}

export const RTC_PROVIDER = Symbol('RTC_PROVIDER');
