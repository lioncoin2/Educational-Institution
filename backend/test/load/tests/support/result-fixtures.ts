/**
 * Fixtures for the results/ specs: host samples built from the observe/sample
 * contract, and a minimal valid RungResult.
 */
import {
  type CoreTicks,
  type HostSample,
  type NetCounters,
  type ProcCounters,
  SAMPLE_SCHEMA,
  type SutSection,
  type UdpCounters,
} from '../../observe/sample';
import { RESULT_SCHEMA, type RungResult } from '../../results/schema';

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

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

export const udp = (inErrors: number, rcvbufErrors = 0): UdpCounters => ({
  inDatagrams: 0,
  outDatagrams: 0,
  inErrors,
  rcvbufErrors,
  sndbufErrors: 0,
});

export const net = (counters: Partial<NetCounters> = {}): NetCounters => ({
  iface: 'eth0',
  rxBytes: 0,
  txBytes: 0,
  rxPackets: 0,
  txPackets: 0,
  rxDrop: 0,
  txDrop: 0,
  rxErr: 0,
  txErr: 0,
  ...counters,
});

export const proc = (pid: number, role: string, cpuTicks: number, rssKb = 0): ProcCounters => ({
  pid,
  role,
  cpuTicks,
  rssKb,
  fds: 10,
  threads: 1,
});

export const sutSection = (s: Partial<SutSection> = {}): SutSection => ({
  relaySockets: 0,
  turnTlsEstab: 0,
  fwNewFlows: { udp3478: 0, udp7882: 0 },
  containers: [{ name: 'institution-livekit-1', restarts: 0, health: 'healthy' }],
  livekitHttp: 200,
  nginx: { workerConnections: 768, workerFds: [40], errorWorkerConnections: 0, errorUpstream: 0 },
  ...s,
});

/** A complete SUT sample; tests override only what they exercise. */
export const sample = (s: Partial<HostSample> = {}): HostSample => ({
  schema: SAMPLE_SCHEMA,
  runId: 'run-p84',
  rung: 'S2',
  host: 'sut',
  role: 'sut',
  t: 0,
  seq: 0,
  clockOffsetMs: null,
  cores: [core(0, { idle: 1_000 }), core(1, { idle: 1_000 })],
  cpuClockMs: 0,
  load1: 1,
  mem: { totalKb: 64 * 1024 * 1024, availableKb: 32 * 1024 * 1024, swapUsedKb: 0 },
  oomKills: 0,
  net: net(),
  qdisc: { dropped: 0, overlimits: 0 },
  udp: { v4: udp(0), v6: udp(0) },
  softnet: { dropped: 0, timeSqueeze: 0 },
  conntrack: { count: 100, max: 262_144 },
  udpSockets: [
    { local: '213.136.65.135:7882', port: 7882, drops: 0 },
    { local: '*:3478', port: 3478, drops: 0 },
  ],
  procs: [],
  sut: sutSection(),
  gen: null,
  ...s,
});

export const genSample = (
  s: Partial<HostSample> = {},
  linkMbps: number | null = 1000,
): HostSample =>
  sample({
    host: 'gen-1',
    role: 'generator',
    clockOffsetMs: 1,
    sut: null,
    udpSockets: [],
    gen: {
      participants: 10,
      flowsToSut3478: 0,
      tcpToSut443: 10,
      linkMbps,
      processGroup: { members: 3, workers: 2, helpers: 0, unexplained: 0 },
    },
    ...s,
  });

// ---------------------------------------------------------------------------
// A minimal valid RungResult (results/schema.ts): nulls where a value is unknown
// ---------------------------------------------------------------------------

