import {
  ACCEPTABLE_YELLOW_MIN_HOLD_S,
  type Band,
  type ClassHint,
  CLOCK_RED_MS,
  GAUGE_SUSTAIN_SAMPLES,
  LOSS_BANDS,
  levelOf,
  type MetricId,
  PARAMETERS,
  PROBE_MIN_TONE_RATIO,
  type Provenance,
  RATE_SUSTAIN_WINDOWS,
  type RuleKind,
  RULES,
  SAMPLE_INTERVAL_MS,
  SAMPLER_EXPECTED_SOCKETS,
  SAMPLER_MAX_GAP,
  STALL_WINDOW_MS,
  sustainOf,
  TRIGGER_LOOKBACK_MS,
  VALIDITY_IDS,
  WATCH_AFTER_TEARDOWN_MS,
} from '../observe/rules';

interface EntrySpec {
  readonly metric: MetricId;
  readonly kind: RuleKind;
  readonly provenance: readonly Provenance[];
  readonly classHint: ClassHint | null;
  /** [value, band before sustain] — every edge exactly as the verdict table writes it. */
  readonly cases: ReadonlyArray<readonly [number, Band]>;
}

const e = (
  metric: MetricId,
  kind: RuleKind,
  provenance: readonly Provenance[],
  classHint: ClassHint | null,
  cases: ReadonlyArray<readonly [number, Band]>,
): EntrySpec => ({ metric, kind, provenance, classHint, cases });

/** "< g · g–r · > r" for a value that gets worse upwards. */
const edges = (g: number, r: number, step: number): Array<[number, Band]> => [
  [g - step, 'green'],
  [g, 'yellow'],
  [r, 'yellow'],
  [r + step, 'red'],
];
const ZERO_ANY: Array<[number, Band]> = [
  [0, 'green'],
  [1, 'red'],
];
/** Counter delta since baseline: 0 · 1–50 · > 50. */
const UP_TO_50: Array<[number, Band]> = [
  [0, 'green'],
  [1, 'yellow'],
  [50, 'yellow'],
  [51, 'red'],
];
/** Counter delta with no RED level of its own (only rising is RED). */
const ANY_YELLOW: Array<[number, Band]> = [
  [0, 'green'],
  [1, 'yellow'],
  [1e9, 'yellow'],
];

