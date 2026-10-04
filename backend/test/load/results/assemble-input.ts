/**
 * P8.4 — everything the controller hands the result assembler for one rung
 * (design §11): the timeline, the single aggregator, the monitor's samples and
 * observations, the abort, cleanup and post-rung evidence. Types only.
 */
import { type CleanupReport } from '../fleet/cleanup';
import { type RunMonitor } from '../fleet/monitor';
import { type PostRungEvidence, type RungRequest } from '../fleet/rung-config';
import { type AgentHello } from '../fleet/session';
import { type MpAggregator } from '../mp/aggregate';
import { type AbortReason } from '../observe/sample';

export interface AssembleInput {
  readonly req: RungRequest;
  readonly commit: string;
  readonly hellos: readonly AgentHello[];
  readonly times: {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly rampStart: number | null;
    readonly rampEnd: number | null;
    readonly gateAt: number | null;
    readonly holdStart: number | null;
    readonly holdEnd: number | null;
  };
  readonly holdCompleted: boolean;
  readonly gateFailure: string | null;
  /** When the gate (or phase A) failed, for the trigger lookback; null if it did not. */
  readonly failureAt: number | null;
  readonly agg: MpAggregator;
  readonly publisher: string;
  readonly minted: ReadonlySet<string>;
  /** When the global ramp granted each listener (ms), in order: the measured admission rate. */
  readonly listenerGrantedAt: readonly number[];
  readonly connectMs: readonly number[];
  readonly server: {
    readonly atGate: boolean | null;
    readonly atHoldEnd: boolean | null;
    readonly countAtGate: number | null;
    readonly countAtHoldEnd: number | null;
  };
  readonly monitor: RunMonitor;
  readonly abort: AbortReason | null;
  readonly cleanup: CleanupReport;
  readonly post: PostRungEvidence;
  readonly agentIndexOfWorker: (workerId: number) => number;
  /** Every worker process the fleet was asked to run (global shard indices). */
  readonly workerIds: readonly number[];
}
