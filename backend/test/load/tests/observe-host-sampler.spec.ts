import { parseProcStatCores, parseSsUdpSockets } from '../metrics/procfs';
import { samplerSanity } from '../observe/derive';
import { procCounters, procsOf, sampleBase } from '../observe/host-base';
import {
  classifyGroup,
  HostSampler,
  type HostSamplerOptions,
  parseChronyOffsetMs,
  parseLinkSpeed,
} from '../observe/host-sampler';
import { quietReaders } from '../observe/quiet-readers';
import { CLK_TCK, SAMPLE_SCHEMA } from '../observe/sample';
import {
  FAILING,
  FAKE_CLOCK_STEP_MS,
  FakeHost,
  type FakeProc,
  nullPaths,
  type Patch,
  patched,
  pidStat,
} from './support/fake-host';

// ---------------------------------------------------------------------------
// Generator fixtures
// ---------------------------------------------------------------------------

const AGENT = 4100;
const GEN_OPTS: HostSamplerOptions = {
  runId: 'run-p84',
  rung: 'S2',
  host: 'gen-1',
  iface: 'eth0',
  sutAddress: '203.0.113.10',
};
const GEN_LIST = [
  { pid: AGENT, role: 'agent' },
  { pid: 4101, role: 'worker:0' },
  { pid: 4102, role: 'worker:1' },
];

/** The agent's group (pgrp = AGENT) plus an unrelated group with look-alike names. */
const genProcs = (): Record<number, FakeProc> => ({
  [AGENT]: {
    comm: 'node',
    ppid: 1,
    pgrp: AGENT,
    utime: 500,
    stime: 100,
    rssKb: 90_000,
    threads: 11,
    fds: 30,
  },
  4101: {
    comm: 'node',
    ppid: AGENT,
    pgrp: AGENT,
    utime: 2_000,
    stime: 300,
    rssKb: 450_000,
    threads: 20,
    fds: 120,
  },
  4102: {
    comm: 'node',
    ppid: AGENT,
    pgrp: AGENT,
    utime: 1_800,
    stime: 250,
    rssKb: 440_000,
    threads: 20,
    fds: 118,
  },
  // helper: a child of a worker (rtc-node's lsb_release)
  4103: { comm: 'lsb_release', ppid: 4101, pgrp: AGENT },
  // named like a worker, but the agent never recorded it as one: unexplained
  4104: { comm: 'worker', ppid: AGENT, pgrp: AGENT },
  // another process group entirely (same names): never a member
  5000: { comm: 'node', ppid: 1, pgrp: 5000 },
  5001: { comm: 'worker', ppid: 5000, pgrp: 5000 },
});

// ---------------------------------------------------------------------------
// host-base
// ---------------------------------------------------------------------------

