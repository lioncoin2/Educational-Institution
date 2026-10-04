import { type MetricId, type MetricValues, RULES } from '../observe/rules';
import {
  FreshWorst,
  LAG_UNOBSERVED,
  type RuleObservation,
  Watchdog,
  type WatchdogStep,
} from '../observe/watchdog';

const sut = () => new Watchdog(RULES, 'sut');

const seen = (step: WatchdogStep, metric: MetricId): RuleObservation | undefined =>
  step.observations.find((o) => o.metric === metric);

/** Feeds one metric per observation (t = 0, 5000, …) and returns every step. */
function feed(
  wd: Watchdog,
  metric: MetricId,
  values: ReadonlyArray<number | null>,
): WatchdogStep[] {
  return values.map((v, i) => wd.observe(i * 5_000, { [metric]: v }));
}

describe('observe/watchdog — gauge sustain (4 consecutive samples)', () => {
  it('is YELLOW over RED for 3 samples, RED and fired on the 4th', () => {
    const steps = feed(sut(), 'cpuHotBusyPct', [90, 91, 92, 93]);
    for (const step of steps.slice(0, 3)) {
      expect(seen(step, 'cpuHotBusyPct')).toMatchObject({
        band: 'yellow',
        overRedNotSustained: true,
      });
      expect(step.fired).toEqual([]);
    }
    expect(seen(steps[3], 'cpuHotBusyPct')).toMatchObject({
      band: 'red',
      overRedNotSustained: false,
    });
    expect(steps[3].fired).toEqual([
      {
        ruleId: 'S-cpu-hot',
        metric: 'cpuHotBusyPct',
        at: 15_000,
        value: 93,
        unit: '%',
        samples: [90, 91, 92, 93],
        threshold: { op: '>', value: 85, sustain: '4 consecutive samples' },
        classHint: 'C',
        provenance: ['P'],
      },
    ]);
  });

  it('restarts the streak after a sample that is not over RED', () => {
    const steps = feed(sut(), 'cpuHotBusyPct', [90, 90, 90, 70, 90, 90, 90]);
    expect(steps.flatMap((s) => s.fired)).toEqual([]);
    expect(seen(steps[3], 'cpuHotBusyPct')).toMatchObject({
      band: 'yellow',
      overRedNotSustained: false,
    });
  });

  it('fires each row at most once, while it keeps reporting RED', () => {
    const steps = feed(sut(), 'cpuHotBusyPct', [90, 90, 90, 90, 90, 90]);
    expect(steps.flatMap((s) => s.fired)).toHaveLength(1);
    expect(seen(steps[5], 'cpuHotBusyPct')?.band).toBe('red');
  });
});

describe('observe/watchdog — rates and instant rules', () => {
  it('S-udp: rising in 2 windows is YELLOW, in 3 consecutive windows RED', () => {
    const wd = sut();
    const step = (delta: number, window: number) =>
      wd.observe(0, { udpInErrorsDelta: delta, udpInErrorsWindow: window });
    expect(seen(step(30, 0), 'udpInErrorsDelta')).toMatchObject({
      band: 'yellow',
      overRedNotSustained: false,
    });
    expect(seen(step(31, 1), 'udpInErrorsWindow')).toMatchObject({
      band: 'yellow',
      overRedNotSustained: true,
    });
    expect(step(32, 1).fired).toEqual([]);
    const third = step(33, 1);
    expect(third.fired).toMatchObject([
      {
        ruleId: 'S-udp',
        metric: 'udpInErrorsWindow',
        samples: [1, 1, 1],
        threshold: { op: '>', value: 0, sustain: '3 consecutive windows' },
        classHint: 'D',
      },
    ]);
  });

  it('S-udp: more than 50 since the baseline is RED at once', () => {
    const fired = feed(sut(), 'udpInErrorsDelta', [51])[0].fired;
    expect(fired).toMatchObject([
      { ruleId: 'S-udp', value: 51, threshold: { op: '>', value: 50, sustain: 'instant' } },
    ]);
  });

  it('S-mem: below 8 GiB is RED on a single sample', () => {
    const [step] = feed(sut(), 'memAvailableGiB', [7.9]);
    expect(step.fired).toMatchObject([
      { ruleId: 'S-mem', threshold: { op: '<', value: 8, sustain: 'instant' } },
    ]);
  });

  it('M-loss-fleet: above 2% is RED only in the 3rd consecutive window', () => {
    const steps = feed(new Watchdog(RULES, 'media'), 'mLossFleetRatio', [0.03, 0.03, 0.03]);
    expect(steps.map((s) => seen(s, 'mLossFleetRatio')?.band)).toEqual(['yellow', 'yellow', 'red']);
    expect(steps[2].fired.map((f) => f.ruleId)).toEqual(['M-loss-fleet']);
  });

  it('S-lk-health: one non-200 is YELLOW, two in a row RED; the row fires once', () => {
    const wd = sut();
    const first = wd.observe(0, { lkHealthNon200Consecutive: 1, lkHealth406: 0 });
    expect(seen(first, 'lkHealthNon200Consecutive')).toMatchObject({
      band: 'yellow',
      overRedNotSustained: true,
    });
    const second = wd.observe(5_000, { lkHealthNon200Consecutive: 2, lkHealth406: 1 });
    expect(second.fired).toHaveLength(1);
    expect(second.fired[0]).toMatchObject({ ruleId: 'S-lk-health', classHint: 'B' });
    expect(wd.worstBands()['S-lk-health']).toBe('red');
  });
});