export const result = (): RungResult => ({
  schema: RESULT_SCHEMA,
  meta: {
    runId: 'run-p84',
    rung: 'S2',
    requested: 20,
    startedAt: '2026-10-04T10:00:00.000Z',
    endedAt: '2026-10-04T10:02:00.000Z',
    harnessCommit: '0caba62',
    bundleSha256: [null],
    calibration: null,
  },
  profile: {
    rooms: 1,
    publishers: 1,
    media: 'audio/red 440 Hz tone, dtx off',
    path: 'A',
    iceMode: 'turn-free',
    listenersHidden: false,
    generatorHosts: ['gen-1'],
    density: 10,
  },
  timing: {
    rampDuration: null,
    rampRate: { target: 10, actual: null },
    connectionDuration: { p50: null, p95: null, max: null },
    gateAt: null,
    holdSeconds: { planned: 30, actual: 0 },
  },
  gate: {
    connected: 0,
    failed: 0,
    crashes: 0,
    publisherPublished: false,
    publisherServerConfirmed: false,
    subscribed: 0,
    receiving: 0,
    serverIdentitySetMatch: { atGate: null, atHoldEnd: null },
    gateMet: false,
  },
  media: {
    stalls: 0,
    disconnects: {},
    reconnects: 0,
    unsubscribes: 0,
    packetLoss: { fleet: null, listenersByBand: { green: 0, yellow: 0, red: 0 } },
    jitterMsMax: null,
    trackNotBound: null,
    contentProbe: { probes: 0, ok: 0 },
  },
  transport: {
    selectedPairs: {},
    relayCandidates: 0,
    relaySocketsMax: null,
    fwNewFlows3478Delta: null,
    generatorFlowsTo3478Max: null,
    turnTlsEstabMax: null,
    turnQuotaEvents: null,
  },
  generator: {
    generatorCount: 0,
    hosts: [],
    generatorCPU: { avgCores: null, maxCores: null },
    generatorRSS: { maxKb: null },
    generatorNetwork: { rxMbpsMax: null, txMbpsMax: null },
    perParticipant: { cpuCores: null, rssKb: null },
  },
  sut: {
    sutCPU: { totalAvgPct: null, hottestCoreMaxPct: null, hottestCoreSysSoftTickMaxPct: null },
    sutRSS: { usedKbMax: null },
    memAvailableMinKb: null,
    swapUsedKbMax: null,
    oomKills: null,
    loadAvgMax: null,
    harnessOverhead: { cpuCoresAvg: null, rssKbMax: null },
  },
  network: {
    sutNetwork: { rxMbpsMax: null, txMbpsMax: null, txPpsMax: null },
    udpErrors: null,
    udpRcvbufErrors: null,
    perSocketDrops: {},
    softnetDrops: null,
    qdiscDrops: null,
    nicDropsErrs: null,
    conntrack: { max: null, perParticipant: null },
    packetLoss: null,
  },
  livekit: {
    cpu: { avgPct: null, maxPct: null },
    rssKb: { max: null },
    fds: { max: null },
    participants: { atGate: null, atHoldEnd: null },
    reconnects: 0,
    connectionFailures: 0,
    errorLines: null,
    restarts: null,
  },
  nginx: {
    workerConnections: null,
    busiestWorkerFdsMax: null,
    baselineWorkerFdsMax: null,
    perWorkerFdsAtGate: [],
    errorLines: { workerConnections: null, upstream: null },
  },
  docker: { containers: [], containerRestarts: null },
  watchdog: { safetyAbort: null, firedRules: [], yellowRules: [], missingMetrics: [] },
  validity: {
    'V-turn': { ok: true, detail: 'ok' },
    'V-gen': { ok: true, detail: 'ok' },
    'V-sampler': { ok: true, detail: 'ok' },
    'V-clock': { ok: true, detail: 'max 1 ms' },
    'V-dup': { ok: true, detail: 'faults 0, log 0' },
    'V-ticket': { ok: true, detail: 'access_token lines from generators: 0' },
    'V-ramp': { ok: true, detail: 'ok' },
  },
  cleanup: {
    teardown: { workers: 0, cleaned: 0, timedOut: 0, exitedUnclean: 0, forced: 0 },
    cleanupRooms: 0,
    cleanupParticipants: 0,
    cleanupRows: 0,
    generatorProcesses: { 'gen-1': 0 },
    relaySockets: 0,
    hostRecovered: { conntrack: null, cpu: null },
    verified: true,
  },
  verdict: {
    class: 'UNKNOWN',
    pass: false,
    acceptableYellow: null,
    failureClass: null,
    contributing: [],
    reasons: [],
  },
  evidence: [],
});

/** A deep copy of `r` with the dotted `path` deleted. */
export function without(r: unknown, path: string): unknown {
  const copy = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
  const keys = path.split('.');
  const last = keys.pop()!;
  let at = copy;
  for (const k of keys) at = at[k] as Record<string, unknown>;
  delete at[last];
  return copy;
}