/** The verdict table, row by row: what each encoded entry must say. */
const TABLE: Readonly<Record<string, readonly EntrySpec[]>> = {
  'S-cpu-hot': [e('cpuHotBusyPct', 'gauge', ['P'], 'C', edges(60, 85, 0.1))],
  'S-cpu-sysSoft': [e('cpuHotSysSoftTickPct', 'record', ['record'], null, [])],
  'S-load': [
    e('load1', 'gauge', ['P'], 'C', [
      [18, 'green'],
      [18.01, 'red'],
    ]),
  ],
  'S-cpu-total': [e('cpuTotalBusyPct', 'record', ['record'], null, [])],
  'S-mem': [
    e('memAvailableGiB', 'instant', ['P-stricter'], 'C', [
      [16.1, 'green'],
      [16, 'yellow'],
      [8, 'yellow'],
      [7.9, 'red'],
    ]),
  ],
  'S-swap': [e('swapUsedKb', 'instant', ['P837'], 'C', ZERO_ANY)],
  'S-oom': [e('oomKillsDelta', 'instant', ['P'], 'C', ZERO_ANY)],
  'S-udp': [
    e('udpInErrorsDelta', 'instant', ['P', 'P837'], 'D', UP_TO_50),
    e('udpInErrorsWindow', 'rate', ['P', 'P837'], 'D', ZERO_ANY),
  ],
  'S-sock7882': [
    e('sock7882DropsDelta', 'instant', ['P', 'P837'], 'D', UP_TO_50),
    e('sock7882DropsWindow', 'rate', ['P', 'P837'], 'D', ZERO_ANY),
  ],
  'S-softnet': [
    e('softnetDroppedDelta', 'instant', ['P', 'P837'], 'D', UP_TO_50),
    e('softnetDroppedWindow', 'rate', ['P', 'P837'], 'D', ZERO_ANY),
  ],
  'S-qdisc': [
    e('qdiscDroppedDelta', 'instant', ['NEW'], 'D', ANY_YELLOW),
    e('qdiscDroppedWindow', 'rate', ['NEW'], 'D', ZERO_ANY),
  ],
  'S-nic': [
    e('nicDropsErrsDelta', 'instant', ['NEW'], 'D', ANY_YELLOW),
    e('nicDropsErrsWindow', 'rate', ['NEW'], 'D', ZERO_ANY),
  ],
  'S-tx': [e('txMbps', 'gauge', ['P'], 'D', edges(500, 700, 0.1))],
  'S-pps': [e('pps', 'record', ['record'], null, [])],
  'S-ct': [e('conntrackCount', 'gauge', ['P', 'NEW'], 'E', edges(157_286, 209_000, 1))],
  'S-ngx-err': [e('ngxWorkerConnErrorsDelta', 'instant', ['P'], 'E', ZERO_ANY)],
  'S-ngx-5xx': [e('ngxUpstreamErrorsWindow', 'rate', ['P'], 'E', ZERO_ANY)],
  'S-ngx-share': [e('ngxBusiestSharePct', 'gauge', ['NEW'], 'E', edges(60, 85, 0.1))],
  'S-lk-health': [
    e('lkHealth406', 'instant', ['P'], 'B', ZERO_ANY),
    e('lkHealthNon200Consecutive', 'gauge', ['NEW'], 'B', ZERO_ANY),
  ],
  'S-restart': [e('containerRestartsDelta', 'instant', ['P'], null, ZERO_ANY)],
  'M-connect': [e('mConnectFailures', 'instant', ['P8.3'], null, ZERO_ANY)],
  'M-pub': [e('mPublisherFaults', 'instant', ['P8.3', 'B4'], null, ZERO_ANY)],
  'M-stall': [e('mStalls', 'instant', ['B4', 'NEW'], 'B', ZERO_ANY)],
  'M-drop': [e('mDrops', 'instant', ['B4'], null, ZERO_ANY)],
  'M-reconn': [e('mReconnects', 'instant', ['NEW'], null, ANY_YELLOW)],
  'M-loss-fleet': [
    e('mLossFleetRatio', 'rate', ['P'], 'D', [
      [0.0049, 'green'],
      [0.005, 'yellow'],
      [0.02, 'yellow'],
      [0.0201, 'red'],
    ]),
  ],
  'M-loss-listener': [
    e('mLossListenersRed', 'rate', ['P'], 'D', ZERO_ANY),
    e('mLossListenersYellow', 'rate', ['P'], 'D', ANY_YELLOW),
  ],
  'G-cpu-hot': [e('gCpuHotPct', 'gauge', ['NEW'], 'A', edges(60, 85, 0.1))],
  'G-cpu': [e('gCpuTotalPct', 'gauge', ['NEW'], 'A', edges(60, 75, 0.1))],
  'G-mem': [
    e('gMemAvailablePct', 'gauge', ['NEW'], 'A', [
      [25.1, 'green'],
      [25, 'yellow'],
      [10, 'yellow'],
      [9.9, 'red'],
    ]),
  ],
  'G-nic': [e('gNicPct', 'gauge', ['NEW'], 'A', edges(50, 70, 0.1))],
  'G-drops': [
    e('gDropsDelta', 'instant', ['NEW'], 'A', ANY_YELLOW),
    e('gDropsWindow', 'rate', ['NEW'], 'A', ZERO_ANY),
  ],
  'G-lag': [e('gLoopLagP95Ms', 'gauge', ['NEW'], 'A', edges(50, 200, 0.1))],
  'G-clock': [e('gClockOffsetMs', 'gauge', ['NEW'], 'A', edges(10, 50, 0.1))],
  'G-proc': [
    e('gWorkerCrashes', 'instant', ['NEW'], 'A', ZERO_ANY),
    e('gUnexplainedProcs', 'instant', ['NEW'], 'A', ZERO_ANY),
  ],
};

