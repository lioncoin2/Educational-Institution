/**
 * P8.4 — the verdict table (docs/p8/p8.4-verdict-table.md) as data: the ONLY
 * place in code where a band edge, sustain count, gate, recovery or sizing
 * number lives. Every other module imports from here and restates none.
 *
 * A banded table row becomes one or more BandRule entries sharing the row's ID,
 * one per condition (S-udp's "> 50, or rising in 3 windows" is two); the row's
 * band is the worst of its entries and the row fires once. `kind` carries the
 * sampling semantics: a gauge is RED after GAUGE_SUSTAIN_SAMPLES consecutive
 * samples worse than `red`, a rate (a per-window delta or ratio) after
 * RATE_SUSTAIN_WINDOWS consecutive windows, an instant rule on one observation;
 * a record rule is never banded. observe/watchdog.ts evaluates them.
 *
 * Rows judged elsewhere are not BandRules: M-gate (the controller's exact-N
 * gate, design §7), M-unbound and S-lk-err (post-rung log analysis,
 * observe/livekit-log.ts) and M-detail (record, assembled per rung). S-api and
 * S-pg / S-redis are monitored rows with no source in p84-sample/v1.
 */
import { type FailureClass } from './sample';

export type RuleScope = 'sut' | 'generator' | 'media';
export type RuleKind = 'gauge' | 'rate' | 'instant' | 'record';
/** Verdict-table provenance tags; `P8.3` is the P8.3 harness itself (exact-N gate, P8.3.6). */
export type Provenance = 'P' | 'P-stricter' | 'P837' | 'P8.3' | 'B4' | 'NEW' | 'record';
export type ClassHint = Exclude<FailureClass, 'G'>;
export type Band = 'green' | 'yellow' | 'red';

/**
 * Every metric a rule reads. `…Delta` is measured from the rung baseline,
 * `…Window` over the last sample window (prev → cur).
 */
export type MetricId =
  // SUT, from observe/derive.ts deriveSut
  | 'cpuHotBusyPct'
  | 'cpuHotSysSoftTickPct'
  | 'cpuTotalBusyPct'
  | 'load1'
  | 'memAvailableGiB'
  | 'swapUsedKb'
  | 'oomKillsDelta'
  | 'udpInErrorsDelta'
  | 'udpInErrorsWindow'
  | 'sock7882DropsDelta'
  | 'sock7882DropsWindow'
  | 'softnetDroppedDelta'
  | 'softnetDroppedWindow'
  | 'qdiscDroppedDelta'
  | 'qdiscDroppedWindow'
  | 'nicDropsErrsDelta'
  | 'nicDropsErrsWindow'
  | 'txMbps'
  | 'pps'
  | 'conntrackCount'
  | 'ngxWorkerConnErrorsDelta'
  | 'ngxUpstreamErrorsWindow'
  | 'ngxBusiestSharePct'
  | 'lkHealthNon200Consecutive'
  | 'lkHealth406'
  | 'containerRestartsDelta'
  // generator, from deriveGenerator and the agent's process accounting
  | 'gCpuHotPct'
  | 'gCpuTotalPct'
  | 'gMemAvailablePct'
  | 'gNicPct'
  | 'gDropsDelta'
  | 'gDropsWindow'
  | 'gLoopLagP95Ms'
  | 'gClockOffsetMs'
  | 'gWorkerCrashes'
  | 'gUnexplainedProcs'
  // media, aggregated by the controller (loss as a fraction, see LOSS_BANDS)
  | 'mConnectFailures'
  | 'mPublisherFaults'
  | 'mStalls'
  | 'mDrops'
  | 'mReconnects'
  | 'mLossFleetRatio'
  | 'mLossListenersRed'
  | 'mLossListenersYellow';

/** One observation's metric values; null (or absent) = the source was missing. */
export type MetricValues = Partial<Record<MetricId, number | null>>;

