/**
 * P8.4 — pure parsers for the host signals the samplers read (design §9): per-core
 * /proc/stat, /proc/net/{snmp,snmp6,dev,softnet_stat}, /proc/vmstat, /proc/meminfo,
 * /proc/<pid>/{stat,status}, and the stdout of the read-only `ss -H -uanm`,
 * `tc -s qdisc show`, `iptables -L <chain> -v -x -n` and the nginx error-log tail.
 * Text in, typed struct out, no I/O. A parser that cannot read its source returns
 * `null` (observe/sample.ts: a missing source is a validity failure, never a silent
 * zero); the count-style parsers return zero only where absence genuinely means zero.
 */
import {
  type CoreTicks,
  type NetCounters,
  type UdpCounters,
  type UdpSocketDrops,
} from '../observe/sample';
import { parseMemInfo, parseUdpSnmp } from './parsers';

export interface PidStat {
  readonly pid: number;
  /** Single-letter scheduler state, e.g. `R`, `S`, `Z`. */
  readonly state: string;
  readonly ppid: number;
  readonly pgrp: number;
  /** User / system CPU in clock ticks (CLK_TCK). */
  readonly utime: number;
  readonly stime: number;
  /** Clock ticks after boot; with the PID it identifies one process incarnation. */
  readonly starttime: number;
}

export interface PidStatus {
  readonly rssKb: number;
  readonly threads: number;
}

/** A non-negative decimal integer, or null. */
function uint(token: string | undefined): number | null {
  return token !== undefined && /^\d+$/.test(token) ? Number(token) : null;
}

/** Every token as a non-negative integer, or null if any is missing or malformed. */
function uints(values: ReadonlyArray<string | undefined>): number[] | null {
  const out: number[] = [];
  for (const token of values) {
    const value = uint(token);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

/** The whitespace-separated tokens of `s`. */
function tokens(s: string): string[] {
  return s.trim().split(/\s+/);
}

/**
 * The first value token of the line keyed `key`, in any of the procfs `key value`
 * forms (`Udp6InErrors  0`, `MemTotal:  98873676 kB`, `Threads:\t1`, `oom_kill 0`).
 */
function keyedToken(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const [name, value] = line.trim().split(/[:\s]+/);
    if (name === key) return value;
  }
  return undefined;
}

/**
 * Cumulative per-core jiffies from /proc/stat: lines `cpu0`..`cpuN` (the aggregate
 * `cpu ` line is excluded), columns user nice system idle iowait irq softirq steal.
 * Null if there is no per-core line or any per-core line is malformed.
 */
export function parseProcStatCores(text: string): CoreTicks[] | null {
  const cores: CoreTicks[] = [];
  for (const line of text.split('\n')) {
    const match = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const v = uints(tokens(match[2] ?? '').slice(0, 8));
    if (v === null || v.length < 8) return null;
    const [user, nice, sys, idle, iowait, irq, soft, steal] = v;
    cores.push({ id: Number(match[1]), user, nice, sys, idle, iowait, irq, soft, steal });
  }
  return cores.length > 0 ? cores : null;
}

/** IPv6 UDP counters from /proc/net/snmp6; null unless all five keys are present. */
export function parseUdpSnmp6(text: string): UdpCounters | null {
  const keys = [
    'Udp6InDatagrams',
    'Udp6OutDatagrams',
    'Udp6InErrors',
    'Udp6RcvbufErrors',
    'Udp6SndbufErrors',
  ];
  const v = uints(keys.map((key) => keyedToken(text, key)));
  if (v === null) return null;
  const [inDatagrams, outDatagrams, inErrors, rcvbufErrors, sndbufErrors] = v;
  return { inDatagrams, outDatagrams, inErrors, rcvbufErrors, sndbufErrors };
}

/** IPv4 UDP counters from /proc/net/snmp (parsers.ts `parseUdpSnmp`), in the sample's shape. */
export function parseUdpSnmp4(text: string): UdpCounters | null {
  const udp = parseUdpSnmp(text);
  if (udp === null) return null;
  return {
    inDatagrams: udp.inDatagrams,
    outDatagrams: udp.outDatagrams,
    inErrors: udp.inErrors,
    rcvbufErrors: udp.rcvbufErrors,
    sndbufErrors: udp.sndbufErrors,
  };
}

/**
 * One interface's counters from /proc/net/dev. Columns after `<iface>:` — rx: bytes
 * packets errs drop fifo frame compressed multicast | tx: bytes packets errs drop fifo
 * colls carrier compressed. Null if the interface is absent or its row is malformed.
 */
export function parseNetDevFull(text: string, iface: string): NetCounters | null {
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0 || line.slice(0, colon).trim() !== iface) continue;
    const v = uints(tokens(line.slice(colon + 1)));
    if (v === null || v.length < 16) return null;
    return {
      iface,
      rxBytes: v[0],
      txBytes: v[8],
      rxPackets: v[1],
      txPackets: v[9],
      rxDrop: v[3],
      txDrop: v[11],
      rxErr: v[2],
      txErr: v[10],
    };
  }
  return null;
}

