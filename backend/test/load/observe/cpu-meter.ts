/**
 * P8.4 — the exact host CPU meter (D-12, errata E9). Per core, busy over a
 * window is wall − idle − iowait. Under NO_HZ the kernel keeps idle and iowait
 * on its idle clock — exact, the idle period in progress included — while the
 * busy fields of /proc/stat are sampled at the timer tick and under-read
 * (a pinned 100 % core read 48–100 %). `/proc/schedstat` `rq_cpu_time` is not
 * used: it is credited when a task is switched out, so the same core read 0 %
 * in some windows and up to 460 % in others. Wall is the sampler's monotonic
 * clock taken at the /proc/stat read (`HostSample.cpuClockMs`).
 *
 * Bounds: busy never exceeds its window (idle and iowait never count
 * backwards), so no percentage can exceed capacity; a remainder below zero
 * (idle floored to whole ticks, read-time skew) is 0. Pure.
 */
import { CLK_TCK, type HostSample } from './sample';

export interface CoreBusy {
  readonly id: number;
  /** Exact busy ticks in the window: 0 ≤ busy ≤ window. */
  readonly busy: number;
  /** The window, in ticks (the same for every core of one sample pair). */
  readonly window: number;
}

/**
 * /proc/stat reports idle and iowait floored to whole ticks at each read, so a
 * window's busy can read low — never high — by under 1 tick each: at most this
 * many ticks per core (the E4 resolution bound).
 */
export const IDLE_CLOCK_RESOLUTION_TICKS = 2;

/**
 * The idle clock is exact only while NO_HZ is active; `nohz=off` on the kernel
 * command line turns it back into tick sampling. Unknown (unreadable) is not exact.
 */
export function idleClockExact(cmdline: string | null): boolean {
  return cmdline !== null && !/(^|\s)nohz=off(\s|$)/.test(cmdline);
}

/** Exact per-core busy between two samples of one sampler; null without both readings or a positive window. */
export function coreBusy(prev: HostSample | null, cur: HostSample): CoreBusy[] | null {
  if (prev === null || prev.cores === null || cur.cores === null) return null;
  if (prev.cpuClockMs === null || cur.cpuClockMs === null) return null;
  const window = ((cur.cpuClockMs - prev.cpuClockMs) * CLK_TCK) / 1000;
  if (!(window > 0)) return null;
  const before = new Map(prev.cores.map((c) => [c.id, c]));
  const out: CoreBusy[] = [];
  for (const c of cur.cores) {
    const p = before.get(c.id);
    if (p === undefined) continue;
    const quiet = Math.max(0, c.idle - p.idle) + Math.max(0, c.iowait - p.iowait);
    out.push({ id: c.id, busy: Math.max(0, window - quiet), window });
  }
  return out.length > 0 ? out : null;
}

/** The hottest core's exact busy, in percent of that core. */
export function hottestBusyPct(cores: readonly CoreBusy[] | null): number | null {
  return cores === null ? null : Math.max(...cores.map((c) => (c.busy / c.window) * 100));
}

/** All cores' exact busy, in percent of the host's capacity over the window. */
export function totalBusyPct(cores: readonly CoreBusy[] | null): number | null {
  if (cores === null) return null;
  const busy = cores.reduce((a, c) => a + c.busy, 0);
  return (busy / cores.reduce((a, c) => a + c.window, 0)) * 100;
}
