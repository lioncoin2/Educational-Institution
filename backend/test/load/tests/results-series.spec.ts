import { deriveGenerator, deriveSut } from '../observe/derive';
import { CLK_TCK, type HostSample } from '../observe/sample';
import {
  admissionRate,
  delta,
  inWindow,
  maxOf,
  meanOf,
  metric,
  minOf,
  nicDropsErrs,
  pairRate,
  percentile,
  procCores,
  procCoresSeries,
  procRssMax,
  socketDropDeltas,
  udpErrors,
  udpRcvbuf,
  windows,
} from '../results/series';
import { core, genSample, net, proc, sample, sutSection, udp } from './support/result-fixtures';

// ---------------------------------------------------------------------------
// results/series.ts
// ---------------------------------------------------------------------------

describe('results/series — admissionRate (the reported ramp rate)', () => {
  it('n issues are n − 1 intervals: 10/s paced issues measure exactly 10/s', () => {
    expect(admissionRate(Array.from({ length: 20 }, (_, i) => i * 100))).toBe(10);
  });

  it('regression: a single admission has no rate (the first real S1 reported 9.4/s for one listener)', () => {
    expect(admissionRate([1_000])).toBeNull();
    expect(admissionRate([])).toBeNull();
    expect(admissionRate([1_000, 1_000])).toBeNull(); // no elapsed time
  });
});

describe('results/series — percentile (nearest rank)', () => {
  it('matches the textbook nearest-rank values and does not mutate its input', () => {
    const xs = [50, 15, 40, 20, 35];
    expect(percentile(xs, 5)).toBe(15);
    expect(percentile(xs, 30)).toBe(20);
    expect(percentile(xs, 40)).toBe(20);
    expect(percentile(xs, 50)).toBe(35);
    expect(percentile(xs, 100)).toBe(50);
    expect(xs).toEqual([50, 15, 40, 20, 35]);
  });

  it('p95 / p50 over 1..20 and 1..100; one value; empty is null', () => {
    const to = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
    expect(percentile(to(20), 95)).toBe(19);
    expect(percentile(to(20), 50)).toBe(10);
    expect(percentile(to(100), 95)).toBe(95);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it('clamps p outside 0..100 to the first / last value', () => {
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], -10)).toBe(1);
    expect(percentile([3, 1, 2], 150)).toBe(3);
  });

  it('rank is exact for every integer p (no floating-point rank overshoot)', () => {
    // Regression: rank = ceil((p / 100) × n) gave (55 / 100) × 100 = 55.00000000000001 → rank 56.
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 55)).toBe(55);
    expect(percentile(hundred, 7)).toBe(7);
  });
});

