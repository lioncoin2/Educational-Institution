import { deriveGenerator, deriveSut, samplerSanity, type SutState } from '../observe/derive';
import {
  type CoreTicks,
  type HostSample,
  type NetCounters,
  SAMPLE_SCHEMA,
  type SutSection,
  type UdpCounters,
} from '../observe/sample';

const core = (id: number, ticks: Partial<CoreTicks> = {}): CoreTicks => ({
  id,
  user: 0,
  nice: 0,
  sys: 0,
  idle: 0,
  iowait: 0,
  irq: 0,
  soft: 0,
  steal: 0,
  ...ticks,
});

const udp = (inErrors: number, rcvbufErrors = 0): UdpCounters => ({
  inDatagrams: 0,
  outDatagrams: 0,
  inErrors,
  rcvbufErrors,
  sndbufErrors: 0,
});

const net = (counters: Partial<NetCounters> = {}): NetCounters => ({
  iface: 'eth0',
  rxBytes: 0,
  txBytes: 0,
  rxPackets: 0,
  txPackets: 0,
  rxDrop: 0,
  txDrop: 0,
  rxErr: 0,
  txErr: 0,
  ...counters,
});

const sockets = (drops7882: readonly number[], drops3478 = 0): HostSample['udpSockets'] => [
  ...drops7882.map((drops, i) => ({ local: `10.0.0.${i}:7882`, port: 7882, drops })),
  { local: '*:3478', port: 3478, drops: drops3478 },
];

const sutSection = (s: Partial<SutSection> = {}): SutSection => ({
  relaySockets: 0,
  turnTlsEstab: 0,
  fwNewFlows: { udp3478: 0, udp7882: 0 },
  containers: [
    { name: 'institution-livekit-1', restarts: 0, health: 'healthy' },
    { name: 'institution-api-1', restarts: 0, health: 'healthy' },
  ],
  livekitHttp: 200,
  nginx: { workerConnections: 768, workerFds: [40], errorWorkerConnections: 0, errorUpstream: 0 },
  ...s,
});

/** A complete, valid SUT sample; tests override only what they exercise. */
const sample = (s: Partial<HostSample> = {}): HostSample => ({
  schema: SAMPLE_SCHEMA,
  runId: 'run',
  rung: 'R1',
  host: 'sut',
  role: 'sut',
  t: 0,
  seq: 0,
  clockOffsetMs: null,
  cores: [core(0, { idle: 1_000 }), core(1, { idle: 1_000 })],
  cpuClockMs: 0,
  load1: 1,
  mem: { totalKb: 64 * 1024 * 1024, availableKb: 32 * 1024 * 1024, swapUsedKb: 0 },
  oomKills: 0,
  net: net(),
  qdisc: { dropped: 0, overlimits: 0 },
  udp: { v4: udp(0), v6: udp(0) },
  softnet: { dropped: 0, timeSqueeze: 0 },
  conntrack: { count: 500, max: 262_144 },
  udpSockets: sockets([0, 0, 0, 0]),
  procs: [],
  sut: sutSection(),
  gen: null,
  ...s,
});

const gen = (s: Partial<HostSample> = {}): HostSample =>
  sample({ host: 'gen-1', role: 'generator', clockOffsetMs: 0, udpSockets: null, sut: null, ...s });

const FRESH: SutState = { lkNon200Consecutive: 0 };

