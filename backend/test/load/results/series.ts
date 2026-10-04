/**
 * P8.4 — pure statistics over a host's sample series, for the per-rung result.
 * Window metrics come from observe/derive.ts — the SAME derivation the watchdog
 * judged — so a result can never disagree with the rules that fired. Process
 * CPU is Δ(utime+stime) ÷ (CLK_TCK × wall s), cross-checked by derive's E4
 * sanity rule.
 */
import { deriveGenerator, deriveSut } from '../observe/derive';
import { type MetricId, type MetricValues } from '../observe/rules';
import { CLK_TCK, type HostSample } from '../observe/sample';

/**
 * The measured admission rate, per second, from the ramp's grant times: n
 * grants are n − 1 intervals, so (n − 1) ÷ (last − first). Null with fewer
 * than two grants or no elapsed time (a single admission has no rate).
 */
export function admissionRate(grantedAt: readonly number[]): number | null {
  if (grantedAt.length < 2) return null;
  const span = (Math.max(...grantedAt) - Math.min(...grantedAt)) / 1000;
  return span > 0 ? (grantedAt.length - 1) / span : null;
}

export function inWindow(
  samples: readonly HostSample[],
  from: number | null,
  to: number | null,
): HostSample[] {
  return samples.filter((s) => (from === null || s.t >= from) && (to === null || s.t <= to));
}

/** derive* metrics for each consecutive pair (index i uses samples[i-1] → samples[i]). */
export function windows(samples: readonly HostSample[], role: 'sut' | 'generator'): MetricValues[] {
  const out: MetricValues[] = [];
  const base = samples[0];
  if (!base) return out;
  let state = { lkNon200Consecutive: 0 };
  for (let i = 1; i < samples.length; i += 1) {
    const cur = samples[i];
    if (!cur) continue;
    const prev = samples[i - 1] ?? null;
    if (role === 'sut') {
      const r = deriveSut(base, prev, cur, state);
      state = r.state;
      out.push(r.metrics);
    } else {
      out.push(
        deriveGenerator(base, prev, cur, {
          linkMbps: cur.gen?.linkMbps ?? null,
          loopLagP95Ms: null,
        }).metrics,
      );
    }
  }
  return out;
}

const finite = (xs: ReadonlyArray<number | null | undefined>): number[] =>
  xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

export function maxOf(xs: ReadonlyArray<number | null | undefined>): number | null {
  const v = finite(xs);
  return v.length === 0 ? null : Math.max(...v);
}

export function minOf(xs: ReadonlyArray<number | null | undefined>): number | null {
  const v = finite(xs);
  return v.length === 0 ? null : Math.min(...v);
}

export function meanOf(xs: ReadonlyArray<number | null | undefined>): number | null {
  const v = finite(xs);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p * sorted.length) / 100) - 1))] ??
    null
  );
}

export function metric(ws: readonly MetricValues[], id: MetricId): Array<number | null> {
  return ws.map((w) => w[id] ?? null);
}

/** `read(last) − read(first)` over a series, or null. */
export function delta(
  samples: readonly HostSample[],
  read: (s: HostSample) => number | null | undefined,
): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  const a = read(first);
  const b = read(last);
  return typeof a === 'number' && typeof b === 'number' ? b - a : null;
}

/** Average cores used by processes matching `role` between the first and last sample. */
export function procCores(
  samples: readonly HostSample[],
  match: (role: string) => boolean,
): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || last.t <= first.t) return null;
  // Only processes present (same PID) at both ends: a failed read or a restart is unknown, not 0.
  const before = new Map(first.procs.filter((p) => match(p.role)).map((p) => [p.pid, p.cpuTicks]));
  let ticks = 0;
  let matched = 0;
  for (const p of last.procs) {
    const was = before.get(p.pid);
    if (!match(p.role) || was === undefined) continue;
    ticks += p.cpuTicks - was;
    matched += 1;
  }
  return matched === 0 ? null : ticks / CLK_TCK / ((last.t - first.t) / 1000);
}

export function procRssMax(
  samples: readonly HostSample[],
  match: (role: string) => boolean,
): number | null {
  return maxOf(
    samples.map((s) => s.procs.filter((p) => match(p.role)).reduce((n, p) => n + p.rssKb, 0)),
  );
}

export const udpErrors = (s: HostSample): number | null =>
  s.udp.v4 === null || s.udp.v6 === null ? null : s.udp.v4.inErrors + s.udp.v6.inErrors;
export const udpRcvbuf = (s: HostSample): number | null =>
  s.udp.v4 === null || s.udp.v6 === null ? null : s.udp.v4.rcvbufErrors + s.udp.v6.rcvbufErrors;
export const nicDropsErrs = (s: HostSample): number | null =>
  s.net === null ? null : s.net.rxDrop + s.net.txDrop + s.net.rxErr + s.net.txErr;

/** Per-socket drop deltas (`local` → delta) between the first and last sample. */
export function socketDropDeltas(samples: readonly HostSample[]): Record<string, number> {
  const first = samples[0]?.udpSockets ?? null;
  const last = samples[samples.length - 1]?.udpSockets ?? null;
  const out: Record<string, number> = {};
  // A socket's delta needs a reading at both ends; a lifetime counter is never a rung delta.
  if (first === null || last === null) return out;
  for (const s of last) {
    // A socket absent from a READABLE first sample was bound mid-rung: its drops all count.
    out[s.local] = s.drops - (first.find((f) => f.local === s.local)?.drops ?? 0);
  }
  return out;
}

/** Per-second rate of a counter between consecutive samples, × `scale` (e.g. 8/1e6 for Mbit/s). */
export function pairRate(
  samples: readonly HostSample[],
  read: (s: HostSample) => number | undefined,
  scale: number,
): Array<number | null> {
  const out: Array<number | null> = [];
  for (let k = 1; k < samples.length; k += 1) {
    const a = samples[k - 1];
    const b = samples[k];
    const va = a ? read(a) : undefined;
    const vb = b ? read(b) : undefined;
    out.push(
      a && b && va !== undefined && vb !== undefined && b.t > a.t
        ? ((vb - va) * scale) / ((b.t - a.t) / 1000)
        : null,
    );
  }
  return out;
}

/** Cores used by matching processes in each consecutive window. */
export function procCoresSeries(
  samples: readonly HostSample[],
  match: (role: string) => boolean,
): Array<number | null> {
  const out: Array<number | null> = [];
  for (let k = 1; k < samples.length; k += 1) {
    const a = samples[k - 1];
    const b = samples[k];
    out.push(a && b ? procCores([a, b], match) : null);
  }
  return out;
}