describe('observe/host-base — shared host counters', () => {
  it('reads a complete set of counters through quiet readers over a fake host', async () => {
    const base = await sampleBase(quietReaders(new FakeHost(), { role: 'sut' }), 'eth0');
    expect(nullPaths(base)).toEqual([]);
    expect(base).toMatchObject({
      load1: 0.1,
      mem: { totalKb: 67_108_864, availableKb: 62_914_560, swapUsedKb: 0 },
      oomKills: 0,
      net: { iface: 'eth0', rxBytes: 1_000, txBytes: 1_000, rxPackets: 10, txPackets: 10 },
      qdisc: { dropped: 0, overlimits: 0 },
      udp: {
        v4: { inDatagrams: 100, outDatagrams: 100, inErrors: 0, rcvbufErrors: 0, sndbufErrors: 0 },
        v6: { inDatagrams: 100, outDatagrams: 100, inErrors: 0, rcvbufErrors: 0, sndbufErrors: 0 },
      },
      softnet: { dropped: 0, timeSqueeze: 0 },
      conntrack: { count: 40, max: 262_144 },
    });
    expect(base.cores?.map((c) => c.id)).toEqual([0, 1]);
    expect(base.cpuClockMs).not.toBeNull();
    expect(base.udpSockets?.map((s) => s.port).sort()).toEqual([3478, 7882, 7882, 7882, 7882]);
  });

  it('the exact meter refuses a tick-sampled idle clock: nohz=off → cpuClockMs null, cores kept', async () => {
    const host = new FakeHost();
    host.files.set('/proc/cmdline', 'BOOT_IMAGE=/vmlinuz root=/dev/sda1 ro nohz=off\n');
    const base = await sampleBase(host, 'eth0');
    expect(base.cores).not.toBeNull();
    expect(base.cpuClockMs).toBeNull();
  });

  it('an unreadable kernel command line is not proof of NO_HZ: cpuClockMs null', async () => {
    const host = new FakeHost();
    host.files.delete('/proc/cmdline');
    expect((await sampleBase(host, 'eth0')).cpuClockMs).toBeNull();
  });

  it.each([
    // cores and their clock are one read: both are null together
    { source: '/proc/stat', patch: { files: { '/proc/stat': null } }, section: 'cores,cpuClockMs' },
    { source: '/proc/loadavg', patch: { files: { '/proc/loadavg': null } }, section: 'load1' },
    { source: '/proc/meminfo', patch: { files: { '/proc/meminfo': null } }, section: 'mem' },
    { source: '/proc/vmstat', patch: { files: { '/proc/vmstat': null } }, section: 'oomKills' },
    { source: '/proc/net/dev', patch: { files: { '/proc/net/dev': null } }, section: 'net' },
    {
      source: 'tc -s qdisc',
      patch: { cmd: (f: string) => (f === 'tc' ? null : undefined) },
      section: 'qdisc',
    },
    { source: '/proc/net/snmp', patch: { files: { '/proc/net/snmp': null } }, section: 'udp.v4' },
    { source: '/proc/net/snmp6', patch: { files: { '/proc/net/snmp6': null } }, section: 'udp.v6' },
    {
      source: '/proc/net/softnet_stat',
      patch: { files: { '/proc/net/softnet_stat': null } },
      section: 'softnet',
    },
    {
      source: 'nf_conntrack_count',
      patch: { files: { '/proc/sys/net/netfilter/nf_conntrack_count': null } },
      section: 'conntrack',
    },
    {
      source: 'nf_conntrack_max',
      patch: { files: { '/proc/sys/net/netfilter/nf_conntrack_max': null } },
      section: 'conntrack',
    },
    {
      source: 'ss -uanm',
      patch: { cmd: (f: string) => (f === 'ss' ? null : undefined) },
      section: 'udpSockets',
    },
  ])(
    '$source unreadable → $section is null (never 0), the rest intact',
    async ({ patch, section }) => {
      const r = patched(quietReaders(new FakeHost(), { role: 'sut' }), patch as Patch);
      expect(nullPaths(await sampleBase(r, 'eth0'))).toEqual(section.split(','));
    },
  );

  it('samples the configured interface; an interface the host does not have is null, not zeros', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const r = patched(
      quietReaders(new FakeHost(), { role: 'generator', iface: 'ens18' }),
      {},
      calls,
    );
    expect((await sampleBase(r, 'ens18')).net).toMatchObject({ iface: 'ens18', rxBytes: 1_000 });
    expect(calls).toContainEqual({ file: 'tc', args: ['-s', 'qdisc', 'show', 'dev', 'ens18'] });
    expect((await sampleBase(r, 'eth0')).net).toBeNull();
  });

  it('procCounters reads exactly /proc/<pid>/{stat,status,fd}: utime+stime, RSS, threads, fds', async () => {
    const host = new FakeHost({
      4242: {
        comm: 'x',
        ppid: 1,
        pgrp: 4242,
        utime: 7_000,
        stime: 3_000,
        rssKb: 800_000,
        threads: 40,
        fds: 900,
      },
    });
    expect(await procCounters(host, 4242, 'livekit')).toEqual({
      pid: 4242,
      role: 'livekit',
      cpuTicks: 10_000,
      rssKb: 800_000,
      fds: 900,
      threads: 40,
    });
    expect(host.fileReads.sort()).toEqual(['/proc/4242/stat', '/proc/4242/status']);
    expect(host.pidsCalls).toBe(0);
  });

  it('procCounters: unreadable fds is null (not 0); a vanished process is null', async () => {
    const host = new FakeHost({
      10: { comm: 'a', ppid: 1, pgrp: 10, utime: 5, rssKb: 64, fds: null },
    });
    expect(await procCounters(host, 10, 'controller')).toMatchObject({ cpuTicks: 5, fds: null });
    expect(await procCounters(host, 11, 'controller')).toBeNull();
    // stat readable but status not: still null, never a partial zero-filled record
    host.files.set('/proc/12/stat', pidStat(12, { comm: 'b', ppid: 1, pgrp: 12, utime: 1 }));
    expect(await procCounters(host, 12, 'controller')).toBeNull();
  });

  it('procsOf keeps the listed order and roles and drops processes that no longer exist', async () => {
    const host = new FakeHost({
      1: { comm: 'a', ppid: 0, pgrp: 1, utime: 1 },
      3: { comm: 'c', ppid: 0, pgrp: 3, utime: 3 },
    });
    const out = await procsOf(host, [
      { pid: 3, role: 'worker:1' },
      { pid: 2, role: 'worker:0' },
      { pid: 1, role: 'agent' },
    ]);
    expect(out.map((p) => [p.pid, p.role, p.cpuTicks])).toEqual([
      [3, 'worker:1', 3],
      [1, 'agent', 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// quiet-readers
// ---------------------------------------------------------------------------

describe('observe/quiet-readers — a quiet, complete host over real per-process reads', () => {
  it('stretches the CPU clock 1,000× and adds exactly the matching idle: real busy kept, busy % ÷ 1,000', async () => {
    // The fake host never idles: each 5 s read is 500 real busy ticks per core.
    const q = quietReaders(new FakeHost(), { role: 'generator' });
    const a = await q.procStat();
    const b = await q.procStat();
    const first = parseProcStatCores(a?.text ?? '');
    const second = parseProcStatCores(b?.text ?? '');
    expect(first?.map((c) => c.idle)).toEqual([1_000, 1_000]); // the first read is the origin
    expect((b?.monoMs ?? 0) - (a?.monoMs ?? 0)).toBe(1_000 * FAKE_CLOCK_STEP_MS);
    const windowTicks = (1_000 * FAKE_CLOCK_STEP_MS * CLK_TCK) / 1000; // 500,000
    const quiet = second?.map((c, k) => c.idle - (first?.[k]?.idle ?? 0)) ?? [];
    expect(quiet).toEqual([499_500, 499_500]);
    expect(quiet.map((q2) => windowTicks - q2)).toEqual([500, 500]); // the REAL busy, exactly
    expect(second?.map((c) => c.user + c.sys + c.soft)).toEqual([320, 160]); // busy fields untouched
  });

  it('fails closed: no real /proc/stat → null', async () => {
    const host = new FakeHost();
    host.files.delete('/proc/stat');
    expect(await quietReaders(host, { role: 'sut' }).procStat()).toBeNull();
  });

  it('passes per-process reads, fd counts and the PID list through; synthetic host files never touch them', async () => {
    const host = new FakeHost({ 77: { comm: 'node', ppid: 1, pgrp: 77, utime: 9, fds: 12 } });
    const q = quietReaders(host, { role: 'generator' });
    expect(await q.file('/proc/77/stat')).toBe(pidStat(77, host.procs.get(77)!));
    expect(await q.fdCount(77)).toBe(12);
    expect(await q.pids()).toEqual([77]);
    await q.file('/proc/loadavg');
    await q.file('/proc/meminfo');
    expect(host.fileReads).toEqual(['/proc/77/stat']);
    // the synthetic nginx workers (SUT side) have a fixed fd count
    expect(await q.fdCount(999_991)).toBe(50);
  });

  it('an exact-path override wins over both the synthetic and the real source', async () => {
    const q = quietReaders(new FakeHost(), {
      role: 'sut',
      files: { '/proc/loadavg': '9.00 8.00 7.00 1/1 1\n', '/proc/stat': 'cpu0 1 1 1 1 1 1 1 1\n' },
    });
    expect(await q.file('/proc/loadavg')).toBe('9.00 8.00 7.00 1/1 1\n');
    expect(await q.file('/proc/stat')).toBe('cpu0 1 1 1 1 1 1 1 1\n');
    expect((await q.procStat())?.text).toBe('cpu0 1 1 1 1 1 1 1 1\n'); // origin read: no idle added
  });

  it('SUT sockets (4 × 7882, 1 × 3478, no drops) exist only for role sut; other commands are null', async () => {
    const sut = quietReaders(new FakeHost(), { role: 'sut' });
    const gen = quietReaders(new FakeHost(), { role: 'generator' });
    const sockets = parseSsUdpSockets((await sut.cmd('ss', ['-H', '-uanm'])) ?? '');
    expect(sockets.map((s) => s.port).sort()).toEqual([3478, 7882, 7882, 7882, 7882]);
    expect(sockets.every((s) => s.drops === 0)).toBe(true);
    expect(await gen.cmd('ss', ['-H', '-uanm'])).toBe('');
    expect(await sut.cmd('ss', ['-H', '-uan', 'sport >= :30000 and sport <= :32767'])).toBe('');
    expect(await sut.cmd('nginx', ['-T'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// host-sampler: pure helpers
// ---------------------------------------------------------------------------

describe('observe/host-sampler — pure helpers', () => {
  const TRACKING =
    'A29FC87B,162.159.200.123,3,1791125852.000,0.000000500,0.000001,0.000002,-1.0,0.0,0.01,0.001,0.0005,64.0,Normal\n';

  it('parseChronyOffsetMs: field 5 (system time, seconds) in ms, sign kept', () => {
    expect(parseChronyOffsetMs(TRACKING)).toBeCloseTo(0.0005, 9);
    expect(parseChronyOffsetMs(TRACKING.replace('0.000000500', '-0.012500000'))).toBeCloseTo(
      -12.5,
      9,
    );
  });

  it('parseChronyOffsetMs: not the CSV form, too few fields or a non-number → null', () => {
    expect(parseChronyOffsetMs('')).toBeNull();
    expect(parseChronyOffsetMs('506 Cannot talk to daemon\n')).toBeNull();
    expect(parseChronyOffsetMs('A29FC87B,162.159.200.123,3,1791125852.000\n')).toBeNull();
    expect(parseChronyOffsetMs(TRACKING.replace('0.000000500', 'nan'))).toBeNull();
  });

  it('parseChronyOffsetMs: an EMPTY system-time field is null, never a silent 0 ms offset', () => {
    // Regression: Number('') === 0, so a blank field 5 once passed as a perfect clock.
    expect(parseChronyOffsetMs(TRACKING.replace('0.000000500', ''))).toBeNull();
  });

  it('parseLinkSpeed: Mbit/s, or null when unknown (virtio -1, 0, empty, text)', () => {
    expect(parseLinkSpeed('1000\n')).toBe(1000);
    expect(parseLinkSpeed('25000')).toBe(25_000);
    expect(parseLinkSpeed('-1\n')).toBeNull();
    expect(parseLinkSpeed('0\n')).toBeNull();
    expect(parseLinkSpeed('')).toBeNull();
    expect(parseLinkSpeed('unknown\n')).toBeNull();
  });

  it('classifyGroup: agent / workers / helpers = children of workers / everything else unexplained', () => {
    const members = [
      { pid: 100, ppid: 1 }, // the agent
      { pid: 101, ppid: 100 }, // worker
      { pid: 102, ppid: 100 }, // worker
      { pid: 103, ppid: 101 }, // helper: a worker's child
      { pid: 104, ppid: 103 }, // a helper's child: not a worker's child → unexplained
      { pid: 105, ppid: 100 }, // the agent's non-worker child → unexplained
    ];
    expect(classifyGroup(members, 100, new Set([101, 102]))).toEqual({
      members: 6,
      workers: 2,
      helpers: 1,
      unexplained: 2,
    });
  });

  it('classifyGroup: the agent is a member but never unexplained; an empty group is all zero', () => {
    expect(classifyGroup([{ pid: 100, ppid: 1 }], 100, new Set())).toEqual({
      members: 1,
      workers: 0,
      helpers: 0,
      unexplained: 0,
    });
    expect(classifyGroup([], 100, new Set([101]))).toEqual({
      members: 0,
      workers: 0,
      helpers: 0,
      unexplained: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// host-sampler: the generator sample
// ---------------------------------------------------------------------------

describe('observe/host-sampler — HostSampler (generator)', () => {
  it('builds a complete generator sample: no null section, sane as a series', async () => {
    let now = 1_000;
    const sampler = new HostSampler(
      quietReaders(new FakeHost(genProcs()), { role: 'generator' }),
      GEN_OPTS,
      () => now,
    );
    const first = await sampler.sample(GEN_LIST, 20);
    now = 6_000;
    const second = await sampler.sample(GEN_LIST, 20);

    expect(nullPaths(first)).toEqual(['sut']);
    expect(nullPaths(second)).toEqual(['sut']);
    expect(first).toMatchObject({
      schema: SAMPLE_SCHEMA,
      runId: 'run-p84',
      rung: 'S2',
      host: 'gen-1',
      role: 'generator',
      t: 1_000,
      seq: 1,
      udpSockets: [],
      sut: null,
    });
    expect(second).toMatchObject({ t: 6_000, seq: 2 });
    expect(first.clockOffsetMs).toBeCloseTo(0.0005, 9);
    expect(first.gen).toEqual({
      participants: 20,
      flowsToSut3478: 0,
      tcpToSut443: 0,
      linkMbps: 1000,
      processGroup: { members: 5, workers: 2, helpers: 1, unexplained: 1 },
    });
    expect(first.procs).toEqual([
      { pid: AGENT, role: 'agent', cpuTicks: 600, rssKb: 90_000, fds: 30, threads: 11 },
      { pid: 4101, role: 'worker:0', cpuTicks: 2_300, rssKb: 450_000, fds: 120, threads: 20 },
      { pid: 4102, role: 'worker:1', cpuTicks: 2_050, rssKb: 440_000, fds: 118, threads: 20 },
    ]);
    expect(samplerSanity([first, second])).toEqual([]);
  });

  it('counts egress flows to SUT:3478 and TCP to SUT:443 with exact, read-only commands', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const r = patched(
      quietReaders(new FakeHost(genProcs()), { role: 'generator' }),
      {
        cmd: (file, args) => {
          if (file !== 'ss') return undefined;
          if (args.includes('203.0.113.10:3478'))
            return 'UNCONN 0 0 198.51.100.7:51000 203.0.113.10:3478\n';
          if (args.includes('203.0.113.10:443'))
            return [40001, 40002, 40003]
              .map((p) => `ESTAB 0 0 198.51.100.7:${p} 203.0.113.10:443`)
              .join('\n');
          return undefined;
        },
      },
      calls,
    );
    const s = await new HostSampler(r, GEN_OPTS).sample(GEN_LIST, 3);
    expect(s.gen).toMatchObject({ participants: 3, flowsToSut3478: 1, tcpToSut443: 3 });
    expect(calls).toEqual(
      expect.arrayContaining([
        { file: 'ss', args: ['-H', '-uan', 'dst', '203.0.113.10:3478'] },
        { file: 'ss', args: ['-H', '-tn', 'state', 'established', 'dst', '203.0.113.10:443'] },
        { file: 'chronyc', args: ['-c', 'tracking'] },
        { file: 'tc', args: ['-s', 'qdisc', 'show', 'dev', 'eth0'] },
      ]),
    );
  });

  it('every reader failing yields null everywhere — never a zero', async () => {
    const s = await new HostSampler(FAILING, GEN_OPTS, () => 42).sample(GEN_LIST, 7);
    expect(s).toEqual({
      schema: SAMPLE_SCHEMA,
      runId: 'run-p84',
      rung: 'S2',
      host: 'gen-1',
      role: 'generator',
      t: 42,
      seq: 1,
      clockOffsetMs: null,
      cores: null,
      cpuClockMs: null,
      load1: null,
      mem: null,
      oomKills: null,
      net: null,
      qdisc: null,
      udp: { v4: null, v6: null },
      softnet: null,
      conntrack: null,
      udpSockets: null,
      procs: [],
      sut: null,
      gen: {
        participants: 7,
        flowsToSut3478: null,
        tcpToSut443: null,
        linkMbps: null,
        processGroup: null,
      },
    });
  });

  it('single failing sources: chrony → clockOffsetMs null; ss → flow counts null; unknown speed → null', async () => {
    const r = patched(quietReaders(new FakeHost(genProcs()), { role: 'generator' }), {
      files: { '/sys/class/net/eth0/speed': '-1\n' },
      cmd: (file) => (file === 'chronyc' || file === 'ss' ? null : undefined),
    });
    const s = await new HostSampler(r, GEN_OPTS).sample(GEN_LIST, 20);
    expect(s.clockOffsetMs).toBeNull();
    expect(s.udpSockets).toBeNull();
    expect(s.gen).toMatchObject({ flowsToSut3478: null, tcpToSut443: null, linkMbps: null });
    expect(s.gen?.processGroup).not.toBeNull();
  });

  it('the process group is null when it cannot be established (no agent, agent gone, /proc unlistable)', async () => {
    const noAgent = new HostSampler(
      quietReaders(new FakeHost(genProcs()), { role: 'generator' }),
      GEN_OPTS,
    );
    expect((await noAgent.sample(GEN_LIST.slice(1), 20)).gen?.processGroup).toBeNull();

    const gone = new FakeHost(genProcs());
    gone.procs.delete(AGENT);
    const agentGone = new HostSampler(quietReaders(gone, { role: 'generator' }), GEN_OPTS);
    expect((await agentGone.sample(GEN_LIST, 20)).gen?.processGroup).toBeNull();

    const unlistable = new FakeHost(genProcs());
    unlistable.pidList = null;
    const noPids = new HostSampler(quietReaders(unlistable, { role: 'generator' }), GEN_OPTS);
    expect((await noPids.sample(GEN_LIST, 20)).gen?.processGroup).toBeNull();
  });

  it('membership is the exact pgid; a PID that exits between listing and reading is skipped', async () => {
    const host = new FakeHost(genProcs());
    host.pidList = [...host.procs.keys(), 4199]; // 4199 is listed but already gone
    const s = await new HostSampler(quietReaders(host, { role: 'generator' }), GEN_OPTS).sample(
      GEN_LIST,
      20,
    );
    expect(s.gen?.processGroup).toEqual({ members: 5, workers: 2, helpers: 1, unexplained: 1 });
  });
});