export interface BandRule {
  /** Verdict-table row ID, e.g. `S-cpu-hot`; a row with several conditions has several entries. */
  readonly id: string;
  readonly scope: RuleScope;
  readonly metric: MetricId;
  readonly kind: RuleKind;
  /** The direction in which the value gets worse. */
  readonly worse: 'above' | 'below';
  /** GREEN edge: GREEN when strictly better, or equal too if `greenInclusive` (null: record). */
  readonly green: number | null;
  readonly greenInclusive: boolean;
  /** RED edge (strict): worse than this is RED once sustained per `kind` (null: no RED level). */
  readonly red: number | null;
  /** Consecutive observations worse than `red` for RED, when the row overrides its kind's. */
  readonly sustain?: number;
  readonly unit: string;
  readonly provenance: readonly Provenance[];
  readonly classHint: ClassHint | null;
  readonly description: string;
}

/** Samplers read every 5 s. */
export const SAMPLE_INTERVAL_MS = 5_000;
/** [P §9] A gauge is sustained over 4 consecutive samples (t … t+15 s, the plan's "> 15 s"). */
export const GAUGE_SUSTAIN_SAMPLES = 4;
/** [P §9] A rate or delta is sustained over 3 consecutive 5 s windows. */
export const RATE_SUSTAIN_WINDOWS = 3;
/** Open windows are evaluated until teardown start + 15 s. */
export const WATCH_AFTER_TEARDOWN_MS = 15_000;
/** Classification and V-gen look at [first trigger − 15 s, trigger] (design §13). */
export const TRIGGER_LOOKBACK_MS = 15_000;
/** [NEW] M-stall: Δ`packetsReceived` = 0 between two successful stats samples ≥ 5 s apart. */
export const STALL_WINDOW_MS = 5_000;
/** [NEW] V-sampler: more than 2 consecutive missing samples on a host is a gap. */
export const SAMPLER_MAX_GAP = 2;
/**
 * [NEW] V-sampler (errata E4, E9): Σ per-process CPU ticks may exceed the host's
 * exact busy (observe/cpu-meter.ts) by at most this many ticks per process per
 * window — each process is read apart from /proc/stat and its utime/stime are
 * floored to whole ticks. (Idle/iowait flooring adds IDLE_CLOCK_RESOLUTION_TICKS
 * per core, observe/cpu-meter.ts.)
 */
export const E4_SKEW_TICKS_PER_PROCESS = 2;
/** [NEW] V-sampler: the UDP sockets every SUT sample must show. */
export const SAMPLER_EXPECTED_SOCKETS = [
  { port: 7882, count: 4 },
  { port: 3478, count: 1 },
] as const;
/** [NEW] V-clock (and G-clock RED): generator clock offset, ms. */
export const CLOCK_RED_MS = 50;
/** [NEW] S-lk-health: non-200 in 2 consecutive samples is RED. */
export const LK_HEALTH_SUSTAIN_SAMPLES = 2;
/**
 * [P] M-loss-fleet / M-loss-listener bands as loss fractions, PROVISIONAL until
 * validated against the off-box baseline; above `failure` is the plan's FAILURE.
 */
export const LOSS_BANDS = { green: 0.005, red: 0.02, failure: 0.05 } as const;
/** [NEW] Record-only content-probe detector: the median per-100 ms-block 440 Hz tone ratio (mp/tone-probe.ts blockToneRatio) a probe needs to be `ok`. */
export const PROBE_MIN_TONE_RATIO = 0.5;
/** [NEW] Capacity statement: an "acceptable YELLOW" claim needs a hold of at least 60 s. */
export const ACCEPTABLE_YELLOW_MIN_HOLD_S = 60;

const NEW: readonly Provenance[] = ['NEW'];