describe('observe/derive — SUT CPU', () => {
  it('S-cpu-hot and S-cpu-total are EXACT busy (wall − idle − iowait); tick %sys+%soft is a diagnostic', () => {
    const prev = sample({
      cpuClockMs: 0,
      cores: [core(0, { user: 100, sys: 50, soft: 10, idle: 840 }), core(1, { idle: 1_000 })],
    });
    const cur = sample({
      cpuClockMs: 1_000, // a 100-tick window per core
      cores: [
        core(0, { user: 110, sys: 80, soft: 30, idle: 880 }), // idle +40 → busy 60
        core(1, { sys: 10, idle: 1_060, iowait: 30 }), // idle +60, iowait +30 → busy 10
      ],
    });
    const { metrics } = deriveSut(prev, prev, cur, FRESH);
    expect(metrics.cpuHotBusyPct).toBeCloseTo(60, 9);
    expect(metrics.cpuTotalBusyPct).toBeCloseTo(35, 9); // (60 + 10) ÷ 200
    expect(metrics.cpuHotSysSoftTickPct).toBeCloseTo(50, 9); // core 0 ticks: (30 + 20) ÷ 100
  });

  it('regression (errata E9): a core the tick sampler reads 48 % busy is 100 % busy exactly', () => {
    // Measured on the SUT: a pinned 100 % core read 48–100 % per window in the busy ticks while its
    // idle clock did not advance at all.
    const prev = sample({ cpuClockMs: 0, cores: [core(0, { idle: 1_000 })] });
    const cur = sample({ cpuClockMs: 500, cores: [core(0, { user: 24, idle: 1_000 })] }); // 24 of 50 ticks
    const { metrics } = deriveSut(prev, prev, cur, FRESH);
    expect(metrics.cpuHotBusyPct).toBe(100);
    expect(metrics.cpuTotalBusyPct).toBe(100);
  });

  it('needs a previous sample and the CPU clock for anything measured over a window', () => {
    expect(
      deriveSut(sample(), sample({ cpuClockMs: null }), sample({ cpuClockMs: 5_000 }), FRESH)
        .metrics.cpuHotBusyPct,
    ).toBeNull();
    const { metrics } = deriveSut(sample(), null, sample(), FRESH);
    expect(metrics.cpuHotBusyPct).toBeNull();
    expect(metrics.udpInErrorsWindow).toBeNull();
    expect(metrics.txMbps).toBeNull();
    expect(metrics.udpInErrorsDelta).toBe(0);
  });
});

describe('observe/derive — SUT counters', () => {
  it('measures deltas from the baseline and window deltas from the previous sample', () => {
    const baseline = sample({
      udp: { v4: udp(10), v6: udp(2) },
      softnet: { dropped: 5, timeSqueeze: 0 },
    });
    const prev = sample({
      udp: { v4: udp(15), v6: udp(2) },
      softnet: { dropped: 6, timeSqueeze: 0 },
    });
    const cur = sample({
      udp: { v4: udp(20), v6: udp(4) },
      softnet: { dropped: 9, timeSqueeze: 0 },
    });
    const { metrics } = deriveSut(baseline, prev, cur, FRESH);
    expect(metrics).toMatchObject({
      udpInErrorsDelta: 12,
      udpInErrorsWindow: 7,
      softnetDroppedDelta: 4,
      softnetDroppedWindow: 3,
    });
  });

  it('counts InErrors only — RcvbufErrors is a breakdown, not added again', () => {
    const baseline = sample();
    const cur = sample({ udp: { v4: udp(10, 10), v6: udp(0) } });
    expect(deriveSut(baseline, baseline, cur, FRESH).metrics.udpInErrorsDelta).toBe(10);
  });

  it('sums drops over every 7882 socket and ignores 3478', () => {
    const baseline = sample({ udpSockets: sockets([0, 0, 0, 0], 179) });
    const cur = sample({ udpSockets: sockets([1, 0, 2, 0], 500) });
    expect(deriveSut(baseline, baseline, cur, FRESH).metrics).toMatchObject({
      sock7882DropsDelta: 3,
      sock7882DropsWindow: 3,
    });
  });

  it('sums qdisc, NIC drops+errs, OOM kills, nginx errors and container restarts', () => {
    const baseline = sample();
    const cur = sample({
      qdisc: { dropped: 4, overlimits: 9 },
      net: net({ rxDrop: 1, txDrop: 2, rxErr: 3, txErr: 4 }),
      oomKills: 1,
      sut: sutSection({
        containers: [
          { name: 'institution-livekit-1', restarts: 1, health: 'healthy' },
          { name: 'institution-api-1', restarts: 2, health: 'healthy' },
        ],
        nginx: {
          workerConnections: 768,
          workerFds: [100, 384, 50],
          errorWorkerConnections: 2,
          errorUpstream: 5,
        },
      }),
    });
    expect(deriveSut(baseline, baseline, cur, FRESH).metrics).toMatchObject({
      qdiscDroppedDelta: 4,
      qdiscDroppedWindow: 4,
      nicDropsErrsDelta: 10,
      oomKillsDelta: 1,
      containerRestartsDelta: 3,
      ngxWorkerConnErrorsDelta: 2,
      ngxUpstreamErrorsWindow: 5,
      ngxBusiestSharePct: 50, // 384 ÷ 768
    });
  });

  it('derives TX Mbit/s and packets/s over the elapsed time, and the gauges', () => {
    const prev = sample({ t: 10_000 });
    const cur = sample({
      t: 15_000,
      net: net({ txBytes: 62_500_000, rxPackets: 1_000, txPackets: 4_000 }),
      load1: 3.5,
      mem: { totalKb: 64 * 1024 * 1024, availableKb: 12 * 1024 * 1024, swapUsedKb: 8 },
    });
    expect(deriveSut(prev, prev, cur, FRESH).metrics).toMatchObject({
      txMbps: 100,
      pps: 1_000,
      load1: 3.5,
      memAvailableGiB: 12,
      swapUsedKb: 8,
      conntrackCount: 500,
    });
  });
});

