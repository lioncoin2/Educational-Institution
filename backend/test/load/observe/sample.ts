/**
 * P8.4 — the time-series sample (`p84-sample/v1`) and abort-reason
 * (`p84-abort/v1`) contracts. Samples carry RAW counters only; every delta,
 * rate and percentage is derived by the pure observe/derive.ts, so no logic
 * hides in a sampler. A reader that fails yields `null` (fail closed: a missing
 * source is a sampler-validity failure, never a silent zero).
 */

/** Linux USER_HZ: /proc/<pid>/stat and /proc/stat times are in these ticks. */
export const CLK_TCK = 100;

export const SAMPLE_SCHEMA = 'p84-sample/v1';
export const ABORT_SCHEMA = 'p84-abort/v1';

/** Cumulative per-core jiffies from /proc/stat. */
export interface CoreTicks {
  readonly id: number;
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly iowait: number;
  readonly irq: number;
  readonly soft: number;
  readonly steal: number;
}

export interface UdpCounters {
  readonly inDatagrams: number;
  readonly outDatagrams: number;
  /** Includes RcvbufErrors (the kernel increments both); RcvbufErrors is a breakdown. */
  readonly inErrors: number;
  readonly rcvbufErrors: number;
  readonly sndbufErrors: number;
}

export interface NetCounters {
  readonly iface: string;
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly rxPackets: number;
  readonly txPackets: number;
  readonly rxDrop: number;
  readonly txDrop: number;
  readonly rxErr: number;
  readonly txErr: number;
}

export interface UdpSocketDrops {
  /** As `ss` prints it, e.g. `213.136.65.135:7882` or `*:3478`. */
  readonly local: string;
  readonly port: number;
  readonly drops: number;
}

/** A process the sampler watches, identified by PID (never by name pattern). */
export interface ProcCounters {
  readonly pid: number;
  /** e.g. `livekit`, `controller`, `agent`, `worker:12`, `nginx-worker`. */
  readonly role: string;
  /** utime + stime, in clock ticks (CLK_TCK). */
  readonly cpuTicks: number;
  readonly rssKb: number;
  readonly fds: number | null;
  readonly threads: number | null;
}

export interface SutSection {
  /** UDP sockets bound in the TURN relay range 30000–32767 (udp + udp6). */
  readonly relaySockets: number | null;
  /** ESTABLISHED TCP on 127.0.0.1:8444 / :5349 (the TURN/TLS hops). */
  readonly turnTlsEstab: number | null;
  /** ufw user-input packet counters (new flows) for udp dpt 3478 / 7882, v4 + v6. */
  readonly fwNewFlows: { readonly udp3478: number; readonly udp7882: number } | null;
  readonly containers: ReadonlyArray<{
    readonly name: string;
    readonly restarts: number;
    readonly health: string;
  }> | null;
  /** HTTP status of GET http://127.0.0.1:7880/ (null = no answer). */
  readonly livekitHttp: number | null;
  readonly nginx: {
    readonly workerConnections: number;
    readonly workerFds: readonly number[];
    /** Cumulative counts of matching error-log lines since the rung baseline. */
    readonly errorWorkerConnections: number;
    readonly errorUpstream: number;
  } | null;
}

export interface GeneratorSection {
  /** Live participants hosted on this generator. */
  readonly participants: number;
  /** Egress flows from this host to SUT:3478 (generator-side TURN attribution, T6). */
  readonly flowsToSut3478: number | null;
  /** TCP connections from this host to SUT:443 (T7: must equal live participants). */
  readonly tcpToSut443: number | null;
  /** Provisioned NIC speed (Mbit/s), for the G-nic share; null if unknown. */
  readonly linkMbps: number | null;
  /**
   * The agent's process group, classified by OWNERSHIP (never by name): the
   * agent and its workers; helpers = children of a worker (library-owned, e.g.
   * rtc-node's `lsb_release`); unexplained = anything else in the group.
   */
  readonly processGroup: {
    readonly members: number;
    readonly workers: number;
    readonly helpers: number;
    readonly unexplained: number;
  } | null;
}

export interface HostSample {
  readonly schema: typeof SAMPLE_SCHEMA;
  readonly runId: string;
  readonly rung: string;
  readonly host: string;
  readonly role: 'sut' | 'generator';
  readonly t: number;
  readonly seq: number;
  readonly clockOffsetMs: number | null;
  readonly cores: readonly CoreTicks[] | null;
  /**
   * The sampler's monotonic clock (ms) at the /proc/stat read behind `cores`: the window of the
   * exact CPU meter (observe/cpu-meter.ts, D-12). Null when `cores` is, or when the kernel's idle
   * clock is not exact (`nohz=off`).
   */
  readonly cpuClockMs: number | null;
  readonly load1: number | null;
  readonly mem: {
    readonly totalKb: number;
    readonly availableKb: number;
    readonly swapUsedKb: number;
  } | null;
  readonly oomKills: number | null;
  readonly net: NetCounters | null;
  readonly qdisc: { readonly dropped: number; readonly overlimits: number } | null;
  readonly udp: { readonly v4: UdpCounters | null; readonly v6: UdpCounters | null };
  readonly softnet: { readonly dropped: number; readonly timeSqueeze: number } | null;
  readonly conntrack: { readonly count: number; readonly max: number } | null;
  readonly udpSockets: readonly UdpSocketDrops[] | null;
  readonly procs: readonly ProcCounters[];
  readonly sut: SutSection | null;
  readonly gen: GeneratorSection | null;
}

/** Failure classes (design §13). */
export type FailureClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface AbortReason {
  readonly schema: typeof ABORT_SCHEMA;
  readonly runId: string;
  readonly rung: string;
  readonly at: number;
  /** `sut-watchdog`, `gen-watchdog:<host>`, `controller`, `operator`. */
  readonly source: string;
  /** Rule id from the verdict table (observe/rules.ts), or a controller cause. */
  readonly rule: string;
  readonly observed: {
    readonly value: number | string;
    readonly unit: string;
    readonly samples: readonly number[];
  };
  readonly threshold: {
    readonly op: '>' | '<' | '!=';
    readonly value: number | string;
    readonly sustain: string;
  } | null;
  readonly classHint: FailureClass | null;
  /** True when the cause is a validity (V-*) failure: the verdict becomes UNKNOWN. */
  readonly validity: boolean;
  readonly detail: string;
}
