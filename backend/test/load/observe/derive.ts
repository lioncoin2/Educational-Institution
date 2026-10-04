/**
 * P8.4 — pure derivation of the rule metrics (observe/rules.ts MetricId) from
 * raw samples (observe/sample.ts): exact CPU busy (observe/cpu-meter.ts) and rates over the last
 * window (prev → cur), counter deltas since the rung baseline (`…Delta`) and
 * over the window (`…Window`), and gauges. A metric whose input section is null
 * in any sample it needs is null, never 0, so the watchdog reports it missing
 * (V-sampler) instead of judging a silent zero. samplerSanity is the V-sampler
 * check over a whole series (gaps, null sections, sockets, errata E4).
 */
import {
  E4_SKEW_TICKS_PER_PROCESS,
  type MetricValues,
  SAMPLER_EXPECTED_SOCKETS,
  SAMPLER_MAX_GAP,
} from './rules';
import { IDLE_CLOCK_RESOLUTION_TICKS, coreBusy, hottestBusyPct, totalBusyPct } from './cpu-meter';
import { type CoreTicks, type HostSample } from './sample';

export interface SutState {
  /** Consecutive samples whose LiveKit health answer was not 200 (no answer counts). */
  readonly lkNon200Consecutive: number;
}

export interface GeneratorOptions {
  /** Provisioned NIC speed; null leaves G-nic missing. */
  readonly linkMbps: number | null;
  /** Worst worker event-loop lag p95 over the window; null when no worker reported. */
  readonly loopLagP95Ms: number | null;
}

type Reader = (s: HostSample) => number | null;

const KIB_PER_GIB = 1024 * 1024;

/** `read(to) − read(from)`, or null when either sample or either reading is missing. */
function change(from: HostSample | null, to: HostSample, read: Reader): number | null {
  if (from === null) return null;
  const a = read(from);
  const b = read(to);
  return a === null || b === null ? null : b - a;
}

/** InErrors already counts RcvbufErrors (the kernel bumps both), so only InErrors is summed. */
const udpInErrors: Reader = ({ udp }) =>
  udp.v4 === null || udp.v6 === null ? null : udp.v4.inErrors + udp.v6.inErrors;

const sock7882Drops: Reader = ({ udpSockets }) =>
  udpSockets === null
    ? null
    : udpSockets.filter((s) => s.port === 7882).reduce((sum, s) => sum + s.drops, 0);

const softnetDropped: Reader = (s) => s.softnet?.dropped ?? null;
const qdiscDropped: Reader = (s) => s.qdisc?.dropped ?? null;
const nicDropsErrs: Reader = ({ net }) =>
  net === null ? null : net.rxDrop + net.txDrop + net.rxErr + net.txErr;
const rxBytes: Reader = (s) => s.net?.rxBytes ?? null;
const txBytes: Reader = (s) => s.net?.txBytes ?? null;
const packets: Reader = ({ net }) => (net === null ? null : net.rxPackets + net.txPackets);
const ngxWorkerConnErrors: Reader = (s) => s.sut?.nginx?.errorWorkerConnections ?? null;
const ngxUpstreamErrors: Reader = (s) => s.sut?.nginx?.errorUpstream ?? null;
const containerRestarts: Reader = ({ sut }) =>
  sut === null || sut.containers === null
    ? null
    : sut.containers.reduce((a, c) => a + c.restarts, 0);

const sum = (values: ReadonlyArray<number | null>): number | null =>
  values.every((v): v is number => v !== null) ? values.reduce((a, v) => a + v, 0) : null;

const total = (d: CoreTicks): number =>
  d.user + d.nice + d.sys + d.idle + d.iowait + d.irq + d.soft + d.steal;

/** Per-core tick deltas (cores matched by id) with time elapsed; null without both readings. */
function coreDeltas(prev: HostSample | null, cur: HostSample): CoreTicks[] | null {
  if (prev === null || prev.cores === null || cur.cores === null) return null;
  const before = new Map(prev.cores.map((c) => [c.id, c]));
  const deltas: CoreTicks[] = [];
  for (const c of cur.cores) {
    const p = before.get(c.id);
    if (p === undefined) continue;
    // A per-core counter stepping backwards (iowait, steal on KVM) is noise, never negative time.
    const step = (now: number, was: number): number => Math.max(0, now - was);
    const d: CoreTicks = {
      id: c.id,
      user: step(c.user, p.user),
      nice: step(c.nice, p.nice),
      sys: step(c.sys, p.sys),
      idle: step(c.idle, p.idle),
      iowait: step(c.iowait, p.iowait),
      irq: step(c.irq, p.irq),
      soft: step(c.soft, p.soft),
      steal: step(c.steal, p.steal),
    };
    if (total(d) > 0) deltas.push(d);
  }
  return deltas.length > 0 ? deltas : null;
}

/** The hottest core's TICK-SAMPLED `share` of its own ticks, in percent — a diagnostic only (errata E9). */
function hottestTickPct(
  deltas: CoreTicks[] | null,
  share: (d: CoreTicks) => number,
): number | null {
  if (deltas === null) return null;
  return Math.max(...deltas.map((d) => (share(d) / total(d)) * 100));
}