/** Gating, recovery and sizing parameters (all [NEW], validated as the table states). */
export const PARAMETERS = {
  /** A projection to the next rung must land in its rule's GREEN band; RED = rung BLOCKED. */
  'P-proj': { required: 'green', blocked: 'red', provenance: NEW },
  /** Per-host participants, per-process density and per-host ingress pps ≤ 2× the highest GREEN. */
  'P-step': { maxGrowth: 2, provenance: NEW },
  /** Hosts = max ⌈CPU ÷ (vCPU × cpu)⌉, ⌈RSS ÷ (RAM × ram)⌉, ⌈NIC ÷ (link × nic)⌉, × safety. */
  'P-host': { cpu: 0.6, ram: 0.75, nic: 0.5, safety: 1.5, provenance: NEW },
  /** conntrack ≤ baseline + max(fraction × baseline, absolute), `afterSeconds` after the end. */
  'P-rec-ct': { afterSeconds: 180, absolute: 200, fraction: 0.1, provenance: NEW },
  /** Hottest core and load back within the idle band measured at S2 (no fixed number). */
  'P-rec-cpu': { band: 'S2 idle', provenance: NEW },
  /** A recovery miss is re-checked once; still missed → at most YELLOW (`hostRecovered=false`). */
  'P-rec-miss': { recheckSeconds: 60, provenance: NEW },
  /** Phase A timeout; Phase B timeout = N ÷ (measured ramp rate) + `tailMs`. */
  'P-gate': { phaseATimeoutMs: 60_000, tailMs: 120_000, provenance: NEW },
} as const;

/** Validity checks: any failure makes the rung UNKNOWN, never RED. */
export const VALIDITY_IDS = {
  'V-turn':
    'Every TURN-free check T1–T7 holds (design §17); live abort on a relay candidate, relay ' +
    'socket or attributable 3478 flow',
  'V-gen':
    `Every generator signal GREEN over [first trigger − ${TRIGGER_LOOKBACK_MS / 1000} s, ` +
    'trigger] and for the whole hold',
  'V-sampler':
    `No sampler gap > ${SAMPLER_MAX_GAP} consecutive samples on any host; expected sockets ` +
    `present (${SAMPLER_EXPECTED_SOCKETS.map((s) => `${s.count} × ${s.port}`).join(', ')}); ` +
    'Σ per-process CPU ≤ host busy (errata E4)',
  'V-clock': `Generator clock offset < ${CLOCK_RED_MS} ms`,
  'V-dup':
    'No DUPLICATE_IDENTITY disconnect and no `removing duplicate participant` log line for run ' +
    'identities',
  'V-ticket': '0 `access_token=` lines from generator IPs in the rung window (count only)',
  'V-ramp':
    'An abort during the ramp with every SUT rule GREEN and no LiveKit/nginx rejection evidence ' +
    'for the failed identities = "ramp-induced suspected"',
} as const;
export type ValidityId = keyof typeof VALIDITY_IDS;

/** Consecutive observations worse than `red` that make an entry of each kind RED. */
export const SUSTAIN: Readonly<Record<Exclude<RuleKind, 'record'>, number>> = {
  gauge: GAUGE_SUSTAIN_SAMPLES,
  rate: RATE_SUSTAIN_WINDOWS,
  instant: 1,
};

type Bands = Pick<BandRule, 'kind' | 'worse' | 'green' | 'greenInclusive' | 'red' | 'sustain'>;
type RuleText = Pick<BandRule, 'unit' | 'provenance' | 'classHint' | 'description'>;

/** GREEN strictly better than `green`, RED strictly worse than `red` (`< 60 · 60–85 · > 85`). */
function band(kind: RuleKind, worse: BandRule['worse'], green: number, red: number): Bands {
  return { kind, worse, green, greenInclusive: false, red };
}

/** GREEN up to and including `green` (`≤ 18`, `0`); RED above `red`, if the row has one. */
function upTo(kind: RuleKind, green: number, red: number | null): Bands {
  return { kind, worse: 'above', green, greenInclusive: true, red };
}

const RECORD: Bands = {
  kind: 'record',
  worse: 'above',
  green: null,
  greenInclusive: false,
  red: null,
};

const entry = (
  scope: RuleScope,
  id: string,
  metric: MetricId,
  bands: Bands,
  text: RuleText,
): BandRule => ({ id, scope, metric, ...bands, ...text });

/**
 * A drop/error counter row: GREEN 0 since the rung baseline, YELLOW above 0,
 * RED above `red` since the baseline (instant; null = the row has no such
 * level) or rising — window delta > 0 — in RATE_SUSTAIN_WINDOWS windows.
 */
