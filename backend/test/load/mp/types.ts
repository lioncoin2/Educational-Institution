/**
 * P8.3.5/P8.4 — worker process contracts. A worker owns its own rtc-node
 * runtime and a BOUNDED set of participants admitted one ticket at a time; it
 * reports structured events over Node IPC to its host (the P8.4 agent).
 *
 * No rtc-node here (pure types); the worker reaches the WebRTC client through
 * the driver port (mp/driver.ts), preserving the architecture boundary.
 */
import { type Role } from '../core/identity';

export interface MediaTicket {
  readonly url: string;
  readonly token: string;
}

/** Explicit publisher lifecycle (P8.3.6). */
export type PublisherState =
  'connecting' | 'connected' | 'publishing' | 'published' | 'failed' | 'disconnected';

/**
 * How a worker's clients gather ICE candidates (P8.4 §17). There is no
 * "SDK default" mode: an empty client ICE-server list makes the SDK use the
 * server's TURN servers (errata E2), so it is not representable here.
 *  - `turn-free`: an explicit, non-empty, STUN-only list — the capacity ladder.
 *  - `relay`: forced TURN relay — the S1 positive control only.
 */
export type IceConfig =
  { readonly mode: 'turn-free'; readonly stunUrls: readonly string[] } | { readonly mode: 'relay' };

/** One participant a worker must bring up, admitted with a just-in-time ticket. */
export interface WorkerParticipant {
  readonly identity: string;
  readonly room: string;
  readonly role: Role;
  readonly ticket: MediaTicket;
}

/** What the host hands a worker when it starts (participants arrive later via `admit`). */
export interface WorkerAssignment {
  readonly runId: string;
  /** Global shard index — unique across every agent in the fleet. */
  readonly workerId: number;
  readonly ice: IceConfig;
  readonly screen: { width: number; height: number; fps: number; maxBitrateKbps: number } | null;
  /** Bounded publisher publish retries (P8.3.6); 0 = single attempt. */
  readonly publishRetries: number;
  /** Upper bound on the worker's own teardown before it reports a timeout (P8.3.8). */
  readonly teardownTimeoutMs: number;
  /** Media observation window (P8.4 §8): stats sampling and aggregation period. */
  readonly statsIntervalMs: number;
  /** Run the sampled 440 Hz content probe on this worker's first listener. */
  readonly probe: boolean;
}

/**
 * How a worker process ends (P8.3.8) — the one contract the worker exits with
 * and its host classifies by. A worker exits ONLY after shutdown.
 */
export const WORKER_EXIT_CODE = {
  cleaned: 0,
  fatal: 1,
  teardownTimeout: 3,
} as const;

/** Selected-pair / candidate classification reported by a participant (P8.4 §17 T2). */
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export interface TransportReport {
  readonly protocol: string;
  readonly localType: CandidateType;
  readonly remoteType: CandidateType;
  readonly remotePort: number | null;
  /** Every local candidate type the client gathered (a `relay` here fails T2). */
  readonly localCandidateTypes: readonly CandidateType[];
}

/** Discrete media faults (P8.4 §8). `reason` carries a DisconnectReason name where known. */
export type MediaFaultKind =
  | 'stall'
  | 'disconnected'
  | 'unsubscribed'
  | 'subscriptionFailed'
  | 'publisherGone'
  | 'reconnecting'
  | 'reconnected';

/** Listener counts per loss band in one window (bands from observe/rules.ts). */
export interface LossBands {
  readonly green: number;
  readonly yellow: number;
  readonly red: number;
}

/** One worker's media observation window — aggregated, never per participant. */
export interface MediaWindow {
  readonly t: number;
  readonly listeners: number;
  readonly subscribed: number;
  readonly receiving: number;
  readonly stalled: number;
  /** Stats samples that were missing or late (a sampler gap, never a stall). */
  readonly gaps: number;
  readonly packetsReceived: number;
  readonly packetsLost: number;
  readonly lossBands: LossBands;
  readonly jitterMsMax: number;
  /** Event-loop lag p95 for this worker over the window. */
  readonly loopLagMsP95: number;
}

/** worker → host messages. */
export type WorkerMessage =
  | { readonly type: 'ready'; readonly workerId: number }
  | {
      readonly type: 'connected';
      readonly workerId: number;
      readonly participantId: string;
      readonly role: Role;
    }
  | {
      readonly type: 'failed';
      readonly workerId: number;
      readonly participantId: string;
      readonly role: Role;
      readonly error: string;
    }
  | {
      readonly type: 'published';
      readonly workerId: number;
      readonly participantId: string;
      readonly trackSid: string;
    }
  | {
      readonly type: 'publishFailed';
      readonly workerId: number;
      readonly participantId: string;
      readonly error: string;
    }
  // P8.3.8 teardown lifecycle: started → (cleaned | teardownTimeout), then exit.
  | { readonly type: 'teardownStarted'; readonly workerId: number; readonly participants: number }
  | { readonly type: 'teardownTimeout'; readonly workerId: number; readonly pending: number }
  | { readonly type: 'cleaned'; readonly workerId: number }
  | { readonly type: 'fatal'; readonly workerId: number; readonly error: string }
  // P8.3.6 publisher telemetry (does not change the gate; recorded to CSV):
  | {
      readonly type: 'publisherState';
      readonly workerId: number;
      readonly participantId: string;
      readonly state: PublisherState;
    }
  | {
      readonly type: 'publishAttempt';
      readonly workerId: number;
      readonly participantId: string;
      readonly attempt: number;
    }
  // P8.4 media-delivery and transport evidence:
  | {
      readonly type: 'subscribed';
      readonly workerId: number;
      readonly participantId: string;
      readonly trackSid: string;
    }
  | { readonly type: 'receiving'; readonly workerId: number; readonly participantId: string }
  | {
      readonly type: 'transport';
      readonly workerId: number;
      readonly participantId: string;
      readonly report: TransportReport;
    }
  | {
      readonly type: 'mediaFault';
      readonly workerId: number;
      readonly participantId: string;
      readonly fault: MediaFaultKind;
      readonly reason: string | null;
    }
  | { readonly type: 'mediaWindow'; readonly workerId: number; readonly window: MediaWindow }
  | {
      readonly type: 'publisherStats';
      readonly workerId: number;
      readonly participantId: string;
      readonly t: number;
      readonly packetsSent: number;
    }
  | {
      readonly type: 'probe';
      readonly workerId: number;
      readonly participantId: string;
      readonly ok: boolean;
      readonly toneRatio: number;
    };

/** host → worker commands. */
export type WorkerCommand =
  | { readonly type: 'admit'; readonly participant: WorkerParticipant }
  | { readonly type: 'shutdown' };

/**
 * How every worker process a host OWNS ended (P8.3.8). Forced termination is
 * never folded into a successful cleanup.
 */
export interface TeardownSummary {
  /** Worker processes the host spawned. */
  readonly workers: number;
  /** Emitted `cleaned` and exited with WORKER_EXIT_CODE.cleaned. */
  readonly cleaned: number;
  /** Reported `teardownTimeout` itself (bounded, graceful timeout). */
  readonly timedOut: number;
  /** Exited (code/signal) without `cleaned` or `teardownTimeout`. */
  readonly exitedUnclean: number;
  /** Still alive at the shutdown grace deadline; SIGKILLed by its host. */
  readonly forced: number;
}