describe('observe/watchdog — missing values', () => {
  it('reports null, absent and non-finite values as missing, never as a band', () => {
    const wd = sut();
    const values: MetricValues = { cpuHotBusyPct: null, load1: Number.NaN };
    const step = wd.observe(0, values);
    expect(step.observations).toEqual([]);
    const missing = step.missing.map((m) => m.metric);
    expect(missing).toEqual(expect.arrayContaining(['cpuHotBusyPct', 'load1', 'txMbps']));
    expect(wd.worstBands()).toEqual({});
  });

  it('a missing sample neither extends nor resets a sustained run', () => {
    const steps = feed(sut(), 'cpuHotBusyPct', [90, 90, null, 90, 90]);
    expect(steps.slice(0, 4).flatMap((s) => s.fired)).toEqual([]);
    expect(steps[2].missing.map((m) => m.metric)).toContain('cpuHotBusyPct');
    expect(steps[4].fired).toMatchObject([{ ruleId: 'S-cpu-hot', samples: [90, 90, 90, 90] }]);
  });

  it('never judges a record row and only its own scope', () => {
    const wd = new Watchdog(RULES, 'generator');
    const step = wd.observe(0, { cpuTotalBusyPct: 99, cpuHotBusyPct: 99 });
    expect(step.observations).toEqual([]);
    const metrics = step.missing.map((m) => m.metric);
    expect(metrics).toHaveLength(RULES.filter((r) => r.scope === 'generator').length);
    expect(metrics).not.toContain('cpuTotalBusyPct');
  });
});

describe('observe/watchdog — unobserved metrics and fresh windows', () => {
  const lag = (wd: Watchdog, t: number, v: number | null) =>
    wd.observe(t, { gLoopLagP95Ms: v ?? null }, v === null ? LAG_UNOBSERVED : undefined);

  it('an unobserved metric gets no band, is not missing, and neither extends nor resets a run', () => {
    const wd = new Watchdog(RULES, 'generator');
    const steps = [300, 300, null, null, null, 300, 300].map((v, i) => lag(wd, i * 5_000, v));
    for (const s of steps.slice(2, 5)) {
      expect(seen(s, 'gLoopLagP95Ms')).toBeUndefined();
      expect(s.missing.map((m) => m.metric)).not.toContain('gLoopLagP95Ms');
    }
    expect(steps.slice(0, 6).flatMap((s) => s.fired)).toEqual([]);
    expect(steps[6].fired).toMatchObject([{ ruleId: 'G-lag', samples: [300, 300, 300, 300] }]);
  });

  it('FreshWorst hands each window over once: the worst since the last take, then null', () => {
    const fresh = new FreshWorst();
    expect(fresh.take()).toBeNull();
    fresh.add(10);
    fresh.add(392);
    fresh.add(20);
    expect(fresh.take()).toBe(392);
    expect(fresh.take()).toBeNull(); // never a stale repeat
    fresh.add(0);
    expect(fresh.take()).toBe(0);
  });
});

describe('observe/watchdog — worst bands', () => {
  it('keeps the worst band each row reached, including over-RED YELLOW', () => {
    const wd = sut();
    wd.observe(0, { txMbps: 800, conntrackCount: 1_000 });
    wd.observe(5_000, { txMbps: 100, conntrackCount: 1_000 });
    expect(wd.worstBands()).toEqual({ 'S-tx': 'yellow', 'S-ct': 'green' });
  });
});
