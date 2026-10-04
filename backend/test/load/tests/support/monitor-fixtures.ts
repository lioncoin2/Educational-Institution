/**
 * Fixtures for the RunMonitor specs: host samples of an idle, complete host whose
 * counters grow with the sample index, and a monitor that records its aborts.
 */
import { RunMonitor, type SutPort } from '../../fleet/monitor';
import {
  type AbortReason,
  type CoreTicks,
  type HostSample,
  SAMPLE_SCHEMA,
  type SutSection,
  type UdpCounters,
} from '../../observe/sample';

export const RUN = '0123456789abcdef';
export const RUNG = 'S2';
export const PUBLISHER = 'p84-01234567-P0';
export const HOLD = 100_000;
export const INTERVAL = 5_000;

export const core = (id: number, ticks: Partial<CoreTicks> = {}): CoreTicks => ({
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

export const udp = (): UdpCounters => ({
  inDatagrams: 0,
  outDatagrams: 0,
  inErrors: 0,
  rcvbufErrors: 0,
  sndbufErrors: 0,
});

/** The i-th sample (t = 5 s · i) of an idle, complete host; counters grow with i. */
function hostSample(i: number, s: Partial<HostSample> = {}): HostSample {
  return {
    schema: SAMPLE_SCHEMA,
    runId: RUN,
    rung: RUNG,
    host: 'sut',
    role: 'sut',
    t: i * INTERVAL,
    seq: i,
    clockOffsetMs: null,
    // Each 5 s window holds 500 ticks per core: 490 idle + 10 busy (2 %), exactly.
    cores: [core(0, { user: 10 * i, idle: 490 * i }), core(1, { user: 10 * i, idle: 490 * i })],
    cpuClockMs: i * INTERVAL,
    load1: 0.5,
    mem: { totalKb: 64 * 1024 * 1024, availableKb: 48 * 1024 * 1024, swapUsedKb: 0 },
    oomKills: 0,
    net: {
      iface: 'eth0',
      rxBytes: 1_000_000 * i,
      txBytes: 1_000_000 * i,
      rxPackets: 1_000 * i,
      txPackets: 1_000 * i,
      rxDrop: 0,
      txDrop: 0,
      rxErr: 0,
      txErr: 0,
    },
    qdisc: { dropped: 0, overlimits: 0 },
    udp: { v4: udp(), v6: udp() },
    softnet: { dropped: 0, timeSqueeze: 0 },
    conntrack: { count: 1_000, max: 262_144 },
    udpSockets: null,
    procs: [],
    sut: null,
    gen: null,
    ...s,
  };
}

const sutSection = (s: Partial<SutSection> = {}): SutSection => ({
  relaySockets: 0,
  turnTlsEstab: 0,
  fwNewFlows: { udp3478: 0, udp7882: 0 },
  containers: [{ name: 'institution-livekit-1', restarts: 0, health: 'healthy' }],
  livekitHttp: 200,
  nginx: {
    workerConnections: 768,
    workerFds: [40, 42],
    errorWorkerConnections: 0,
    errorUpstream: 0,
  },
  ...s,
});

/** A quiet, complete SUT sample (every SUT rule metric present and GREEN). */
export const sutSample = (i: number, s: Partial<HostSample> = {}, sut: Partial<SutSection> = {}) =>
  hostSample(i, {
    udpSockets: [
      ...[0, 1, 2, 3].map((n) => ({ local: `10.0.0.${n}:7882`, port: 7882, drops: 0 })),
      { local: '*:3478', port: 3478, drops: 0 },
    ],
    sut: sutSection(sut),
    ...s,
  });

/** A quiet, complete generator sample (every generator rule metric present and GREEN). */
export const genSample = (i: number, s: Partial<HostSample> = {}) =>
  hostSample(i, {
    host: 'gen-1',
    role: 'generator',
    clockOffsetMs: 1,
    gen: {
      participants: 10,
      flowsToSut3478: 0,
      tcpToSut443: 10,
      linkMbps: 1_000,
      processGroup: { members: 3, workers: 2, helpers: 0, unexplained: 0 },
    },
    ...s,
  });

export const monitorWith = (
  sut: SutPort | null,
  intervalMs = INTERVAL,
): { monitor: RunMonitor; aborts: AbortReason[] } => {
  const aborts: AbortReason[] = [];
  const monitor = new RunMonitor({ runId: RUN, rung: RUNG, intervalMs }, sut, (r) => {
    aborts.push(r);
  });
  return { monitor, aborts };
};
