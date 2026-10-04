/**
 * P8.4 — what one rung run is asked to do and what it depends on (design §1):
 * the request, the timing (defaults from the verdict-table data in
 * observe/rules.ts — never restated here), the injected ports and the outcome.
 * Contracts only; the controller (fleet/controller.ts) runs them.
 */
import { type EventCsv } from '../mp/csv';
import { type ProcessManager } from '../mp/process-manager';
import { type MediaTicket } from '../mp/types';
import { type RoomOps } from '../livekit/room-ops';
import { type TicketRole } from '../livekit/tokens';
import { type LivekitLogCounts } from '../observe/livekit-log';
import {
  PARAMETERS,
  SAMPLE_INTERVAL_MS,
  STALL_WINDOW_MS,
  WATCH_AFTER_TEARDOWN_MS,
} from '../observe/rules';
import { type HostSample } from '../observe/sample';
import { type RungResult } from '../results/schema';
import { type P84Rung } from '../scenarios/p84-ladder';
import { type AgentEndpoint } from './endpoints';
import { type SutPort } from './monitor';

export interface RungRequest {
  readonly runId: string;
  readonly rung: P84Rung;
  readonly rampPerSecond: number;
  readonly density: number;
  readonly ice: 'turn-free' | 'relay';
  readonly calibration: boolean;
  /** The SUT address generators attribute flows to (T6/T7). */
  readonly sutAddress: string;
  /** The SUT's LiveKit ICE/UDP port the selected pairs must use (T2). */
  readonly udpPort: number;
}

export interface ControllerTiming {
  readonly helloTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly sampleIntervalMs: number;
  readonly statsIntervalMs: number;
  readonly heartbeatMs: number;
  readonly deadManMs: number;
  readonly teardownTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly phaseATimeoutMs: number;
  readonly gateTailMs: number;
  readonly watchAfterTeardownMs: number;
  readonly tickMs: number;
  readonly publishRetries: number;
  readonly inFlightPerWorker: number;
  readonly recoveryWaitMs?: number;
  readonly recheckMs?: number;
}

export const DEFAULT_TIMING: ControllerTiming = {
  helloTimeoutMs: 60_000,
  readyTimeoutMs: 120_000,
  sampleIntervalMs: SAMPLE_INTERVAL_MS,
  statsIntervalMs: STALL_WINDOW_MS,
  heartbeatMs: 2_000,
  deadManMs: 10_000,
  teardownTimeoutMs: 7_000,
  shutdownGraceMs: 10_000,
  phaseATimeoutMs: PARAMETERS['P-gate'].phaseATimeoutMs,
  gateTailMs: PARAMETERS['P-gate'].tailMs,
  watchAfterTeardownMs: WATCH_AFTER_TEARDOWN_MS,
  tickMs: 100,
  publishRetries: 3,
  inFlightPerWorker: 4,
};

export interface PostRungEvidence {
  readonly log: LivekitLogCounts | null;
  /** `access_token=` lines from generator IPs (count only; must be 0 — rtc-node uses a header). */
  readonly ticketLeaks: number | null;
}

export interface ControllerDeps {
  readonly endpoints: readonly AgentEndpoint[];
  readonly pm: ProcessManager;
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly commit: string;
  readonly rooms: RoomOps;
  readonly mint: (identity: string, role: TicketRole) => Promise<MediaTicket>;
  readonly sut: SutPort | null;
  readonly dbRows: () => Promise<number | null>;
  readonly postRung: (w: {
    sinceMs: number;
    untilMs: number;
    room: string;
    identityPrefix: string;
    generatorIps: readonly string[];
  }) => Promise<PostRungEvidence>;
  readonly csv: EventCsv | null;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** A rung's result plus every host's raw samples (the evidence the result was assembled from). */
export interface RungOutcome {
  readonly result: RungResult;
  readonly samples: Readonly<Record<string, readonly HostSample[]>>;
}
