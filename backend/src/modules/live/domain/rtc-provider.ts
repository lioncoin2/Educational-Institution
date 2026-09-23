/**
 * The RTC ports.
 *
 * Everything the platform needs from a realtime media provider, expressed in
 * the institution's own vocabulary. No LiveKit type appears here: the SDK is
 * confined to `infrastructure/livekit-rtc-provider.ts`, and a dependency rule
 * (`livekit-sdk-only-in-the-live-adapter`) keeps it there. Replacing the
 * provider, or running a fake in tests, touches exactly one file.
 *
 * The port is split by what a caller may do (ADR 0019): a use case injects
 * only the narrow port it needs, so joining cannot remove anyone and raising a
 * hand cannot touch the provider at all. One adapter implements all four.
 */

/** A kind of track a participant may publish. The camera is never one. */
export type RtcSource = 'microphone' | 'screen_share' | 'screen_share_audio';

/**
 * What a participant may do on the wire.
 *
 * TOTAL: every field is always present, and the adapter applies it as the
 * provider's FULL permission set, never as a delta — a provider update that
 * omits a field resets it (LiveKit's `UpdateFromPermission`), and an empty
 * source list means "every source". Nothing is left to a default.
 */
export interface RtcCapabilities {
  readonly canPublishAudio: boolean;
  readonly canPublishScreen: boolean;
  /** Implies `canPublishScreen`. False until the institution decides (Q56). */
  readonly canPublishScreenAudio: boolean;
  readonly canSubscribe: boolean;
  /**
   * Always false. Raise-hand and every other application signal travel over
   * HTTP and the app's own realtime channel, never the media provider's data
   * channel, which would let any listener broadcast to the whole room.
   */
  readonly canPublishData: boolean;
  /** Always false until Q59 decides whether listeners may be hidden. */
  readonly hidden: boolean;
}

/** Subscribes only. Every participant who is not speaking. */
export const LISTENER: RtcCapabilities = Object.freeze({
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
});

/** A granted hand, or the host: the microphone and nothing else. */
export const SPEAKER: RtcCapabilities = Object.freeze({
  ...LISTENER,
  canPublishAudio: true,
});

/** The explicit source list a capability set allows. Never empty-means-all. */
export function sourcesOf(capabilities: RtcCapabilities): readonly RtcSource[] {
  const sources: RtcSource[] = [];
  if (capabilities.canPublishAudio) sources.push('microphone');
  if (capabilities.canPublishScreen) sources.push('screen_share');
  if (capabilities.canPublishScreen && capabilities.canPublishScreenAudio) {
    sources.push('screen_share_audio');
  }
  return sources;
}

export interface RtcRoomSpec {
  /** Provider-facing room name; today the LiveSession id. */
  readonly roomName: string;
  /** Hard ceiling enforced by the provider, independent of our own checks. */
  readonly maxParticipants: number;
  /** The provider may reap the room this long after creation if nobody joins. */
  readonly emptyTimeoutSeconds: number;
  /** …and this long after the last participant leaves. */
  readonly departureTimeoutSeconds: number;
}

export interface RtcRoomObservation {
  readonly roomName: string;
  readonly participantCount: number;
  readonly createdAt: Date;
}

export interface RtcAccessGrant {
  readonly roomName: string;
  /** Stable per-account identity: the platform user id. */
  readonly identity: string;
  /** From the account directory — never from the client, never an email. */
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

/**
 * The outcome of changing a participant on the provider. `not_connected`: the
 * identity is not in the room right now — the change is recorded on our side
 * and applies when they next join (their next token carries it).
 */
export type RtcApplyOutcome = 'applied' | 'not_connected';

export interface RtcParticipantObservation {
  readonly identity: string;
  /** Participants that have left are dropped by the adapter. */
  readonly state: 'joining' | 'joined' | 'active';
  /** False for recorders, ingress, telephony and agents. */
  readonly standard: boolean;
  readonly joinedAt: Date;
  readonly publishing: readonly RtcSource[];
  /** As the provider holds them now. */
  readonly capabilities: RtcCapabilities;
}

/**
 * The provider could not be reached: a network error, a timeout or a 5xx.
 * Nothing about the request is known to have happened. Callers either fail
 * with 503 (`FailureKind 'unavailable'`) or record the change and let it
 * converge; they never pretend it was applied.
 */
export class RtcUnavailableError extends Error {
  constructor(readonly operation: string) {
    super(`The media provider is unavailable (${operation}).`);
    this.name = 'RtcUnavailableError';
  }
}

/** Rooms: created by us, ended by us. */
export interface RtcRoomProvider {
  /** Create-or-update; idempotent. Errors are reported, never swallowed. */
  ensureRoom(spec: RtcRoomSpec): Promise<void>;
  /** Idempotent: a room that does not exist is already ended. */
  endRoom(roomName: string): Promise<void>;
  listRooms(roomNames?: readonly string[]): Promise<readonly RtcRoomObservation[]>;
}

/** Join tokens: signed locally, no network. The security boundary of live media. */
export interface RtcTokenIssuer {
  /**
   * Capabilities are decided server-side and encoded here. A client never
   * asks for permissions — it receives them.
   */
  issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken>;
}

/** Changing participants who are (or may be) in a room. */
export interface RtcParticipantControl {
  /** Applies the FULL capability set to a participant already in the room. */
  updateCapabilities(
    roomName: string,
    identity: string,
    capabilities: RtcCapabilities,
  ): Promise<RtcApplyOutcome>;
  removeParticipant(
    roomName: string,
    identity: string,
    options?: { readonly revokeTokensIssuedBefore?: Date },
  ): Promise<RtcApplyOutcome>;
  /** Server-side mute of the given sources. Distinct from demotion: the grant may remain. */
  muteParticipant(
    roomName: string,
    identity: string,
    sources: readonly RtcSource[],
  ): Promise<RtcApplyOutcome>;
}

/** Reading who is in a room: one provider read each, never cached here. */
export interface RtcParticipantObserver {
  listParticipants(roomName: string): Promise<readonly RtcParticipantObservation[]>;
  getParticipant(roomName: string, identity: string): Promise<RtcParticipantObservation | null>;
}

export interface RtcProvider
  extends RtcRoomProvider, RtcTokenIssuer, RtcParticipantControl, RtcParticipantObserver {}

/** The provider itself — bound to the LiveKit adapter or the fake, once. */
export const RTC_PROVIDER = Symbol('RTC_PROVIDER');
/** The narrow ports, each bound with `useExisting: RTC_PROVIDER`. */
export const RTC_ROOMS = Symbol('RTC_ROOMS');
export const RTC_TOKENS = Symbol('RTC_TOKENS');
export const RTC_PARTICIPANTS = Symbol('RTC_PARTICIPANTS');
export const RTC_OBSERVER = Symbol('RTC_OBSERVER');
