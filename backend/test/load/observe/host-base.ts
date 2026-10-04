/**
 * P8.4 — the host counters every sampler shares (SUT and generators alike):
 * per-core CPU, load, memory/swap, OOM kills, NIC, qdisc, UDP v4/v6, softnet,
 * conntrack, per-socket UDP drops and per-PID process counters. Reads go through
 * an injectable `Readers` seam that only ever READS (`/proc`, `/sys`, `ss`,
 * `tc -s`, `iptables -L -v`, `docker inspect`); parsing is the pure
 * metrics/procfs.ts. A failed read yields null — never a zero.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

import { parseConntrackCount, parseLoadAvg } from '../metrics/parsers';
import {
  parseMemSwap,
  parseNetDevFull,
  parsePidStat,
  parsePidStatus,
  parseProcStatCores,
  parseSoftnetFull,
  parseSsUdpSockets,
  parseTcQdisc,
  parseUdpSnmp4,
  parseUdpSnmp6,
  parseVmstatOomKill,
} from '../metrics/procfs';
import { idleClockExact } from './cpu-meter';
import { type HostSample, type ProcCounters } from './sample';

const run = promisify(execFile);

/** /proc/stat with the reader's monotonic clock at that read (the exact CPU meter's window). */
export interface ProcStatRead {
  readonly text: string;
  /** Monotonic ms of this process at the read (midpoint of the brackets around it). */
  readonly monoMs: number;
}

export interface Readers {
  /** File contents, or null when unreadable. */
  file(path: string): Promise<string | null>;
  /** /proc/stat and the clock at that read, or null when unreadable. */
  procStat(): Promise<ProcStatRead | null>;
  /** A read-only command's stdout (no shell), or null on failure. */
  cmd(file: string, args: readonly string[]): Promise<string | null>;
  /** Entries in /proc/<pid>/fd, or null. */
  fdCount(pid: number): Promise<number | null>;
  /** Every PID currently in /proc, or null. */
  pids(): Promise<number[] | null>;
}

export function systemReaders(): Readers {
  return {
    file: (path) => readFile(path, 'utf8').catch(() => null),
    // Synchronous on purpose: nothing can run between the clock and the read it brackets.
    procStat: async () => {
      try {
        const before = performance.now();
        const text = readFileSync('/proc/stat', 'utf8');
        return { text, monoMs: (before + performance.now()) / 2 };
      } catch {
        return null;
      }
    },
    cmd: async (file, args) => {
      try {
        return (await run(file, [...args], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
      } catch {
        return null;
      }
    },
    fdCount: (pid) =>
      readdir(`/proc/${pid}/fd`)
        .then((entries) => entries.length)
        .catch(() => null),
    pids: () =>
      readdir('/proc')
        .then((entries) => entries.filter((e) => /^\d+$/.test(e)).map(Number))
        .catch(() => null),
  };
}

export type BaseCounters = Pick<
  HostSample,
  | 'cores'
  | 'cpuClockMs'
  | 'load1'
  | 'mem'
  | 'oomKills'
  | 'net'
  | 'qdisc'
  | 'udp'
  | 'softnet'
  | 'conntrack'
  | 'udpSockets'
>;

const or = <T>(text: string | null, parse: (t: string) => T | null): T | null =>
  text === null ? null : parse(text);

/** The shared host counters for interface `iface`. */
export async function sampleBase(r: Readers, iface: string): Promise<BaseCounters> {
  const [stat, cmdline, load, mem, vmstat, dev, qdisc, snmp, snmp6, softnet, ctCount, ctMax, ss] =
    await Promise.all([
      r.procStat(),
      r.file('/proc/cmdline'),
      r.file('/proc/loadavg'),
      r.file('/proc/meminfo'),
      r.file('/proc/vmstat'),
      r.file('/proc/net/dev'),
      r.cmd('tc', ['-s', 'qdisc', 'show', 'dev', iface]),
      r.file('/proc/net/snmp'),
      r.file('/proc/net/snmp6'),
      r.file('/proc/net/softnet_stat'),
      r.file('/proc/sys/net/netfilter/nf_conntrack_count'),
      r.file('/proc/sys/net/netfilter/nf_conntrack_max'),
      r.cmd('ss', ['-H', '-uanm']),
    ]);
  const cores = stat === null ? null : parseProcStatCores(stat.text);
  const count = or(ctCount, parseConntrackCount);
  const max = or(ctMax, parseConntrackCount);
  return {
    cores,
    cpuClockMs: cores !== null && stat !== null && idleClockExact(cmdline) ? stat.monoMs : null,
    load1: or(load, parseLoadAvg)?.one ?? null,
    mem: or(mem, parseMemSwap),
    oomKills: or(vmstat, parseVmstatOomKill),
    net: or(dev, (t) => parseNetDevFull(t, iface)),
    qdisc: or(qdisc, parseTcQdisc),
    udp: { v4: or(snmp, parseUdpSnmp4), v6: or(snmp6, parseUdpSnmp6) },
    softnet: or(softnet, parseSoftnetFull),
    conntrack: count !== null && max !== null ? { count, max } : null,
    udpSockets: or(ss, parseSsUdpSockets),
  };
}

/** One process's counters by PID (never looked up by name). */
export async function procCounters(
  r: Readers,
  pid: number,
  role: string,
): Promise<ProcCounters | null> {
  const [stat, status, fds] = await Promise.all([
    r.file(`/proc/${pid}/stat`),
    r.file(`/proc/${pid}/status`),
    r.fdCount(pid),
  ]);
  const s = or(stat, parsePidStat);
  const st = or(status, parsePidStatus);
  if (!s || !st) return null;
  return { pid, role, cpuTicks: s.utime + s.stime, rssKb: st.rssKb, fds, threads: st.threads };
}

/** Counters for every listed process that still exists. */
export async function procsOf(
  r: Readers,
  list: ReadonlyArray<{ readonly pid: number; readonly role: string }>,
): Promise<ProcCounters[]> {
  const out = await Promise.all(list.map((p) => procCounters(r, p.pid, p.role)));
  return out.filter((p): p is ProcCounters => p !== null);
}

/** The interface carrying the IPv4 default route, from /proc/net/route text (lowest metric). Pure. */
export function parseDefaultRouteIface(text: string): string | null {
  let best: { iface: string; metric: number } | null = null;
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue;
    const metric = Number(f[6]);
    if (!best || metric < best.metric) best = { iface: f[0] ?? '', metric };
  }
  return best?.iface || null;
}
