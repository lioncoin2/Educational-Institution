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
  readonly participants: readonly WorkerParticipant[];
}

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
  | { readonly type: 'cleaned'; readonly workerId: number }
  | { readonly type: 'fatal'; readonly workerId: number; readonly error: string };

/** supervisor → worker messages. */
export type SupervisorMessage = { readonly type: 'shutdown' };

export interface MpResult {
  readonly runId: string;
  readonly requested: number;
  readonly workers: number;
  readonly connected: number;
  readonly failed: number;
  readonly publisherPublished: boolean;
  readonly workerCrashes: number;
  readonly gateMet: boolean;
  readonly aborted: boolean;
  readonly abortReason: string | null;
  readonly holdSeconds: number;
}
