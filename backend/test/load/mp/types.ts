/**
 * P8.3.5 — multi-process generator shared types. The supervisor forks N worker
 * processes; each worker owns its own rtc-node runtime and a BOUNDED set of
 * participants, so the ~40-Room native-handle ceiling of a single process
 * (RUNG 1 failure) is multiplied across processes. Messages flow worker→
 * supervisor over Node IPC.
 *
 * No rtc-node here (pure types); the worker reaches the WebRTC client by dynamic
 * import, preserving the architecture boundary.
 */
import { type MediaPath } from '../core/config';
import { type Role } from '../core/identity';

export interface MediaTicket {
  readonly url: string;
  readonly token: string;
}

/** Explicit publisher lifecycle (P8.3.6). */
export type PublisherState =
  'connecting' | 'connected' | 'publishing' | 'published' | 'failed' | 'disconnected';

/** One participant a worker must bring up. */
export interface WorkerParticipant {
  readonly identity: string;
  readonly room: string;
  readonly role: Role;
  readonly ticket: MediaTicket;
}

/** What the supervisor hands a worker when it starts. */
export interface WorkerAssignment {
  readonly runId: string;
  readonly workerId: number;
  readonly mediaPath: MediaPath;
  readonly screen: { width: number; height: number; fps: number; maxBitrateKbps: number } | null;
  /** Max concurrent connect attempts inside the worker (avoids a burst). */
  readonly connectConcurrency: number;
  /** Bounded publisher publish retries (P8.3.6); 0 = single attempt. */
  readonly publishRetries: number;
  /** Upper bound on the worker's own teardown before it reports a timeout (P8.3.8). */
  readonly teardownTimeoutMs: number;
  readonly participants: readonly WorkerParticipant[];
}

/**
 * How a worker process ends (P8.3.8) — the one contract the worker exits with
 * and the supervisor classifies by. A worker exits ONLY after shutdown.
 */
export const WORKER_EXIT_CODE = {
  cleaned: 0,
  fatal: 1,
  teardownTimeout: 3,
} as const;

/** worker → supervisor messages. */
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
  | { readonly type: 'published'; readonly workerId: number; readonly participantId: string }
  | {
      readonly type: 'publishFailed';
      readonly workerId: number;
      readonly participantId: string;
      readonly error: string;
    }
  | { readonly type: 'rampDone'; readonly workerId: number }
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
    };

/** supervisor → worker messages. */
export type SupervisorMessage = { readonly type: 'shutdown' };

/**
 * How every worker process the supervisor OWNS ended (P8.3.8). Forced
 * termination is never folded into a successful cleanup.
 */
export interface TeardownSummary {
  /** Worker processes forked by the supervisor. */
  readonly workers: number;
  /** Emitted `cleaned` and exited with WORKER_EXIT_CODE.cleaned. */
  readonly cleaned: number;
  /** Reported `teardownTimeout` itself (bounded, graceful timeout). */
  readonly timedOut: number;
  /** Exited (code/signal) without `cleaned` or `teardownTimeout`. */
  readonly exitedUnclean: number;
  /** Still alive at the shutdown grace deadline; SIGKILLed by the supervisor. */
  readonly forced: number;
}

export interface MpResult {
  readonly runId: string;
  readonly requested: number;
  readonly workers: number;
  readonly teardown: TeardownSummary;
  readonly connected: number;
  readonly failed: number;
  readonly publisherPublished: boolean;
  readonly workerCrashes: number;
  readonly gateMet: boolean;
  readonly aborted: boolean;
  readonly abortReason: string | null;
  readonly holdSeconds: number;
}