const counter = (
  scope: RuleScope,
  id: string,
  [delta, window]: readonly [MetricId, MetricId],
  red: number | null,
  text: RuleText,
): BandRule[] => [
  entry(scope, id, delta, upTo('instant', 0, red), text),
  entry(scope, id, window, upTo('rate', 0, 0), text),
];

export const RULES: readonly BandRule[] = [
  // SUT (vmi3631989)
  // D-12 (2026-10-05): the plan's %sys+%soft has no exact source on this kernel
  // (CONFIG_IRQ_TIME_ACCOUNTING off); the rule judges the hottest core's EXACT busy,
  // which is ≥ its %sys+%soft, with the plan's bands unchanged.
  entry('sut', 'S-cpu-hot', 'cpuHotBusyPct', band('gauge', 'above', 60, 85), {
    unit: '%',
    provenance: ['P'],
    classHint: 'C',
    description: 'Hottest core busy, exact (wall − idle − iowait)',
  }),
  entry('sut', 'S-cpu-sysSoft', 'cpuHotSysSoftTickPct', RECORD, {
    unit: '%',
    provenance: ['record'],
    classHint: null,
    description: 'Hottest core %sys+%soft, tick-sampled (diagnostic; under-reads, errata E9)',
  }),
  entry('sut', 'S-load', 'load1', upTo('gauge', 18, 18), {
    unit: 'load',
    provenance: ['P'],
    classHint: 'C',
    description: 'Load average (1 min)',
  }),
  entry('sut', 'S-cpu-total', 'cpuTotalBusyPct', RECORD, {
    unit: '%',
    provenance: ['record'],
    classHint: null,
    description: 'Total CPU busy, exact (record: the hottest core governs, plan F4)',
  }),
  entry('sut', 'S-mem', 'memAvailableGiB', band('instant', 'below', 16, 8), {
    unit: 'GiB',
    provenance: ['P-stricter'],
    classHint: 'C',
    description: 'MemAvailable',
  }),
  entry('sut', 'S-swap', 'swapUsedKb', upTo('instant', 0, 0), {
    unit: 'kB',
    provenance: ['P837'],
    classHint: 'C',
    description: 'Swap in use (the host has none)',
  }),
  entry('sut', 'S-oom', 'oomKillsDelta', upTo('instant', 0, 0), {
    unit: 'kills',
    provenance: ['P'],
    classHint: 'C',
    description: 'OOM kills (/proc/vmstat oom_kill delta)',
  }),
  ...counter('sut', 'S-udp', ['udpInErrorsDelta', 'udpInErrorsWindow'], 50, {
    unit: 'datagrams',
    provenance: ['P', 'P837'],
    classHint: 'D',
    description: 'UDP InErrors, IPv4 + IPv6 (InErrors already includes RcvbufErrors)',
  }),
  ...counter('sut', 'S-sock7882', ['sock7882DropsDelta', 'sock7882DropsWindow'], 50, {
    unit: 'packets',
    provenance: ['P', 'P837'],
    classHint: 'D',
    description: 'Per-socket drops summed over every 7882 bind (errata E1)',
  }),
  ...counter('sut', 'S-softnet', ['softnetDroppedDelta', 'softnetDroppedWindow'], 50, {
    unit: 'packets',
    provenance: ['P', 'P837'],
    classHint: 'D',
    description: 'softnet dropped',
  }),
  ...counter('sut', 'S-qdisc', ['qdiscDroppedDelta', 'qdiscDroppedWindow'], null, {
    unit: 'packets',
    provenance: ['NEW'],
    classHint: 'D',
    description: 'eth0 qdisc dropped',
  }),
  ...counter('sut', 'S-nic', ['nicDropsErrsDelta', 'nicDropsErrsWindow'], null, {
    unit: 'packets',
    provenance: ['NEW'],
    classHint: 'D',
    description: 'eth0 rx/tx drop + errs',
  }),
  entry('sut', 'S-tx', 'txMbps', band('gauge', 'above', 500, 700), {
    unit: 'Mbit/s',
    provenance: ['P'],
    classHint: 'D',
    description: 'eth0 TX bandwidth',
  }),
  entry('sut', 'S-pps', 'pps', RECORD, {
    unit: 'packets/s',
    provenance: ['record'],
    classHint: null,
    description: 'eth0 packets/s, RX + TX (record)',
  }),
  entry('sut', 'S-ct', 'conntrackCount', band('gauge', 'above', 157_286, 209_000), {
    unit: 'entries',
    provenance: ['P', 'NEW'],
    classHint: 'E',
    description: 'conntrack count (RED [P]; GREEN edge [NEW])',
  }),
  entry('sut', 'S-ngx-err', 'ngxWorkerConnErrorsDelta', upTo('instant', 0, 0), {
    unit: 'lines',
    provenance: ['P'],
    classHint: 'E',
    description: 'nginx error log `worker_connections are not enough`',
  }),
  entry('sut', 'S-ngx-5xx', 'ngxUpstreamErrorsWindow', upTo('rate', 0, 0), {
    unit: 'lines',
    provenance: ['P'],
    classHint: 'E',
    description: 'nginx upstream error-log lines (502/504) per window: GREEN flat, RED rising',
  }),
  entry('sut', 'S-ngx-share', 'ngxBusiestSharePct', band('gauge', 'above', 60, 85), {
    unit: '%',
    provenance: ['NEW'],
    classHint: 'E',
    description: 'Busiest nginx worker FDs ÷ worker_connections',
  }),
  entry('sut', 'S-lk-health', 'lkHealth406', upTo('instant', 0, 0), {
    unit: 'flag',
    provenance: ['P'],
    classHint: 'B',
    description: 'LiveKit GET http://127.0.0.1:7880/ answered 406',
  }),
  entry(
    'sut',
    'S-lk-health',
    'lkHealthNon200Consecutive',
    { ...upTo('gauge', 0, 0), sustain: LK_HEALTH_SUSTAIN_SAMPLES },
    {
      unit: 'samples',
      provenance: ['NEW'],
      classHint: 'B',
      description: 'LiveKit GET http://127.0.0.1:7880/ non-200 (no answer counts) in a row',
    },
  ),
  entry('sut', 'S-restart', 'containerRestartsDelta', upTo('instant', 0, 0), {
    unit: 'restarts',
    provenance: ['P'],
    classHint: null,
    description: 'Container restarts, api/livekit/redis/db (class B for LiveKit, E otherwise)',
  }),

  // Media (client side, aggregated by the controller)
  entry('media', 'M-connect', 'mConnectFailures', upTo('instant', 0, 0), {
    unit: 'participants',
    provenance: ['P8.3'],
    classHint: null,
    description: 'Connect failures (P8.3 exact-N gate)',
  }),
  entry('media', 'M-pub', 'mPublisherFaults', upTo('instant', 0, 0), {
    unit: 'faults',
    provenance: ['P8.3', 'B4'],
    classHint: null,
    description: 'Publisher publish failure, disconnect or stalled window during the hold',
  }),
  entry('media', 'M-stall', 'mStalls', upTo('instant', 0, 0), {
    unit: 'listener-windows',
    provenance: ['B4', 'NEW'],
    classHint: 'B',
    description: 'Listener stalls (Δ packetsReceived = 0 over a STALL_WINDOW_MS window)',
  }),
  entry('media', 'M-drop', 'mDrops', upTo('instant', 0, 0), {
    unit: 'events',
    provenance: ['B4'],
    classHint: null,
    description:
      'Disconnected / TrackUnsubscribed / TrackSubscriptionFailed (not DUPLICATE_IDENTITY)',
  }),
  entry('media', 'M-reconn', 'mReconnects', upTo('instant', 0, null), {
    unit: 'events',
    provenance: ['NEW'],
    classHint: null,
    description: 'Reconnecting → Reconnected with no stalled window',
  }),
  entry(
    'media',
    'M-loss-fleet',
    'mLossFleetRatio',
    band('rate', 'above', LOSS_BANDS.green, LOSS_BANDS.red),
    {
      unit: 'ratio',
      provenance: ['P'],
      // Loss with validity held (no generator drops) is the path or the SUT edge: design §13 class D.
      classHint: 'D',
      description: 'Fleet loss per window: Σlost ÷ Σ(received + lost) (PROVISIONAL bands)',
    },
  ),
  entry('media', 'M-loss-listener', 'mLossListenersRed', upTo('rate', 0, 0), {
    unit: 'listeners',
    provenance: ['P'],
    classHint: 'D',
    description: 'Listeners whose own window loss is above LOSS_BANDS.red (PROVISIONAL)',
  }),
  entry('media', 'M-loss-listener', 'mLossListenersYellow', upTo('rate', 0, null), {
    unit: 'listeners',
    provenance: ['P'],
    classHint: 'D',
    description: 'Listeners whose own window loss is in the YELLOW band (PROVISIONAL)',
  }),

  // Generator hosts (all [NEW]): a breach makes the generator, not the SUT, the limit
  entry('generator', 'G-cpu-hot', 'gCpuHotPct', band('gauge', 'above', 60, 85), {
    unit: '%',
    provenance: NEW,
    classHint: 'A',
    description: 'Hottest core busy, exact (wall − idle − iowait)',
  }),
  entry('generator', 'G-cpu', 'gCpuTotalPct', band('gauge', 'above', 60, 75), {
    unit: '%',
    provenance: NEW,
    classHint: 'A',
    description: 'Total CPU busy, exact',
  }),
  entry('generator', 'G-mem', 'gMemAvailablePct', band('gauge', 'below', 25, 10), {
    unit: '%',
    provenance: NEW,
    classHint: 'A',
    description: 'MemAvailable ÷ MemTotal',
  }),
  entry('generator', 'G-nic', 'gNicPct', band('gauge', 'above', 50, 70), {
    unit: '%',
    provenance: NEW,
    classHint: 'A',
    description: 'NIC RX or TX ÷ provisioned link',
  }),
  ...counter('generator', 'G-drops', ['gDropsDelta', 'gDropsWindow'], null, {
    unit: 'packets',
    provenance: NEW,
    classHint: 'A',
    description: 'Generator UDP InErrors + softnet + qdisc + NIC drops/errs',
  }),
  // PROVISIONAL — D-11 DEFERRED: these bands stay as designed until the off-box S1/S2 calibration;
  // local real-worker lag (3–79 ms p95, shared SUT host) is evidence only, never a calibration.
  entry('generator', 'G-lag', 'gLoopLagP95Ms', band('gauge', 'above', 50, 200), {
    unit: 'ms',
    provenance: NEW,
    classHint: 'A',
    description: 'Worker event-loop lag p95',
  }),
  entry('generator', 'G-clock', 'gClockOffsetMs', band('gauge', 'above', 10, CLOCK_RED_MS), {
    unit: 'ms',
    provenance: NEW,
    classHint: 'A',
    description: 'Clock offset, absolute (RED also fails V-clock)',
  }),
  entry('generator', 'G-proc', 'gWorkerCrashes', upTo('instant', 0, 0), {
    unit: 'workers',
    provenance: NEW,
    classHint: 'A',
    description: "Worker crashes in the agent's group",
  }),
  entry('generator', 'G-proc', 'gUnexplainedProcs', upTo('instant', 0, 0), {
    unit: 'processes',
    provenance: NEW,
    classHint: 'A',
    description: "Unexplained processes in the agent's group",
  }),
];

const isWorse = (rule: BandRule, value: number, edge: number): boolean =>
  rule.worse === 'above' ? value > edge : value < edge;

/** Consecutive observations worse than `red` that make this entry RED (1 = instant). */
export function sustainOf(rule: BandRule): number {
  if (rule.kind === 'record') throw new Error(`record rule ${rule.id} is never banded`);
  return rule.sustain ?? SUSTAIN[rule.kind];
}

/**
 * One value's band against an entry's edges, before any sustain (the watchdog
 * applies that); also the P-proj check of a projected value. Record rules are
 * never banded.
 */
export function levelOf(rule: BandRule, value: number): Band {
  if (rule.green === null) throw new Error(`record rule ${rule.id} is never banded`);
  if (rule.red !== null && isWorse(rule, value, rule.red)) return 'red';
  const green = rule.greenInclusive
    ? !isWorse(rule, value, rule.green)
    : isWorse(rule, rule.green, value);
  return green ? 'green' : 'yellow';
}
