/**
 * P8.4 — pure media-delivery judgement (design §8, §17 T2). A worker feeds it
 * the plain-data stats snapshots of the driver port (mp/driver.ts) and gets
 * back, per listener step and per observation window, whether media flowed
 * (`M-stall`), how much was lost (`M-loss-fleet`, `M-loss-listener`), whether a
 * reading was a sampler gap rather than a stall (`V-sampler`), and whether the
 * selected ICE pair proves the TURN-free path (`T2`).
 *
 * No I/O, no timers, no rtc-node. Every threshold is passed in: the numbers
 * live in observe/rules.ts only.
 */
import { type MediaStatsSnapshot } from './driver';
import {
  type CandidateType,
  type IceConfig,
  type MediaWindow,
  type TransportReport,
} from './types';

/** One listener's step between two consecutive stats readings. */
export interface StepResult {
  /**
   * `first`: no inbound baseline yet. `ok`: valid deltas. `stall`: no packet
   * for a full window (M-stall). `gap`: the reading was missing, late, not
   * newer than the previous one, or its counters were reset (V-sampler —
   * never a stall).
   */
  readonly kind: 'first' | 'ok' | 'stall' | 'gap';
  readonly receivedDelta: number;
  readonly lostDelta: number;
  /** Δlost ÷ (Δreceived + Δlost); null when both deltas are 0. */
  readonly lossRatio: number | null;
  /** Current inbound jitter; null without a usable current inbound reading. */
  readonly jitterMs: number | null;
}

export interface StepOptions {
  /** The observation window (`statsIntervalMs`), also the minimum stall interval. */
  readonly windowMs: number;
  /** Now, on the clock of `statsTsMs` and `lastPacketReceivedMs` (epoch ms). */
  readonly nowMs: number;
}

/** Loss-band edges as fractions (from observe/rules.ts). */
export interface LossThresholds {
  readonly green: number;
  readonly red: number;
}

export type LossBandName = 'green' | 'yellow' | 'red';

/** What the selected pair must prove: TURN-free (the ladder) or relay (S1 positive control). */
export interface TransportExpectation {
  readonly mode: IceConfig['mode'];
  /** The SUT's LiveKit UDP port. */
  readonly udpPort: number;
}

/** Selected local candidate types that prove a direct path (design §17 T2). */
const DIRECT_LOCAL_TYPES: ReadonlySet<CandidateType> = new Set(['host', 'srflx', 'prflx']);

const LAG_PERCENTILE = 95;

function lossRatioOf(received: number, lost: number): number | null {
  const total = received + lost;
  return total === 0 ? null : lost / total;
}

function withoutDelta(kind: StepResult['kind'], jitterMs: number | null): StepResult {
  return { kind, receivedDelta: 0, lostDelta: 0, lossRatio: null, jitterMs };
}

/**
 * Judges one listener between its previous and current reading. A stall needs
 * two successful readings at least a window apart with no new packet, and —
 * where the bindings expose it — no packet on the selected pair for a window.
 */
export function stepParticipant(
  prev: MediaStatsSnapshot | null,
  cur: MediaStatsSnapshot | null,
  opts: StepOptions,
): StepResult {
  const { windowMs, nowMs } = opts;
  if (cur === null || cur.statsTsMs < nowMs - 2 * windowMs) return withoutDelta('gap', null);
  if (prev !== null && cur.statsTsMs <= prev.statsTsMs) return withoutDelta('gap', null);
  const jitterMs = cur.inbound === null ? null : cur.inbound.jitterSec * 1000;
  if (prev === null || prev.inbound === null) return withoutDelta('first', jitterMs);
  // A vanished inbound stream is a counter reset, like counters going backwards.
  if (cur.inbound === null) return withoutDelta('gap', null);
  const receivedDelta = cur.inbound.packetsReceived - prev.inbound.packetsReceived;
  // Only packetsReceived going backwards is a counter reset. packetsLost is an
  // estimate (expected − received) that legitimately steps down when late or
  // duplicate packets arrive (W3C webrtc-stats), so a negative step counts as 0.
  if (receivedDelta < 0) return withoutDelta('gap', null);
  const lostDelta = Math.max(0, cur.inbound.packetsLost - prev.inbound.packetsLost);
  const lastPacketMs = cur.selectedPair?.lastPacketReceivedMs ?? null;
  const stalled =
    receivedDelta === 0 &&
    cur.statsTsMs - prev.statsTsMs >= windowMs &&
    (lastPacketMs === null || nowMs - lastPacketMs >= windowMs);
  return {
    kind: stalled ? 'stall' : 'ok',
    receivedDelta,
    lostDelta,
    lossRatio: lossRatioOf(receivedDelta, lostDelta),
    jitterMs,
  };
}

