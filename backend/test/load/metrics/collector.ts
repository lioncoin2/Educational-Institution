/**
 * P8 load harness — the lightweight, run-scoped metrics collector. It samples a
 * fixed set of READ-ONLY host and Docker counters on an interval and appends a
 * CSV row per sample. It is not a permanent monitoring stack: it starts when a
 * run starts and stops when the run stops.
 *
 * All system access goes through an injectable `Readers` seam so the row-building
 * logic is unit-tested against fixtures with no real I/O. The default readers
 * only ever READ (`/proc`, `docker stats`, `ss -s`) — nothing here can change
 * the system.
 */
import { execFile } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  parseConntrackCount,
  parseDockerStats,
  parseLoadAvg,
  parseMemInfo,
  parseNetDev,
  parseSoftnetDropped,
  parseSsSummary,
  parseUdpSnmp,
} from './parsers';

const run = promisify(execFile);

/** Raw-text sources. Each resolves to the contents a parser expects, or ''. */
export interface Readers {
  procNetDev(): Promise<string>;
  procSnmp(): Promise<string>;
  softnet(): Promise<string>;
  loadavg(): Promise<string>;
  meminfo(): Promise<string>;
  conntrack(): Promise<string>;
  dockerStats(): Promise<string>;
  ssSummary(): Promise<string>;
}

/** One fully-parsed sample. Counters are raw; the writer derives per-second rates. */
export interface Sample {
  readonly tMs: number;
  readonly txBytes: number;
  readonly txPackets: number;
  readonly rxBytes: number;
  readonly udpInErrors: number;
  readonly udpRcvbufErrors: number;
  readonly softnetDropped: number;
  readonly load1: number;
  readonly memAvailableMiB: number;
  readonly conntrack: number;
  readonly estabConns: number;
  readonly containers: ReadonlyArray<{ name: string; cpuPercent: number; memMiB: number }>;
}

export const CSV_HEADER =
  't_ms,tx_mbps,tx_pps,rx_mbps,udp_in_errors,udp_rcvbuf_errors,softnet_dropped,' +
  'load1,mem_available_mib,conntrack,estab_conns,livekit_cpu,livekit_mem_mib,api_cpu,api_mem_mib';

/** Default readers: read-only access to the real host. */
export function defaultReaders(iface = 'eth0'): Readers {
  void iface;
  const cat = (path: string) => readFile(path, 'utf8').catch(() => '');
  const cmd = async (file: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await run(file, args, { timeout: 5000 });
      return stdout;
    } catch {
      return '';
    }
  };
  return {
    procNetDev: () => cat('/proc/net/dev'),
    procSnmp: () => cat('/proc/net/snmp'),
    softnet: () => cat('/proc/net/softnet_stat'),
    loadavg: () => cat('/proc/loadavg'),
    meminfo: () => cat('/proc/meminfo'),
    conntrack: () => cat('/proc/sys/net/netfilter/nf_conntrack_count'),
    dockerStats: () =>
      cmd('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}']),
    ssSummary: () => cmd('ss', ['-s']),
  };
}

/** Builds one Sample from the readers. Pure given the readers. */
export async function sampleOnce(
  readers: Readers,
  iface = 'eth0',
  now = Date.now,
): Promise<Sample> {
  const [dev, snmp, soft, load, mem, ct, docker, ss] = await Promise.all([
    readers.procNetDev(),
    readers.procSnmp(),
    readers.softnet(),
    readers.loadavg(),
    readers.meminfo(),
    readers.conntrack(),
    readers.dockerStats(),
    readers.ssSummary(),
  ]);
  const net = parseNetDev(dev, iface);
  const udp = parseUdpSnmp(snmp);
  const memInfo = parseMemInfo(mem);
  const loadAvg = parseLoadAvg(load);
  const summary = parseSsSummary(ss);
  return {
    tMs: now(),
    txBytes: net?.txBytes ?? 0,
    txPackets: net?.txPackets ?? 0,
    rxBytes: net?.rxBytes ?? 0,
    udpInErrors: udp?.inErrors ?? 0,
    udpRcvbufErrors: udp?.rcvbufErrors ?? 0,
    softnetDropped: parseSoftnetDropped(soft),
    load1: loadAvg?.one ?? 0,
    memAvailableMiB: memInfo ? memInfo.availableKb / 1024 : 0,
    conntrack: parseConntrackCount(ct) ?? 0,
    estabConns: summary?.estab ?? 0,
    containers: parseDockerStats(docker),
  };
}

/** Turns two consecutive samples into a CSV row, deriving per-second rates. */
export function toCsvRow(prev: Sample | null, cur: Sample): string {
  const dtSec = prev ? Math.max(0.001, (cur.tMs - prev.tMs) / 1000) : 1;
  const txMbps = prev ? (((cur.txBytes - prev.txBytes) * 8) / 1e6 / dtSec).toFixed(2) : '0.00';
  const txPps = prev ? Math.round((cur.txPackets - prev.txPackets) / dtSec) : 0;
  const rxMbps = prev ? (((cur.rxBytes - prev.rxBytes) * 8) / 1e6 / dtSec).toFixed(2) : '0.00';
  const find = (needle: string) => cur.containers.find((c) => c.name.includes(needle));
  const lk = find('livekit');
  const api = find('api');
  return [
    cur.tMs,
    txMbps,
    txPps,
    rxMbps,
    cur.udpInErrors,
    cur.udpRcvbufErrors,
    cur.softnetDropped,
    cur.load1.toFixed(2),
    Math.round(cur.memAvailableMiB),
    cur.conntrack,
    cur.estabConns,
    (lk?.cpuPercent ?? 0).toFixed(1),
    Math.round(lk?.memMiB ?? 0),
    (api?.cpuPercent ?? 0).toFixed(1),
    Math.round(api?.memMiB ?? 0),
  ].join(',');
}

/** A run-scoped sampler that writes CSV to `outPath`. Read-only sampling. */
export class Collector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: Sample | null = null;

  constructor(
    private readonly outPath: string,
    private readonly readers: Readers = defaultReaders(),
    private readonly iface = 'eth0',
  ) {}

  async start(intervalMs: number): Promise<void> {
    await writeFile(this.outPath, `${CSV_HEADER}\n`, 'utf8');
    const tick = async (): Promise<void> => {
      const sample = await sampleOnce(this.readers, this.iface);
      await appendFile(this.outPath, `${toCsvRow(this.prev, sample)}\n`, 'utf8').catch(
        () => undefined,
      );
      this.prev = sample;
    };
    await tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
