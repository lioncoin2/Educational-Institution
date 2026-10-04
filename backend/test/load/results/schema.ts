/**
 * P8.4 — the versioned per-rung result, `p84-rung-result/v1` (design §11). One
 * file per rung, written by the controller; every host's evidence correlates by
 * `runId`. Sections keep generator, SUT, network, LiveKit, media health and
 * cleanup apart, so generator cost is never read as SUT cost. Every field the
 * P8.4 requirement list names exists here under the same name. The validator
 * refuses an incomplete result instead of writing a partial one.
 */
import { type TeardownSummary } from '../mp/types';
import { type ValidityId } from '../observe/rules';
import { type AbortReason, type FailureClass } from '../observe/sample';

export const RESULT_SCHEMA = 'p84-rung-result/v1';

export type Verdict = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export interface Spread {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export interface GeneratorHostResult {
  readonly host: string;
  readonly vcpu: number;
  readonly ramGiB: number;
  readonly cpu: {
    readonly avgPct: number | null;
    readonly maxPct: number | null;
    readonly hottestCoreMaxPct: number | null;
  };
  readonly rssKb: { readonly sumMax: number | null; readonly perWorkerMax: number | null };
  readonly network: {
    readonly rxMbpsMax: number | null;
    readonly txMbpsMax: number | null;
    readonly rxPpsMax: number | null;
  };
  readonly loopLagP95Ms: number | null;
  readonly workers: number;
  readonly crashes: number;
  readonly clockOffsetMsMax: number | null;
}

export interface RungResult {
  readonly schema: typeof RESULT_SCHEMA;
  readonly meta: {
    readonly runId: string;
    readonly rung: string;
    readonly requested: number;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly harnessCommit: string;
    readonly bundleSha256: ReadonlyArray<string | null>;
    readonly calibration: { readonly density: number } | null;
  };
  readonly profile: {
    readonly rooms: 1;
    readonly publishers: 1;
    readonly media: 'audio/red 440 Hz tone, dtx off';
    readonly path: 'A';
    readonly iceMode: 'turn-free' | 'relay';
    readonly listenersHidden: false;
    readonly generatorHosts: readonly string[];
    readonly density: number;
  };
  readonly timing: {
    readonly rampDuration: number | null;
    readonly rampRate: { readonly target: number; readonly actual: number | null };
    readonly connectionDuration: Spread;
    readonly gateAt: string | null;
    readonly holdSeconds: { readonly planned: number; readonly actual: number };
  };
  readonly gate: {
    readonly connected: number;
    readonly failed: number;
    readonly crashes: number;
    readonly publisherPublished: boolean;
    readonly publisherServerConfirmed: boolean;
    readonly subscribed: number;
    readonly receiving: number;
    readonly serverIdentitySetMatch: {
      readonly atGate: boolean | null;
      readonly atHoldEnd: boolean | null;
    };
    readonly gateMet: boolean;
  };
  readonly media: {
    readonly stalls: number;
    readonly disconnects: Readonly<Record<string, number>>;
    readonly reconnects: number;
    readonly unsubscribes: number;
    readonly packetLoss: {
      readonly fleet: number | null;
      readonly listenersByBand: {
        readonly green: number;
        readonly yellow: number;
        readonly red: number;
      };
    };
    readonly jitterMsMax: number | null;
    readonly trackNotBound: number | null;
    readonly contentProbe: { readonly probes: number; readonly ok: number };
  };
  readonly transport: {
    readonly selectedPairs: Readonly<Record<string, number>>;
    readonly relayCandidates: number;
    readonly relaySocketsMax: number | null;
    readonly fwNewFlows3478Delta: number | null;
    readonly generatorFlowsTo3478Max: number | null;
    readonly turnTlsEstabMax: number | null;
    readonly turnQuotaEvents: number | null;
  };
  readonly generator: {
    readonly generatorCount: number;
    readonly hosts: readonly GeneratorHostResult[];
    readonly generatorCPU: { readonly avgCores: number | null; readonly maxCores: number | null };
    readonly generatorRSS: { readonly maxKb: number | null };
    readonly generatorNetwork: {
      readonly rxMbpsMax: number | null;
      readonly txMbpsMax: number | null;
    };
    readonly perParticipant: { readonly cpuCores: number | null; readonly rssKb: number | null };
  };
  readonly sut: {
    /** Exact busy (observe/cpu-meter.ts, D-12); the tick-sampled %sys+%soft is a diagnostic only. */
    readonly sutCPU: {
      readonly totalAvgPct: number | null;
      readonly hottestCoreMaxPct: number | null;
      readonly hottestCoreSysSoftTickMaxPct: number | null;
    };
    readonly sutRSS: { readonly usedKbMax: number | null };
    readonly memAvailableMinKb: number | null;
    readonly swapUsedKbMax: number | null;
    readonly oomKills: number | null;
    readonly loadAvgMax: number | null;
    readonly harnessOverhead: {
      readonly cpuCoresAvg: number | null;
      readonly rssKbMax: number | null;
    };
  };
  readonly network: {
    readonly sutNetwork: {
      readonly rxMbpsMax: number | null;
      readonly txMbpsMax: number | null;
      readonly txPpsMax: number | null;
    };
    readonly udpErrors: number | null;
    readonly udpRcvbufErrors: number | null;
    readonly perSocketDrops: Readonly<Record<string, number>>;
    readonly softnetDrops: number | null;
    readonly qdiscDrops: number | null;
    readonly nicDropsErrs: number | null;
    readonly conntrack: { readonly max: number | null; readonly perParticipant: number | null };
    readonly packetLoss: number | null;
  };
  readonly livekit: {
    readonly cpu: { readonly avgPct: number | null; readonly maxPct: number | null };
    readonly rssKb: { readonly max: number | null };
    readonly fds: { readonly max: number | null };
    readonly participants: { readonly atGate: number | null; readonly atHoldEnd: number | null };
    readonly reconnects: number;
    readonly connectionFailures: number;
    readonly errorLines: number | null;
    readonly restarts: number | null;
  };
  readonly nginx: {
    readonly workerConnections: number | null;
    readonly busiestWorkerFdsMax: number | null;
    /** Busiest worker's FDs in the rung baseline (idle: listeners, logs, channels) — the fixed part. */
    readonly baselineWorkerFdsMax: number | null;
    readonly perWorkerFdsAtGate: readonly number[];
    readonly errorLines: {
      readonly workerConnections: number | null;
      readonly upstream: number | null;
    };
  };
  readonly docker: {
    readonly containers: ReadonlyArray<{
      readonly name: string;
      readonly health: string;
      readonly restarts: number;
    }>;
    readonly containerRestarts: number | null;
  };
  readonly watchdog: {
    readonly safetyAbort: AbortReason | null;
    readonly firedRules: readonly string[];
    readonly yellowRules: readonly string[];
    readonly missingMetrics: readonly string[];
  };
  readonly validity: Readonly<
    Record<ValidityId, { readonly ok: boolean; readonly detail: string }>
  >;
  readonly cleanup: {
    /** How every worker process ended (P8.3.8 classes; forced kills never folded into cleaned). */
    readonly teardown: TeardownSummary;
    readonly cleanupRooms: number | null;
    readonly cleanupParticipants: number | null;
    readonly cleanupRows: number | null;
    readonly generatorProcesses: Readonly<Record<string, number | null>>;
    readonly relaySockets: number | null;
    readonly hostRecovered: { readonly conntrack: boolean | null; readonly cpu: boolean | null };
    readonly verified: boolean;
  };
  readonly verdict: {
    readonly class: Verdict;
    readonly pass: boolean;
    readonly acceptableYellow: boolean | null;
    readonly failureClass: FailureClass | null;
    readonly contributing: readonly FailureClass[];
    readonly reasons: readonly string[];
  };
  readonly evidence: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

/** Every path that must be present (null is allowed; undefined is not). */
const REQUIRED: readonly string[] = [
  'meta.runId',
  'meta.rung',
  'meta.requested',
  'gate.connected',
  'gate.failed',
  'gate.publisherPublished',
  'timing.holdSeconds',
  'timing.rampDuration',
  'timing.connectionDuration',
  'generator.generatorCount',
  'generator.generatorCPU',
  'generator.generatorRSS',
  'generator.generatorNetwork',
  'sut.sutCPU',
  'sut.sutRSS',
  'network.sutNetwork',
  'network.udpErrors',
  'network.udpRcvbufErrors',
  'network.softnetDrops',
  'network.conntrack',
  'network.packetLoss',
  'media.reconnects',
  'docker.containerRestarts',
  'cleanup.teardown',
  'cleanup.cleanupRooms',
  'cleanup.cleanupParticipants',
  'cleanup.cleanupRows',
  'verdict.class',
  'validity',
  'watchdog',
  'evidence',
];

/** Problems that make a result unwritable; empty = valid. */
export function validateResult(r: unknown): string[] {
  if (typeof r !== 'object' || r === null) return ['result is not an object'];
  const problems: string[] = [];
  if ((r as { schema?: unknown }).schema !== RESULT_SCHEMA)
    problems.push(`schema must be ${RESULT_SCHEMA}`);
  for (const path of REQUIRED) {
    let at: unknown = r;
    for (const key of path.split('.'))
      at = typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined;
    if (at === undefined) problems.push(`missing ${path}`);
  }
  return problems;
}