/**
 * /proc/net/softnet_stat (hex, one row per CPU): column 2 `dropped` and column 3
 * `time_squeeze`, each summed over the CPUs.
 */
export function parseSoftnetFull(text: string): { dropped: number; timeSqueeze: number } {
  const hex = (token: string | undefined): number | null =>
    token !== undefined && /^[0-9a-f]+$/i.test(token) ? parseInt(token, 16) : null;
  let dropped = 0;
  let timeSqueeze = 0;
  for (const line of text.split('\n')) {
    const cols = tokens(line);
    const rowDropped = hex(cols[1]);
    const rowSqueeze = hex(cols[2]);
    if (rowDropped === null || rowSqueeze === null) continue;
    dropped += rowDropped;
    timeSqueeze += rowSqueeze;
  }
  return { dropped, timeSqueeze };
}

/** The cumulative `oom_kill` count from /proc/vmstat; null if absent. */
export function parseVmstatOomKill(text: string): number | null {
  return uint(keyedToken(text, 'oom_kill'));
}

/** MemTotal, MemAvailable and swap in use (SwapTotal − SwapFree) from /proc/meminfo, in kB. */
export function parseMemSwap(
  text: string,
): { totalKb: number; availableKb: number; swapUsedKb: number } | null {
  const mem = parseMemInfo(text);
  const swap = uints([keyedToken(text, 'SwapTotal'), keyedToken(text, 'SwapFree')]);
  if (mem === null || swap === null) return null;
  const [swapTotal, swapFree] = swap;
  return { totalKb: mem.totalKb, availableKb: mem.availableKb, swapUsedKb: swapTotal - swapFree };
}

/**
 * /proc/<pid>/stat. The comm field (2) may itself contain spaces and parentheses, so
 * the fixed fields are read after the LAST `)`: there, proc(5) field n is at n − 3.
 */
export function parsePidStat(text: string): PidStat | null {
  const open = text.indexOf(' (');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = tokens(text.slice(close + 1));
  const state = f[0] ?? '';
  const v = uints([text.slice(0, open), f[1], f[2], f[11], f[12], f[19]]);
  if (v === null || !/^[A-Za-z]$/.test(state)) return null;
  const [pid, ppid, pgrp, utime, stime, starttime] = v;
  return { pid, state, ppid, pgrp, utime, stime, starttime };
}

/**
 * VmRSS (kB) and Threads from /proc/<pid>/status. VmRSS is absent for kernel threads
 * and zombies, which own no user memory, so absence reads as 0; Threads is required.
 */
export function parsePidStatus(text: string): PidStatus | null {
  const v = uints([keyedToken(text, 'VmRSS') ?? '0', keyedToken(text, 'Threads')]);
  if (v === null) return null;
  const [rssKb, threads] = v;
  return { rssKb, threads };
}

/**
 * Per-socket drops from `ss -H -uanm` (sock_diag, so it also sees the sockets that
 * /proc/net/udp* does not list). A record is one socket line — State Recv-Q Send-Q
 * Local Peer — plus the indented lines after it; its drops are the `d<N>` of the
 * record's `skmem:(…)`. Local forms: `213.136.65.135:7882`, `[2a02:…::1]:7882`,
 * `*:3478`, `[::]:5353`, `127.0.0.53%lo:53`; the port is the number after the last `:`.
 *
 * - A record with NO skmem block (ss run without `-m`) gets drops 0.
 * - A record whose skmem block lacks `d<N>` is omitted, not zeroed, so the sampler's
 *   expected-socket check (4 × 7882, 1 × 3478) fails closed.
 * - Records are delimited by indentation, never by position, so a socket without a
 *   skmem line can never borrow the next socket's counters.
 */