describe('results/series — counters and process CPU', () => {
  it('delta = last − first; null when either end is unreadable; middle samples do not matter', () => {
    const oom = (v: number | null): HostSample => sample({ oomKills: v });
    const read = (s: HostSample): number | null => s.oomKills;
    expect(delta([oom(1), oom(null), oom(4)], read)).toBe(3);
    expect(delta([oom(5)], read)).toBe(0);
    expect(delta([], read)).toBeNull();
    expect(delta([oom(null), oom(4)], read)).toBeNull();
    expect(delta([oom(1), oom(null)], read)).toBeNull();
    expect(delta([sample({ sut: null }), sample()], (s) => s.sut?.fwNewFlows?.udp3478)).toBeNull();
  });

  it('udpErrors / udpRcvbuf sum v4 + v6 and are null without both; nicDropsErrs sums drops and errs', () => {
    const s = sample({
      udp: { v4: udp(3, 2), v6: udp(1, 1) },
      net: net({ rxDrop: 1, txDrop: 2, rxErr: 3, txErr: 4 }),
    });
    expect(udpErrors(s)).toBe(4);
    expect(udpRcvbuf(s)).toBe(3);
    expect(nicDropsErrs(s)).toBe(10);
    expect(udpErrors(sample({ udp: { v4: udp(3), v6: null } }))).toBeNull();
    expect(udpRcvbuf(sample({ udp: { v4: null, v6: udp(1) } }))).toBeNull();
    expect(nicDropsErrs(sample({ net: null }))).toBeNull();
  });

  it('procCores = Δ(utime+stime) ÷ (CLK_TCK × wall s), summed over the matching roles', () => {
    expect(CLK_TCK).toBe(100);
    const series = [
      sample({
        t: 0,
        procs: [proc(10, 'controller', 100), proc(20, 'worker:0', 1_000), proc(21, 'worker:1', 0)],
      }),
      sample({ t: 5_000, procs: [proc(10, 'controller', 400)] }),
      sample({
        t: 10_000,
        procs: [
          proc(10, 'controller', 600),
          proc(20, 'worker:0', 6_000),
          proc(21, 'worker:1', 5_000),
        ],
      }),
    ];
    expect(procCores(series, (r) => r === 'controller')).toBeCloseTo(500 / CLK_TCK / 10, 12);
    expect(procCores(series, (r) => r.startsWith('worker'))).toBeCloseTo(10_000 / CLK_TCK / 10, 12);
    // No matching process at both ends is unknown, not zero cores.
    expect(procCores(series, (r) => r === 'livekit')).toBeNull();
  });

  it('procCores is null without two samples spanning positive time', () => {
    const p = [proc(10, 'controller', 100)];
    expect(procCores([], () => true)).toBeNull();
    expect(procCores([sample({ t: 0, procs: p })], () => true)).toBeNull();
    expect(
      procCores([sample({ t: 5, procs: p }), sample({ t: 5, procs: p })], () => true),
    ).toBeNull();
    expect(
      procCores([sample({ t: 9, procs: p }), sample({ t: 5, procs: p })], () => true),
    ).toBeNull();
  });

  it('procCores: a process whose FIRST-sample read failed is not counted from 0 ticks', () => {
    // Regression: a missing process once contributed 0 ticks at the start, so its lifetime CPU
    // (here 2 days at 1 core) was reported as used inside a 10 s window: 17,280 cores.
    const series = [
      sample({ t: 0, procs: [] }),
      sample({ t: 10_000, procs: [proc(20, 'livekit', 17_280_000)] }),
    ];
    expect(procCores(series, (r) => r === 'livekit')).toBeNull();
  });

  it('procCores: a process whose LAST-sample read failed never yields negative CPU', () => {
    // Regression: same cause, other end: −17,280 cores.
    const series = [
      sample({ t: 0, procs: [proc(20, 'livekit', 17_280_000)] }),
      sample({ t: 10_000, procs: [] }),
    ];
    expect(procCores(series, (r) => r === 'livekit')).toBeNull();
  });

  it('procCoresSeries: procCores over each consecutive window', () => {
    const series = [
      sample({ t: 0, procs: [proc(10, 'controller', 0)] }),
      sample({ t: 5_000, procs: [proc(10, 'controller', 250)] }),
      sample({ t: 10_000, procs: [proc(10, 'controller', 1_250)] }),
    ];
    const per = procCoresSeries(series, (r) => r === 'controller');
    expect(per).toHaveLength(2);
    expect(per[0]).toBeCloseTo(250 / CLK_TCK / 5, 12);
    expect(per[1]).toBeCloseTo(1_000 / CLK_TCK / 5, 12);
    expect(procCoresSeries([series[0]], () => true)).toEqual([]);
  });

  it('pairRate: per-second rate × scale per consecutive pair; null without both reads or positive time', () => {
    const series = [
      sample({ t: 0, net: net({ txBytes: 0 }) }),
      sample({ t: 1_000, net: net({ txBytes: 12_500_000 }) }),
      sample({ t: 1_000, net: net({ txBytes: 13_000_000 }) }),
      sample({ t: 2_000, net: null }),
      sample({ t: 3_000, net: net({ txBytes: 20_000_000 }) }),
    ];
    const mbps = pairRate(series, (s) => s.net?.txBytes, 8 / 1e6);
    expect(mbps[0]).toBeCloseTo(100, 9);
    expect(mbps.slice(1)).toEqual([null, null, null]);
    expect(pairRate(series.slice(0, 2), (s) => s.net?.txBytes, 1)).toEqual([12_500_000]);
    expect(pairRate([], (s) => s.net?.txBytes, 1)).toEqual([]);
  });

  it('procRssMax: the largest per-sample sum of the matching processes', () => {
    const series = [
      sample({ procs: [proc(1, 'worker:0', 0, 100), proc(2, 'worker:1', 0, 200)] }),
      sample({ procs: [proc(1, 'worker:0', 0, 250), proc(3, 'controller', 0, 9_999)] }),
    ];
    expect(procRssMax(series, (r) => r.startsWith('worker'))).toBe(300);
    expect(procRssMax([], () => true)).toBeNull();
  });

  it('socketDropDeltas: per local address, last − first; a socket bound mid-rung counts from 0', () => {
    const first = sample({
      udpSockets: [
        { local: '213.136.65.135:7882', port: 7882, drops: 5 },
        { local: '*:3478', port: 3478, drops: 179 },
        { local: '172.17.0.1:7882', port: 7882, drops: 1 },
      ],
    });
    const mid = sample({ udpSockets: null });
    const last = sample({
      udpSockets: [
        { local: '213.136.65.135:7882', port: 7882, drops: 8 },
        { local: '*:3478', port: 3478, drops: 179 },
        { local: '172.30.0.1:7882', port: 7882, drops: 4 },
      ],
    });
    expect(socketDropDeltas([first, mid, last])).toEqual({
      '213.136.65.135:7882': 3,
      '*:3478': 0,
      '172.30.0.1:7882': 4,
    });
    expect(socketDropDeltas([])).toEqual({});
  });

  it('socketDropDeltas: an unreadable FIRST sample never reports lifetime drops as the rung delta', () => {
    // Regression: a null udpSockets in the first sample once read as "no drops", so 3478's
    // lifetime counter (179) was reported as dropped during the rung.
    const first = sample({ udpSockets: null });
    const last = sample({ udpSockets: [{ local: '*:3478', port: 3478, drops: 179 }] });
    expect(socketDropDeltas([first, last])['*:3478']).not.toBe(179);
  });
});