/** `change` over the window per second, or null without a positive elapsed time. */
function perSecond(prev: HostSample | null, cur: HostSample, read: Reader): number | null {
  const d = change(prev, cur, read);
  const seconds = prev === null ? 0 : (cur.t - prev.t) / 1000;
  return d === null || seconds <= 0 ? null : d / seconds;
}

const mbps = (bytesPerSecond: number | null): number | null =>
  bytesPerSecond === null ? null : (bytesPerSecond * 8) / 1e6;

/**
 * SUT metrics for one sample. `prev` is the previous sample (the baseline for
 * the first one); without it every window metric is null. `state` carries the
 * LiveKit health streak from call to call.
 */
export function deriveSut(
  baseline: HostSample,
  prev: HostSample | null,
  cur: HostSample,
  state: SutState,
): { metrics: MetricValues; state: SutState } {
  const busy = coreBusy(prev, cur);
  const nginx = cur.sut?.nginx ?? null;
  const fds = nginx?.workerFds ?? [];
  const health = cur.sut === null ? null : cur.sut.livekitHttp;
  const next: SutState =
    cur.sut === null
      ? state
      : { lkNon200Consecutive: health === 200 ? 0 : state.lkNon200Consecutive + 1 };
  const metrics: MetricValues = {
    cpuHotBusyPct: hottestBusyPct(busy),
    cpuHotSysSoftTickPct: hottestTickPct(coreDeltas(prev, cur), (d) => d.sys + d.soft),
    cpuTotalBusyPct: totalBusyPct(busy),
    load1: cur.load1,
    memAvailableGiB: cur.mem === null ? null : cur.mem.availableKb / KIB_PER_GIB,
    swapUsedKb: cur.mem?.swapUsedKb ?? null,
    oomKillsDelta: change(baseline, cur, (s) => s.oomKills),
    udpInErrorsDelta: change(baseline, cur, udpInErrors),
    udpInErrorsWindow: change(prev, cur, udpInErrors),
    sock7882DropsDelta: change(baseline, cur, sock7882Drops),
    sock7882DropsWindow: change(prev, cur, sock7882Drops),
    softnetDroppedDelta: change(baseline, cur, softnetDropped),
    softnetDroppedWindow: change(prev, cur, softnetDropped),
    qdiscDroppedDelta: change(baseline, cur, qdiscDropped),
    qdiscDroppedWindow: change(prev, cur, qdiscDropped),
    nicDropsErrsDelta: change(baseline, cur, nicDropsErrs),
    nicDropsErrsWindow: change(prev, cur, nicDropsErrs),
    txMbps: mbps(perSecond(prev, cur, txBytes)),
    pps: perSecond(prev, cur, packets),
    conntrackCount: cur.conntrack?.count ?? null,
    ngxWorkerConnErrorsDelta: change(baseline, cur, ngxWorkerConnErrors),
    ngxUpstreamErrorsWindow: change(prev, cur, ngxUpstreamErrors),
    ngxBusiestSharePct:
      nginx === null || fds.length === 0 || nginx.workerConnections <= 0
        ? null
        : (Math.max(...fds) / nginx.workerConnections) * 100,
    lkHealthNon200Consecutive: cur.sut === null ? null : next.lkNon200Consecutive,
    lkHealth406: cur.sut === null ? null : health === 406 ? 1 : 0,
    containerRestartsDelta: change(baseline, cur, containerRestarts),
  };
  return { metrics, state: next };
}

/** Generator metrics for one sample (worker crashes and unexplained processes are the agent's). */
export function deriveGenerator(
  baseline: HostSample,
  prev: HostSample | null,
  cur: HostSample,
  opts: GeneratorOptions,
): { metrics: MetricValues } {
  const busy = coreBusy(prev, cur);
  const link = opts.linkMbps;
  const rx = mbps(perSecond(prev, cur, rxBytes));
  const tx = mbps(perSecond(prev, cur, txBytes));
  const drops = (from: HostSample | null): number | null =>
    sum([udpInErrors, softnetDropped, qdiscDropped, nicDropsErrs].map((r) => change(from, cur, r)));
  const metrics: MetricValues = {
    gCpuHotPct: hottestBusyPct(busy),
    gCpuTotalPct: totalBusyPct(busy),
    gMemAvailablePct:
      cur.mem === null || cur.mem.totalKb <= 0
        ? null
        : (cur.mem.availableKb / cur.mem.totalKb) * 100,
    gNicPct:
      link === null || link <= 0 || rx === null || tx === null
        ? null
        : (Math.max(rx, tx) / link) * 100,
    gDropsDelta: drops(baseline),
    gDropsWindow: drops(prev),
    gLoopLagP95Ms: opts.loopLagP95Ms,
    gClockOffsetMs: cur.clockOffsetMs === null ? null : Math.abs(cur.clockOffsetMs),
  };
  return { metrics };
}

/** Sections a rule reads, per role (a null `livekitHttp` is a health answer, not a gap). */
const REQUIRED_SECTIONS: Readonly<
  Record<HostSample['role'], Readonly<Record<string, (s: HostSample) => boolean>>>