export function parseSsUdpSockets(text: string): UdpSocketDrops[] {
  const records: string[][] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) records[records.length - 1]?.push(line);
    else records.push([line]);
  }
  const out: UdpSocketDrops[] = [];
  for (const record of records) {
    const socket = ssSocket(record);
    if (socket !== null) out.push(socket);
  }
  return out;
}

function ssSocket(record: readonly string[]): UdpSocketDrops | null {
  const local = tokens(record[0] ?? '')[3];
  if (local === undefined || !local.includes(':')) return null;
  const port = uint(local.slice(local.lastIndexOf(':') + 1));
  if (port === null) return null;
  const skmem = /skmem:\(([^)]*)\)/.exec(record.join('\n'));
  if (skmem === null) return { local, port, drops: 0 };
  const drops = uint(/(?:^|,)d(\d+)(?:,|$)/.exec(skmem[1] ?? '')?.[1]);
  return drops === null ? null : { local, port, drops };
}

/**
 * Non-empty lines: the socket count of an `ss -H` listing run WITHOUT `-m`/`-e`/`-i`
 * (those add a continuation line per socket).
 */
export function countLines(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

/**
 * Cumulative drops/overlimits of the root qdisc from `tc -s qdisc show dev <if>`: the
 * FIRST block, which tc prints for the root. Its `Sent … (dropped D, overlimits O
 * requeues R)` already covers its children (an `mq` root aggregates its per-queue
 * qdiscs), so child blocks are not added. Null if the first block is not the root or
 * has no `Sent` line.
 */
export function parseTcQdisc(text: string): { dropped: number; overlimits: number } | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('qdisc '));
  if (start < 0 || !/\sroot\b/.test(lines[start] ?? '')) return null;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('qdisc ')) break;
    const match = /^\s*Sent \d+ bytes \d+ pkt \(dropped (\d+), overlimits (\d+)\b/.exec(line);
    if (match !== null) return { dropped: Number(match[1]), overlimits: Number(match[2]) };
  }
  return null;
}

/**
 * ufw new-flow counters (design T6) from `iptables -L ufw-user-input -v -x -n` (or
 * `ip6tables -L ufw6-user-input …`): per requested port, the summed `pkts` of the rows
 * whose protocol is udp — `17` from nft-backed iptables, `udp` from legacy — and whose
 * match is exactly `dpt:<port>` (port ranges `dpts:` never match). Columns are
 * pkts bytes target prot …; ufw gives every rule a target, so prot is the fourth.
 * A requested port with no matching row is 0.
 */
export function parseFwNewFlows(text: string, ports: readonly number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const port of ports) out[port] = 0;
  for (const line of text.split('\n')) {
    const cols = tokens(line);
    const pkts = uint(cols[0]);
    if (pkts === null || (cols[3] !== 'udp' && cols[3] !== '17')) continue;
    const port = uint(cols.find((col) => col.startsWith('dpt:'))?.slice('dpt:'.length));
    if (port !== null && port in out) out[port] += pkts;
  }
  return out;
}

const UPSTREAM_FAILURES = [
  'timed out',
  'connect() failed',
  'prematurely closed',
  'no live upstreams',
];

/**
 * nginx error-log line counts: `worker_connections are not enough`, and upstream
 * failures (the line names `upstream` and one of UPSTREAM_FAILURES). Counted
 * independently; a worker_connections line that mentions upstream is not an upstream
 * failure unless it also carries a failure phrase.
 */
export function parseNginxErrors(text: string): { workerConnections: number; upstream: number } {
  let workerConnections = 0;
  let upstream = 0;
  for (const line of text.split('\n')) {
    if (line.includes('worker_connections are not enough')) workerConnections += 1;
    if (line.includes('upstream') && UPSTREAM_FAILURES.some((phrase) => line.includes(phrase)))
      upstream += 1;
  }
  return { workerConnections, upstream };
}
