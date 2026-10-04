/**
 * P8.4 — the media-driver PORT. The worker (participant lifecycle) and the pure
 * media-health logic depend only on these plain-data types; the rtc-node
 * ADAPTER that implements them is test/livekit/load/media-driver.ts (the only
 * file allowed to name the WebRTC client), and the test fake is
 * mp/fake-worker.ts. Nothing here imports rtc-node.
 */
import { type CandidateType, type IceConfig, type MediaTicket } from './types';

export interface ScreenSpec {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly maxBitrateKbps: number;
}

/** Room events a participant observes, mapped to plain data by the adapter. */
export type ParticipantEvent =
  | { readonly kind: 'trackSubscribed'; readonly trackSid: string; readonly publisher: string }
  | { readonly kind: 'trackUnsubscribed'; readonly trackSid: string; readonly publisher: string }
  | {
      readonly kind: 'trackSubscriptionFailed';
      readonly trackSid: string;
      readonly publisher: string;
      readonly reason: string | null;
    }
  | { readonly kind: 'participantDisconnected'; readonly identity: string }
  /** `reason` is the DisconnectReason name, e.g. DUPLICATE_IDENTITY. */
  | { readonly kind: 'disconnected'; readonly reason: string }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'reconnected' };

export interface SelectedPair {
  readonly protocol: string;
  readonly localType: CandidateType;
  readonly remoteType: CandidateType;
  readonly remotePort: number | null;
  /** Milliseconds since epoch, when the bindings expose it on the pair. */
  readonly lastPacketReceivedMs: number | null;
}

/**
 * One `getRtcStats()` reading, reduced to what the media gate needs. Counters
 * are cumulative; `statsTsMs` is the stats timestamp (not the wall clock of the
 * call), so a late reading is detectable.
 */
export interface MediaStatsSnapshot {
  readonly statsTsMs: number;
  /** Sum over the participant's inbound AUDIO rtp streams; null when none exists yet. */
  readonly inbound: {
    readonly packetsReceived: number;
    readonly packetsLost: number;
    readonly jitterSec: number;
  } | null;
  /** Sum over the participant's outbound AUDIO rtp streams; null when not publishing. */
  readonly outbound: { readonly packetsSent: number } | null;
  readonly selectedPair: SelectedPair | null;
  readonly localCandidateTypes: readonly CandidateType[];
}

export interface LoadParticipantLike {
  /** Publishes the 440 Hz tone with explicit options (dtx off, RED on); returns the track SID. */
  publishMicrophone(): Promise<{ readonly trackSid: string }>;
  publishScreenShare(spec: ScreenSpec): Promise<void>;
  disconnect(): Promise<void>;
  /** Registers the single event listener for this participant. */
  onEvent(listener: (event: ParticipantEvent) => void): void;
  stats(): Promise<MediaStatsSnapshot>;
  /** Decoded mono PCM of the subscribed audio for `durationMs`, or null if none. */
  captureAudio(
    durationMs: number,
  ): Promise<{ readonly samples: Int16Array; readonly sampleRate: number } | null>;
}

export interface ConnectOptions {
  readonly subscribe: boolean;
  readonly ice: IceConfig;
}

export interface Driver {
  readonly LoadParticipant: {
    connect(ticket: MediaTicket, opts: ConnectOptions): Promise<LoadParticipantLike>;
  };
  disposeMedia(): Promise<void>;
}