/** green below `bands.green`, red above `bands.red`, yellow between (edges inclusive). */
export function lossBand(ratio: number | null, bands: LossThresholds): LossBandName | null {
  if (ratio === null) return null;
  if (ratio < bands.green) return 'green';
  return ratio > bands.red ? 'red' : 'yellow';
}

/** The T2 evidence of one reading; null until a pair is selected. */
export function classifyTransport(s: MediaStatsSnapshot): TransportReport | null {
  const pair = s.selectedPair;
  if (pair === null) return null;
  return {
    protocol: pair.protocol,
    localType: pair.localType,
    remoteType: pair.remoteType,
    remotePort: pair.remotePort,
    localCandidateTypes: [...new Set(s.localCandidateTypes)].sort(),
  };
}

/**
 * T2 violations of one report; empty = proven. TURN-free requires no gathered
 * relay candidate and a udp pair from a direct local candidate to the SUT's
 * UDP port. The relay positive control requires a relay local candidate.
 */
export function transportProblems(
  report: TransportReport,
  expected: TransportExpectation,
): string[] {
  if (expected.mode === 'relay')
    return report.localType === 'relay'
      ? []
      : [`selected local candidate ${report.localType}, expected relay`];
  const problems: string[] = [];
  if (report.localCandidateTypes.includes('relay')) problems.push('relay local candidate gathered');
  if (report.protocol !== 'udp')
    problems.push(`selected protocol ${report.protocol}, expected udp`);
  if (!DIRECT_LOCAL_TYPES.has(report.localType))
    problems.push(`selected local candidate ${report.localType}, expected host/srflx/prflx`);
  if (report.remoteType === 'relay') problems.push('selected remote candidate relay');
  if (report.remotePort !== expected.udpPort)
    problems.push(
      `selected remote port ${report.remotePort ?? 'unknown'}, expected ${expected.udpPort}`,
    );
  return problems;
}

/** Nearest-rank percentile (`pct` in 1..100); 0 when there are no values. */
function nearestRank(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((pct * sorted.length) / 100) - 1] ?? 0;
}

interface ListenerWindow {
  subscribed: boolean;
  receiving: boolean;
  stalled: boolean;
  received: number;
  lost: number;
}

/**
 * One worker's observation window. Listeners are banded on their OWN window
 * loss, so one degraded listener is counted red even when the fleet ratio
 * (Σlost ÷ Σ(received + lost)) is green; a listener with no packet delta in the
 * window is in no band. A listener stepped more than once in a window is
 * merged: deltas summed, latest state, stalled if any step stalled.
 */
export class WindowAccumulator {
  private readonly listeners = new Map<string, ListenerWindow>();
  private gaps = 0;
  private jitterMsMax = 0;
  private lagsMs: number[] = [];

  constructor(private readonly bands: LossThresholds) {}

  addStep(
    participantId: string,
    step: StepResult,
    state: { readonly subscribed: boolean; readonly receiving: boolean },
  ): void {
    const w = this.listeners.get(participantId) ?? {
      subscribed: false,
      receiving: false,
      stalled: false,
      received: 0,
      lost: 0,
    };
    w.subscribed = state.subscribed;
    w.receiving = state.receiving;
    w.stalled ||= step.kind === 'stall';
    w.received += step.receivedDelta;
    w.lost += step.lostDelta;
    this.listeners.set(participantId, w);
    if (step.kind === 'gap') this.gaps += 1;
    if (step.jitterMs !== null) this.jitterMsMax = Math.max(this.jitterMsMax, step.jitterMs);
  }

  addLoopLag(ms: number): void {
    this.lagsMs.push(ms);
  }

  /** Closes the window at `t` for `listeners` hosted listeners and starts a new one. */
  flush(t: number, listeners: number): MediaWindow {
    const lossBands: Record<LossBandName, number> = { green: 0, yellow: 0, red: 0 };
    let subscribed = 0;
    let receiving = 0;
    let stalled = 0;
    let packetsReceived = 0;
    let packetsLost = 0;
    for (const w of this.listeners.values()) {
      if (w.subscribed) subscribed += 1;
      if (w.receiving) receiving += 1;
      if (w.stalled) stalled += 1;
      packetsReceived += w.received;
      packetsLost += w.lost;
      const band = lossBand(lossRatioOf(w.received, w.lost), this.bands);
      if (band !== null) lossBands[band] += 1;
    }
    const window: MediaWindow = {
      t,
      listeners,
      subscribed,
      receiving,
      stalled,
      gaps: this.gaps,
      packetsReceived,
      packetsLost,
      lossBands,
      jitterMsMax: this.jitterMsMax,
      loopLagMsP95: nearestRank(this.lagsMs, LAG_PERCENTILE),
    };
    this.listeners.clear();
    this.gaps = 0;
    this.jitterMsMax = 0;
    this.lagsMs = [];
    return window;
  }
}
