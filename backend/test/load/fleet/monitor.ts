/**
 * P8.4 — the controller's in-run evaluation (design §9). It samples the SUT
 * (in-process), receives every generator sample, and feeds the pure watchdogs:
 *
 *   SUT rules       → abort on RED (safety);
 *   generator rules → classification evidence (V-gen; the agent aborts itself
 *                     on RED, and so does this monitor as a backstop);
 *   media rules     → abort on RED, from the single aggregator's evidence.
 *
 * It keeps every sample, fired rule, YELLOW observation and missing metric for
 * the result. It never kills anything: aborting is the controller's job.
 */
import { type MpAggregator } from '../mp/aggregate';
import { deriveGenerator, deriveSut, type SutState } from '../observe/derive';
import { type MetricId, type MetricValues, RULES, type RuleScope } from '../observe/rules';
import { type AbortReason, ABORT_SCHEMA, type HostSample } from '../observe/sample';
import { type FiredRule, LAG_UNOBSERVED, Watchdog } from '../observe/watchdog';

export interface SutPort {
  baseline(): Promise<void>;
  sample(): Promise<HostSample>;
}

export interface FiredRecord extends FiredRule {
  readonly scope: RuleScope;
  readonly host: string;
}

export class RunMonitor {
  readonly sutSamples: HostSample[] = [];
  readonly genSamples = new Map<number, HostSample[]>();
  readonly fired: FiredRecord[] = [];
  /** Every non-GREEN observation with its time: classification filters by window (hold, trigger lookback). */
  readonly notGreen: Array<{
    readonly ruleId: string;
    readonly scope: RuleScope;
    readonly at: number;
    readonly overRed: boolean;
  }> = [];
  readonly missing = new Set<string>();
  /** Agents whose generator rules were evaluated at least once (V-sampler fails closed otherwise). */
  readonly judgedAgents = new Set<number>();
  /** Agents that have reported at least one worker lag window. */
  private readonly lagSeen = new Set<number>();
  private readonly sutWatch = new Watchdog(RULES, 'sut');
  private readonly mediaWatch = new Watchdog(RULES, 'media');
  private readonly genWatch = new Map<number, Watchdog>();
  private sutState: SutState = { lkNon200Consecutive: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;

  constructor(
    private readonly o: { runId: string; rung: string; intervalMs: number },
    private readonly sut: SutPort | null,
    private readonly onAbort: (reason: AbortReason) => void,
  ) {}

  /** Takes the SUT baseline sample and starts periodic SUT evaluation. */
  async start(): Promise<void> {
    if (!this.sut) return;
    await this.sut.baseline();
    this.sutSamples.push(await this.sut.sample());
    this.timer = setInterval(() => void this.sutTick(), this.o.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  baseline(): HostSample | null {
    return this.sutSamples[0] ?? null;
  }

  /**
   * One generator sample; `loopLagP95Ms` is the worst of that agent's worker windows that
   * arrived SINCE ITS PREVIOUS SAMPLE (null: none arrived — G-lag is then unobserved for this
   * sample, never a stale repeat).
   */
  addGeneratorSample(
    agent: number,
    sample: HostSample,
    crashes: number,
    loopLagP95Ms: number | null,
  ): void {
    const series = this.genSamples.get(agent) ?? [];
    series.push(sample);
    this.genSamples.set(agent, series);
    // Warm-up: the first sample has no window to rate, and lag exists only once
    // the agent's workers have reported a media window. Until both exist the
    // sample is kept as evidence but not judged (no metric is "missing" yet).
    if (loopLagP95Ms !== null) this.lagSeen.add(agent);
    if (series.length < 2 || !this.lagSeen.has(agent)) return;
    this.judgedAgents.add(agent);
    const watch = this.genWatch.get(agent) ?? new Watchdog(RULES, 'generator');
    this.genWatch.set(agent, watch);
    const { metrics } = deriveGenerator(
      series[0] ?? sample,
      series[series.length - 2] ?? null,
      sample,
      {
        linkMbps: sample.gen?.linkMbps ?? null,
        loopLagP95Ms,
      },
    );
    const group = sample.gen?.processGroup ?? null;
    this.evaluate(
      watch,
      'generator',
      sample.host,
      sample.t,
      {
        ...metrics,
        gWorkerCrashes: crashes,
        gUnexplainedProcs: group === null ? null : group.unexplained,
      },
      loopLagP95Ms === null ? LAG_UNOBSERVED : undefined,
    );
  }

  /** Media rules over the aggregator's evidence since the hold started. */
  evaluateMedia(t: number, metrics: MetricValues): void {
    this.evaluate(this.mediaWatch, 'media', 'fleet', t, metrics);
  }

  /**
   * One SUT sample, never overlapping the previous one: a sample slower than the interval
   * delays the next instead of racing it. Overlapping samples completed out of read order,
   * so a "current" sample could carry OLDER counters than the previous one (negative deltas
   * → S-cpu-hot / S-tx missing; seen intermittently under a loaded test machine). A sample
   * that completes after stop() is discarded.
   */
  private async sutTick(): Promise<void> {
    if (!this.sut || this.sampling) return;
    this.sampling = true;
    try {
      await this.sampleAndJudge(this.sut);
    } finally {
      this.sampling = false;
    }
  }

  private async sampleAndJudge(sut: SutPort): Promise<void> {
    const sample = await sut.sample().catch(() => null);
    if (this.timer === null) return; // stopped while sampling
    if (!sample) {
      this.missing.add('sut:sample'); // a failed SUT read fails V-sampler, never passes silently
      return;
    }
    const baseline = this.sutSamples[0] ?? sample;
    const prev = this.sutSamples[this.sutSamples.length - 1] ?? null;
    this.sutSamples.push(sample);
    const { metrics, state } = deriveSut(baseline, prev, sample, this.sutState);
    this.sutState = state;
    this.evaluate(this.sutWatch, 'sut', 'sut', sample.t, metrics);
  }

  private evaluate(
    watch: Watchdog,
    scope: RuleScope,
    host: string,
    t: number,
    m: MetricValues,
    unobserved?: ReadonlySet<MetricId>,
  ): void {
    const step = watch.observe(t, m, unobserved);
    for (const o of step.observations) {
      if (o.band !== 'green')
        this.notGreen.push({ ruleId: o.ruleId, scope, at: o.at, overRed: o.overRedNotSustained });
    }
    for (const miss of step.missing) this.missing.add(`${host}:${miss.ruleId}`);
    for (const f of step.fired) {
      this.fired.push({ ...f, scope, host });
      this.onAbort({
        schema: ABORT_SCHEMA,
        runId: this.o.runId,
        rung: this.o.rung,
        at: f.at,
        source:
          scope === 'generator'
            ? `gen-watchdog:${host}`
            : scope === 'sut'
              ? 'sut-watchdog'
              : 'controller',
        rule: f.ruleId,
        observed: { value: f.value, unit: f.unit, samples: f.samples },
        threshold: f.threshold,
        classHint: f.classHint,
        validity: scope === 'generator',
        detail: `${f.ruleId} ${f.threshold.op} ${f.threshold.value} (${f.threshold.sustain})`,
      });
    }
  }
}

/** Media metric values for the media rules, from the single aggregator (pure). */
export function mediaMetrics(agg: MpAggregator, publisher: string, since: number): MetricValues {
  const faults = agg.media.faults().filter((f) => f.at >= since);
  const isDup = (reason: string | null): boolean => reason === 'DUPLICATE_IDENTITY';
  const windows = agg.media.latestWindows(since);
  const received = windows.reduce((n, w) => n + w.packetsReceived, 0);
  const lost = windows.reduce((n, w) => n + w.packetsLost, 0);
  return {
    mConnectFailures: agg.failed(),
    mPublisherFaults: faults.filter(
      (f) => f.participantId === publisher && f.fault !== 'reconnected',
    ).length,
    mStalls: faults.filter((f) => f.fault === 'stall').length,
    mDrops: faults.filter(
      (f) =>
        (f.fault === 'disconnected' && !isDup(f.reason)) ||
        f.fault === 'unsubscribed' ||
        f.fault === 'subscriptionFailed' ||
        f.fault === 'publisherGone',
    ).length,
    mReconnects: faults.filter((f) => f.fault === 'reconnected').length,
    mLossFleetRatio: received + lost > 0 ? lost / (received + lost) : null,
    mLossListenersRed: windows.length > 0 ? windows.reduce((n, w) => n + w.lossBands.red, 0) : null,
    mLossListenersYellow:
      windows.length > 0 ? windows.reduce((n, w) => n + w.lossBands.yellow, 0) : null,
  };
}