describe('observe/derive — LiveKit health streak', () => {
  it('counts consecutive non-200 answers (no answer counts) and flags 406', () => {
    let state = FRESH;
    const seenStreak: Array<number | null | undefined> = [];
    const seen406: Array<number | null | undefined> = [];
    for (const http of [200, 503, null, 406, 200]) {
      const out = deriveSut(
        sample(),
        sample(),
        sample({ sut: sutSection({ livekitHttp: http }) }),
        state,
      );
      state = out.state;
      seenStreak.push(out.metrics.lkHealthNon200Consecutive);
      seen406.push(out.metrics.lkHealth406);
    }
    expect(seenStreak).toEqual([0, 1, 2, 3, 0]);
    expect(seen406).toEqual([0, 0, 0, 1, 0]);
  });

  it('keeps the streak through a sample without a SUT section', () => {
    const out = deriveSut(sample(), sample(), sample({ sut: null }), { lkNon200Consecutive: 1 });
    expect(out.state).toEqual({ lkNon200Consecutive: 1 });
    expect(out.metrics.lkHealthNon200Consecutive).toBeNull();
    expect(out.metrics.lkHealth406).toBeNull();
  });
});

describe('observe/derive — null propagation (never a silent 0)', () => {
  it('a null section in the baseline, the window or the sample nulls only what reads it', () => {
    const baseline = sample({ softnet: null });
    const prev = sample({ qdisc: null });
    const cur = sample({ udp: { v4: udp(3), v6: null }, sut: null, conntrack: null });
    const { metrics } = deriveSut(baseline, prev, cur, FRESH);
    expect(metrics).toMatchObject({
      softnetDroppedDelta: null,
      softnetDroppedWindow: 0,
      qdiscDroppedDelta: 0,
      qdiscDroppedWindow: null,
      udpInErrorsDelta: null,
      udpInErrorsWindow: null,
      conntrackCount: null,
      ngxBusiestSharePct: null,
      containerRestartsDelta: null,
      oomKillsDelta: 0,
    });
  });
});