describe('observe/rules — the verdict table as data', () => {
  it('encodes exactly the rows the watchdog judges, each in its scope', () => {
    expect([...new Set(RULES.map((r) => r.id))].sort()).toEqual(Object.keys(TABLE).sort());
    const prefix = { sut: 'S-', media: 'M-', generator: 'G-' } as const;
    for (const r of RULES)
      expect(`${r.id} ${r.scope}`).toBe(`${prefix[r.scope]}${r.id.slice(2)} ${r.scope}`);
    const keys = RULES.map((r) => `${r.id}/${r.metric}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(Object.entries(TABLE))('%s: kind, tags and band edges as the table', (id, specs) => {
    const entries = RULES.filter((r) => r.id === id);
    expect(entries.map((r) => r.metric)).toEqual(specs.map((s) => s.metric));
    for (const spec of specs) {
      const rule = entries.find((r) => r.metric === spec.metric)!;
      expect({ kind: rule.kind, provenance: rule.provenance, classHint: rule.classHint }).toEqual({
        kind: spec.kind,
        provenance: spec.provenance,
        classHint: spec.classHint,
      });
      expect(rule.unit).not.toBe('');
      expect(rule.description).not.toBe('');
      const got = spec.cases.map(([value]) => [value, levelOf(rule, value)]);
      expect(got).toEqual(spec.cases);
    }
  });

  it('never bands a record row', () => {
    for (const rule of RULES.filter((r) => r.kind === 'record')) {
      expect([rule.green, rule.red]).toEqual([null, null]);
      expect(() => levelOf(rule, 1)).toThrow(/never banded/);
      expect(() => sustainOf(rule)).toThrow(/never banded/);
    }
  });

  it('maps kinds to the sampling semantics; S-lk-health needs 2 consecutive samples', () => {
    const rule = (id: string, metric: MetricId) =>
      RULES.find((r) => r.id === id && r.metric === metric)!;
    expect(sustainOf(rule('S-cpu-hot', 'cpuHotBusyPct'))).toBe(4);
    expect(sustainOf(rule('S-udp', 'udpInErrorsWindow'))).toBe(3);
    expect(sustainOf(rule('S-mem', 'memAvailableGiB'))).toBe(1);
    expect(sustainOf(rule('S-lk-health', 'lkHealthNon200Consecutive'))).toBe(2);
    expect([GAUGE_SUSTAIN_SAMPLES, RATE_SUSTAIN_WINDOWS]).toEqual([4, 3]);
  });

  it('holds the sampling, validity and media constants of the table', () => {
    expect({
      SAMPLE_INTERVAL_MS,
      WATCH_AFTER_TEARDOWN_MS,
      TRIGGER_LOOKBACK_MS,
      STALL_WINDOW_MS,
      SAMPLER_MAX_GAP,
      CLOCK_RED_MS,
      ACCEPTABLE_YELLOW_MIN_HOLD_S,
      PROBE_MIN_TONE_RATIO,
    }).toEqual({
      SAMPLE_INTERVAL_MS: 5_000,
      WATCH_AFTER_TEARDOWN_MS: 15_000,
      TRIGGER_LOOKBACK_MS: 15_000,
      STALL_WINDOW_MS: 5_000,
      SAMPLER_MAX_GAP: 2,
      CLOCK_RED_MS: 50,
      ACCEPTABLE_YELLOW_MIN_HOLD_S: 60,
      PROBE_MIN_TONE_RATIO: 0.5,
    });
    expect(LOSS_BANDS).toEqual({ green: 0.005, red: 0.02, failure: 0.05 });
    expect(SAMPLER_EXPECTED_SOCKETS).toEqual([
      { port: 7882, count: 4 },
      { port: 3478, count: 1 },
    ]);
  });

  it('holds the gating, recovery and sizing parameters, all [NEW]', () => {
    expect(PARAMETERS['P-step'].maxGrowth).toBe(2);
    expect(PARAMETERS['P-host']).toMatchObject({ cpu: 0.6, ram: 0.75, nic: 0.5, safety: 1.5 });
    expect(PARAMETERS['P-rec-ct']).toMatchObject({
      afterSeconds: 180,
      absolute: 200,
      fraction: 0.1,
    });
    expect(PARAMETERS['P-rec-miss'].recheckSeconds).toBe(60);
    expect(PARAMETERS['P-gate']).toMatchObject({ phaseATimeoutMs: 60_000, tailMs: 120_000 });
    expect(PARAMETERS['P-proj']).toMatchObject({ required: 'green', blocked: 'red' });
    for (const p of Object.values(PARAMETERS)) expect(p.provenance).toEqual(['NEW']);
  });

  it('lists every validity check, rendered from the same constants', () => {
    expect(Object.keys(VALIDITY_IDS)).toEqual([
      'V-turn',
      'V-gen',
      'V-sampler',
      'V-clock',
      'V-dup',
      'V-ticket',
      'V-ramp',
    ]);
    expect(VALIDITY_IDS['V-sampler']).toContain('gap > 2 consecutive');
    expect(VALIDITY_IDS['V-sampler']).toContain('4 × 7882, 1 × 3478');
    expect(VALIDITY_IDS['V-clock']).toBe('Generator clock offset < 50 ms');
    expect(VALIDITY_IDS['V-gen']).toContain('[first trigger − 15 s, trigger]');
  });
});
