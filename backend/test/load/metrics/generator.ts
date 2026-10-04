/**
 * P8.2 — generator-side metrics. Distinct from metrics/collector.ts, which reads
 * the STAGING host's counters (the system under test). This collects the LOAD
 * GENERATOR's own numbers: this process's CPU/RAM, the generator host's NIC
 * RX/TX, and harness counters (connect/publish/subscribe success/failure,
 * reconnects, relay outcomes). It answers "did the generator keep up?" — without
 * it, server-side metrics can't be trusted (a starved generator looks like a
 * server limit).
 *
 * Exports CSV. Pure counter arithmetic is separated from sampling for testing.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';

import { parseNetDev } from './parsers';

/** Monotonic harness counters, incremented by the media/API runners. */
export class GeneratorCounters {
  connectOk = 0;
  connectFail = 0;
  publishOk = 0;
  publishFail = 0;
  subscribeOk = 0;
  subscribeFail = 0;
  reconnects = 0;
  relayOk = 0;
  relayFail = 0;

  snapshot(): Readonly<Record<string, number>> {
    return {
      connect_ok: this.connectOk,
      connect_fail: this.connectFail,
      publish_ok: this.publishOk,
      publish_fail: this.publishFail,
      subscribe_ok: this.subscribeOk,
      subscribe_fail: this.subscribeFail,
      reconnects: this.reconnects,
      relay_ok: this.relayOk,
      relay_fail: this.relayFail,
    };
  }
}

export interface GeneratorSample {
  readonly tMs: number;
  readonly procCpuPercent: number;
  readonly procRssMiB: number;
  readonly genTxBytes: number;
  readonly genRxBytes: number;
  readonly counters: Readonly<Record<string, number>>;
}

export const GENERATOR_CSV_HEADER =
  't_ms,proc_cpu_pct,proc_rss_mib,gen_tx_mbps,gen_rx_mbps,active,' +
  'connect_ok,connect_fail,publish_ok,publish_fail,subscribe_ok,subscribe_fail,reconnects,relay_ok,relay_fail';

/** Converts process.cpuUsage() deltas to a percentage over a wall interval. */
export function cpuPercent(prevUsageUs: number, curUsageUs: number, wallMs: number): number {
  if (wallMs <= 0) return 0;
  return ((curUsageUs - prevUsageUs) / 1000 / wallMs) * 100;
}

export function toGeneratorCsvRow(
  prev: GeneratorSample | null,
  cur: GeneratorSample,
  active: number,
): string {
  const dtSec = prev ? Math.max(0.001, (cur.tMs - prev.tMs) / 1000) : 1;
  const txMbps = prev
    ? (((cur.genTxBytes - prev.genTxBytes) * 8) / 1e6 / dtSec).toFixed(2)
    : '0.00';
  const rxMbps = prev
    ? (((cur.genRxBytes - prev.genRxBytes) * 8) / 1e6 / dtSec).toFixed(2)
    : '0.00';
  const c = cur.counters;
  return [
    cur.tMs,
    cur.procCpuPercent.toFixed(1),
    Math.round(cur.procRssMiB),
    txMbps,
    rxMbps,
    active,
    c.connect_ok ?? 0,
    c.connect_fail ?? 0,
    c.publish_ok ?? 0,
    c.publish_fail ?? 0,
    c.subscribe_ok ?? 0,
    c.subscribe_fail ?? 0,
    c.reconnects ?? 0,
    c.relay_ok ?? 0,
    c.relay_fail ?? 0,
  ].join(',');
}

/** Samples this process + the generator host's NIC. Read-only. */
export class GeneratorMetrics {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: GeneratorSample | null = null;
  private prevCpuUs = 0;
  private prevWallMs = 0;

  constructor(
    private readonly outPath: string,
    private readonly counters: GeneratorCounters,
    private readonly activeFn: () => number,
    private readonly iface = 'eth0',
  ) {}

  async start(intervalMs: number): Promise<void> {
    await writeFile(this.outPath, `${GENERATOR_CSV_HEADER}\n`, 'utf8');
    this.prevCpuUs = sumCpuUs(process.cpuUsage());
    this.prevWallMs = Date.now();
    const tick = async (): Promise<void> => {
      const sample = await this.sample();
      await appendFile(
        this.outPath,
        `${toGeneratorCsvRow(this.prev, sample, this.activeFn())}\n`,
        'utf8',
      ).catch(() => undefined);
      this.prev = sample;
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sample(): Promise<GeneratorSample> {
    const nowMs = Date.now();
    const cpuUs = sumCpuUs(process.cpuUsage());
    const pct = cpuPercent(this.prevCpuUs, cpuUs, nowMs - this.prevWallMs);
    this.prevCpuUs = cpuUs;
    this.prevWallMs = nowMs;
    const dev = await readFile('/proc/net/dev', 'utf8').catch(() => '');
    const net = parseNetDev(dev, this.iface);
    return {
      tMs: nowMs,
      procCpuPercent: pct,
      procRssMiB: process.memoryUsage().rss / (1024 * 1024),
      genTxBytes: net?.txBytes ?? 0,
      genRxBytes: net?.rxBytes ?? 0,
      counters: this.counters.snapshot(),
    };
  }
}

function sumCpuUs(usage: NodeJS.CpuUsage): number {
  return usage.user + usage.system;
}