describe('observe/derive — generator', () => {
  const opts = { linkMbps: 1_000, loopLagP95Ms: 12 };

  it('derives the generator rule metrics', () => {
    const baseline = gen({ softnet: { dropped: 1, timeSqueeze: 0 } });
    const prev = gen({ cpuClockMs: 0, cores: [core(0, { idle: 100 })] });
    const cur = gen({
      t: 5_000,
      clockOffsetMs: -12,
      cpuClockMs: 1_000, // a 100-tick window
      cores: [core(0, { user: 40, nice: 10, sys: 10, soft: 5, idle: 135 })], // idle +35 → busy 65
      net: net({ rxBytes: 250_000_000, txBytes: 62_500_000, rxDrop: 1 }),
      udp: { v4: udp(2), v6: udp(1) },
      softnet: { dropped: 3, timeSqueeze: 0 },
      qdisc: { dropped: 1, overlimits: 0 },
      mem: { totalKb: 64, availableKb: 16, swapUsedKb: 0 },
    });
    const { metrics } = deriveGenerator(baseline, prev, cur, opts);
    expect(metrics).toEqual({
      gCpuHotPct: 65, // exact: 100 − 35 idle
      gCpuTotalPct: 65,
      gMemAvailablePct: 25,
      gNicPct: 40, // RX 400 Mbit/s of 1000
      gDropsDelta: 7, // udp 3 + softnet 2 + qdisc 1 + nic 1
      gDropsWindow: 8,
      gLoopLagP95Ms: 12,
      gClockOffsetMs: 12,
    });
  });

  it('leaves NIC share, drops and clock missing when their source is', () => {
    const cur = gen({ t: 5_000, softnet: null, clockOffsetMs: null });
    const { metrics } = deriveGenerator(gen(), gen(), cur, { linkMbps: null, loopLagP95Ms: null });
    expect(metrics).toMatchObject({
      gNicPct: null,
      gDropsDelta: null,
      gDropsWindow: null,
      gClockOffsetMs: null,
      gLoopLagP95Ms: null,
    });
  });
});