describe('results/series — windows reuse observe/derive', () => {
  it('SUT: deriveSut per consecutive pair, from the first sample as baseline, carrying the health streak', () => {
    const s0 = sample({ t: 0, seq: 1 });
    const s1 = sample({
      t: 5_000,
      seq: 2,
      cores: [core(0, { sys: 100, soft: 50, idle: 1_350 }), core(1, { user: 50, idle: 1_450 })],
      udp: { v4: udp(3), v6: udp(1) },
      net: net({ txBytes: 6_250_000, txPackets: 500, rxPackets: 500 }),
      sut: sutSection({ livekitHttp: 503 }),
    });
    const s2 = sample({
      t: 10_000,
      seq: 3,
      cores: [core(0, { sys: 150, soft: 100, idle: 1_750 }), core(1, { user: 100, idle: 1_900 })],
      udp: { v4: udp(5), v6: udp(1) },
      net: net({ txBytes: 12_500_000, txPackets: 1_000, rxPackets: 1_000 }),
      sut: sutSection({ livekitHttp: null }),
    });
    const ws = windows([s0, s1, s2], 'sut');
    const a = deriveSut(s0, s0, s1, { lkNon200Consecutive: 0 });
    const b = deriveSut(s0, s1, s2, a.state);
    expect(ws).toEqual([a.metrics, b.metrics]);
    expect(metric(ws, 'lkHealthNon200Consecutive')).toEqual([1, 2]);
    expect(metric(ws, 'udpInErrorsDelta')).toEqual([4, 6]);
    expect(metric(ws, 'udpInErrorsWindow')).toEqual([4, 2]);
    expect(metric(ws, 'txMbps')).toEqual([10, 10]);
  });

  it('generator: deriveGenerator with each sample’s own link speed and no loop lag', () => {
    const g0 = genSample({ t: 0, seq: 1 });
    const g1 = genSample({
      t: 1_000,
      seq: 2,
      net: net({ rxBytes: 1_250_000, txBytes: 12_500_000 }),
    });
    const g2 = genSample(
      { t: 2_000, seq: 3, net: net({ rxBytes: 2_500_000, txBytes: 25_000_000 }) },
      null,
    );
    const ws = windows([g0, g1, g2], 'generator');
    expect(ws).toEqual([
      deriveGenerator(g0, g0, g1, { linkMbps: 1000, loopLagP95Ms: null }).metrics,
      deriveGenerator(g0, g1, g2, { linkMbps: null, loopLagP95Ms: null }).metrics,
    ]);
    expect(metric(ws, 'gNicPct')).toEqual([10, null]);
    expect(metric(ws, 'gLoopLagP95Ms')).toEqual([null, null]);
  });

  it('fewer than two samples give no window; metric() maps an absent value to null', () => {
    expect(windows([], 'sut')).toEqual([]);
    expect(windows([sample()], 'generator')).toEqual([]);
    expect(metric([{ load1: 3 }, {}], 'load1')).toEqual([3, null]);
  });

  it('inWindow is inclusive at both ends; a null bound is open', () => {
    const ss = [0, 5_000, 10_000, 15_000].map((t) => sample({ t }));
    expect(inWindow(ss, 5_000, 10_000).map((s) => s.t)).toEqual([5_000, 10_000]);
    expect(inWindow(ss, null, 5_000).map((s) => s.t)).toEqual([0, 5_000]);
    expect(inWindow(ss, 10_000, null).map((s) => s.t)).toEqual([10_000, 15_000]);
  });

  it('maxOf / minOf / meanOf skip null, undefined and non-finite; empty is null', () => {
    const xs = [3, null, undefined, Number.NaN, 1, Number.POSITIVE_INFINITY, 5];
    expect(maxOf(xs)).toBe(5);
    expect(minOf(xs)).toBe(1);
    expect(meanOf(xs)).toBe(3);
    expect(maxOf([null])).toBeNull();
    expect(minOf([])).toBeNull();
    expect(meanOf([undefined])).toBeNull();
  });
});