> = {
  sut: {
    cores: (s) => s.cores !== null,
    cpuClockMs: (s) => s.cpuClockMs !== null,
    load1: (s) => s.load1 !== null,
    mem: (s) => s.mem !== null,
    oomKills: (s) => s.oomKills !== null,
    net: (s) => s.net !== null,
    qdisc: (s) => s.qdisc !== null,
    'udp.v4': (s) => s.udp.v4 !== null,
    'udp.v6': (s) => s.udp.v6 !== null,
    softnet: (s) => s.softnet !== null,
    conntrack: (s) => s.conntrack !== null,
    udpSockets: (s) => s.udpSockets !== null,
    'sut.containers': (s) => s.sut !== null && s.sut.containers !== null,
    'sut.nginx': (s) => s.sut !== null && s.sut.nginx !== null,
  },
  generator: {
    cores: (s) => s.cores !== null,
    cpuClockMs: (s) => s.cpuClockMs !== null,
    mem: (s) => s.mem !== null,
    net: (s) => s.net !== null,
    qdisc: (s) => s.qdisc !== null,
    'udp.v4': (s) => s.udp.v4 !== null,
    'udp.v6': (s) => s.udp.v6 !== null,
    softnet: (s) => s.softnet !== null,
    clockOffsetMs: (s) => s.clockOffsetMs !== null,
  },
};

/**
 * Between two consecutive samples of one sampler: a gap of more than
 * SAMPLER_MAX_GAP seqs, and errata E4 — the watched processes (matched by PID)
 * cannot have run longer than the host was busy. Both sides are EXACT: per-process
 * utime+stime are scaled to the scheduler's runtime, and the host side is the exact
 * meter (Σ per-core wall − idle − iowait, observe/cpu-meter.ts) — never /proc/stat
 * busy ticks (sampled, under-read) nor /proc/schedstat (credited at switch-out,
 * lumpy per window; errata E9).
 */
function pairProblems(prev: HostSample, cur: HostSample): string[] {
  const problems: string[] = [];
  const missed = cur.seq - prev.seq - 1;
  if (missed > SAMPLER_MAX_GAP)
    problems.push(`${cur.host}: ${missed} consecutive samples missing after seq ${prev.seq}`);
  if (prev.cpuClockMs !== null && cur.cpuClockMs !== null && cur.cpuClockMs <= prev.cpuClockMs) {
    problems.push(`${cur.host} seq ${cur.seq}: CPU clock did not advance (E4)`);
    return problems;
  }
  const cores = coreBusy(prev, cur);
  if (cores === null) return problems;
  const hostBusy = cores.reduce((a, c) => a + c.busy, 0);
  const before = new Map(prev.procs.map((p) => [p.pid, p.cpuTicks]));
  const counted = new Map<number, number>(); // each PID once, whatever role labels it carries
  for (const p of cur.procs) {
    const was = before.get(p.pid);
    if (was !== undefined) counted.set(p.pid, p.cpuTicks - was);
  }
  const procs = [...counted.values()].reduce((a, v) => a + v, 0);
  // Resolution, not tolerance: each process's ticks are read apart from /proc/stat and floored
  // (E4_SKEW_TICKS_PER_PROCESS), and idle/iowait are floored per read (IDLE_CLOCK_RESOLUTION_TICKS).
  const bound =
    E4_SKEW_TICKS_PER_PROCESS * counted.size + IDLE_CLOCK_RESOLUTION_TICKS * cores.length;
  if (procs > hostBusy + bound)
    problems.push(
      `${cur.host} seq ${cur.seq}: Σ process CPU ${procs} > host busy ${Math.round(hostBusy)} ticks (E4)`,
    );
  return problems;
}

function sampleProblems(s: HostSample): string[] {
  const problems: string[] = [];
  const missing = Object.entries(REQUIRED_SECTIONS[s.role])
    .filter(([, present]) => !present(s))
    .map(([name]) => name);
  if (missing.length > 0) problems.push(`${s.host} seq ${s.seq}: null ${missing.join(', ')}`);
  if (s.role === 'sut' && s.udpSockets !== null) {
    for (const { port, count } of SAMPLER_EXPECTED_SOCKETS) {
      const found = s.udpSockets.filter((u) => u.port === port).length;
      if (found !== count)
        problems.push(
          `${s.host} seq ${s.seq}: ${found} UDP sockets on :${port}, expected ${count}`,
        );
    }
  }
  return problems;
}

/**
 * V-sampler over ONE sampler's series (the SUT, or one agent; any order): null
 * sections a rule needs, the expected SUT sockets, gaps and errata E4. Callers
 * pass each sampler separately — a hostname is not an identity (cloned generator
 * VMs, local agents). Returns one line per problem; empty = valid.
 */
export function samplerSanity(series: readonly HostSample[]): string[] {
  const sorted = [...series].sort((a, b) => a.seq - b.seq);
  const problems: string[] = [];
  sorted.forEach((cur, k) => {
    problems.push(...sampleProblems(cur));
    const prev = sorted[k - 1];
    if (prev !== undefined) problems.push(...pairProblems(prev, cur));
  });
  return problems;
}