describe('observe/derive — samplerSanity (V-sampler)', () => {
  const series = (seqs: readonly number[]) =>
    seqs.map((seq) => sample({ seq, t: seq * 5_000, cpuClockMs: seq * 5_000 }));

  it('accepts a complete series and gaps of up to 2 samples', () => {
    expect(samplerSanity(series([0, 1, 4]))).toEqual([]);
  });

  it('flags more than 2 consecutive missing samples, in any order', () => {
    expect(samplerSanity(series([5, 0]))).toEqual([
      'sut: 4 consecutive samples missing after seq 0',
    ]);
  });

  it('flags null sections a rule needs and missing expected sockets', () => {
    const bad = sample({
      seq: 3,
      net: null,
      udp: { v4: udp(0), v6: null },
      udpSockets: sockets([0, 0, 0]),
    });
    expect(samplerSanity([bad])).toEqual([
      'sut seq 3: null net, udp.v6',
      'sut seq 3: 3 UDP sockets on :7882, expected 4',
    ]);
    expect(samplerSanity([gen({ clockOffsetMs: null })])).toEqual([
      'gen-1 seq 0: null clockOffsetMs',
    ]);
  });

  const e4proc = (pid: number, role: string, cpuTicks: number) => ({
    pid,
    role,
    cpuTicks,
    rssKb: 0,
    fds: null,
    threads: null,
  });

  it('flags errata E4: watched processes running longer than the host was busy (exact)', () => {
    const prev = sample({
      seq: 0,
      cpuClockMs: 0,
      cores: [core(0, { idle: 0 }), core(1, { idle: 0 })],
      procs: [e4proc(7, 'worker:7', 0), e4proc(8, 'worker:8', 0)],
    });
    const within = sample({
      seq: 1,
      cpuClockMs: 1_000, // 100 ticks per core
      cores: [core(0, { idle: 0 }), core(1, { idle: 100 })], // host busy: 100 + 0 ticks
      procs: [e4proc(7, 'worker:7', 60), e4proc(8, 'worker:8', 40), e4proc(9, 'worker:9', 500)], // pid 9 is new
    });
    expect(samplerSanity([prev, within])).toEqual([]);
    const over = sample({
      ...within,
      procs: [e4proc(7, 'worker:7', 90), e4proc(8, 'worker:8', 60)],
    });
    expect(samplerSanity([prev, over])).toEqual([
      'sut seq 1: Σ process CPU 150 > host busy 100 ticks (E4)',
    ]);
  });

  it('E4 allows exactly the counter resolution: 2 ticks per process + 2 per core, not one tick more', () => {
    const prev = sample({
      seq: 0,
      cpuClockMs: 0,
      cores: [core(0, { idle: 0 }), core(1, { idle: 0 })],
      procs: [e4proc(7, 'worker:7', 0)],
    });
    const at = (ticks: number) =>
      sample({
        seq: 1,
        cpuClockMs: 1_000,
        cores: [core(0, { idle: 0 }), core(1, { idle: 100 })], // host busy 100
        procs: [e4proc(7, 'worker:7', ticks)],
      });
    expect(samplerSanity([prev, at(106)])).toEqual([]); // 100 + 2·1 process + 2·2 cores
    expect(samplerSanity([prev, at(107)])).toEqual([
      'sut seq 1: Σ process CPU 107 > host busy 100 ticks (E4)',
    ]);
  });

  it('regression (errata E9): tick-sampled /proc/stat busy is not the E4 reference', () => {
    // Real validation run, local generator seq 4→5: workers 486 + agent 27 = 513 ticks while the
    // /proc/stat busy fields showed 393 — tick sampling misses short bursts. The idle clock says
    // the host was busy longer, so the sampler is valid.
    const prev = gen({
      seq: 4,
      cpuClockMs: 0,
      cores: [core(0, { idle: 0 }), core(1, { idle: 0 })],
      procs: [e4proc(1, 'agent', 0), e4proc(2, 'worker:0', 0), e4proc(3, 'worker:1', 0)],
    });
    const cur = gen({
      seq: 5,
      cpuClockMs: 5_000, // 500 ticks per core
      cores: [core(0, { user: 300, idle: 100 }), core(1, { user: 93, idle: 300 })], // ticks: 393 busy
      procs: [e4proc(1, 'agent', 27), e4proc(2, 'worker:0', 372), e4proc(3, 'worker:1', 114)],
    });
    expect(samplerSanity([prev, cur])).toEqual([]); // exact busy: 400 + 200 = 600 ≥ 513
  });

  it('regression (D-12): a CPU-bound process that is never switched out passes E4 in every window', () => {
    // Measured on the SUT: against /proc/schedstat (credited at switch-out) E4 false-fired in 3 of
    // 12 windows for one pinned busy loop; the idle clock shows the core busy the whole window.
    const series = Array.from({ length: 12 }, (_, k) =>
      gen({
        seq: k,
        cpuClockMs: k * 500, // 50 ticks per core per window
        cores: [core(0, { idle: 0 }), core(1, { idle: 45 * k })], // core 0 pegged, core 1 ~10 % busy
        procs: [e4proc(1, 'worker:0', 50 * k)],
      }),
    );
    expect(samplerSanity(series)).toEqual([]);
  });

  it('flags a CPU clock that does not advance within one sampler', () => {
    // Regression: two samplers merged by hostname (two local agents, or cloned VMs) once mixed
    // their counters; each sampler is judged on its own series, and its clock must advance.
    expect(
      samplerSanity([sample({ seq: 0, cpuClockMs: 5_000 }), sample({ seq: 1, cpuClockMs: 5_000 })]),
    ).toEqual(['sut seq 1: CPU clock did not advance (E4)']);
  });

  it('flags a sampler without the exact CPU clock (E4 and the CPU rules cannot be judged)', () => {
    expect(samplerSanity([sample({ seq: 0, cpuClockMs: null })])).toEqual([
      'sut seq 0: null cpuClockMs',
    ]);
  });
});
