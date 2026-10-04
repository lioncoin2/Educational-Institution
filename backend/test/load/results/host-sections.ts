/**
 * P8.4 — the result's resource sections (design §11), kept APART so generator
 * cost is never read as SUT cost: `generator` (per host and fleet), `sut`,
 * `network`, `livekit`, `nginx` and `docker`. Every window metric comes from the
 * same derivation the watchdog judged (results/series.ts → observe/derive.ts).
 */
import { type HostSample } from '../observe/sample';
import { type AssembleInput } from './assemble-input';
import { type GeneratorHostResult, type RungResult } from './schema';
import {
  delta,
  inWindow,
  maxOf,
  meanOf,
  metric,
  minOf,
  nicDropsErrs,
  pairRate,
  procCores,
  procCoresSeries,
  procRssMax,
  socketDropDeltas,
  udpErrors,
  udpRcvbuf,
  windows,
} from './series';

const absOffset = (s: HostSample): number | null =>
  s.clockOffsetMs === null ? null : Math.abs(s.clockOffsetMs);
const pct = (v: number | null): number | null => (v === null ? null : v * 100);

export function generatorHosts(i: AssembleInput): GeneratorHostResult[] {
  return i.hellos.map((h) => {
    const all = i.monitor.genSamples.get(h.index) ?? [];
    const hold = inWindow(all, i.times.holdStart, i.times.holdEnd);
    const ws = windows(hold.length > 1 ? hold : all, 'generator');
    const own = i.agg.media.windows().filter((w) => i.agentIndexOfWorker(w.workerId) === h.index);
    return {
      host: h.host.hostname,
      vcpu: h.host.vcpu,
      ramGiB: Math.round((h.host.memTotalKb / 1024 / 1024) * 10) / 10,
      cpu: {
        avgPct: meanOf(metric(ws, 'gCpuTotalPct')),
        maxPct: maxOf(metric(ws, 'gCpuTotalPct')),
        hottestCoreMaxPct: maxOf(metric(ws, 'gCpuHotPct')),
      },
      rssKb: {
        sumMax: procRssMax(all, () => true),
        perWorkerMax: maxOf(
          all.flatMap((s) =>
            s.procs.filter((p) => p.role.startsWith('worker')).map((p) => p.rssKb),
          ),
        ),
      },
      network: {
        rxMbpsMax: maxOf(pairRate(all, (s) => s.net?.rxBytes, 8 / 1e6)),
        txMbpsMax: maxOf(pairRate(all, (s) => s.net?.txBytes, 8 / 1e6)),
        rxPpsMax: maxOf(pairRate(all, (s) => s.net?.rxPackets, 1)),
      },
      loopLagP95Ms: maxOf(own.map((w) => w.window.loopLagMsP95)),
      workers: new Set(own.map((w) => w.workerId)).size,
      crashes: i.agg.crashedWorkers().filter((id) => i.agentIndexOfWorker(id) === h.index).length,
      clockOffsetMsMax: maxOf(all.map(absOffset)),
    };
  });
}

export function generatorSection(
  i: AssembleInput,
  hosts: readonly GeneratorHostResult[],
): RungResult['generator'] {
  const n = i.req.rung.participants;
  const known = <T>(xs: ReadonlyArray<T | null>): xs is T[] => xs.every((x) => x !== null);
  const avgCores = hosts.map((h) => (h.cpu.avgPct === null ? null : (h.cpu.avgPct / 100) * h.vcpu));
  const maxCores = hosts.map((h) => (h.cpu.maxPct === null ? null : (h.cpu.maxPct / 100) * h.vcpu));
  const rss = hosts.map((h) => h.rssKb.sumMax);
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  const cpu = known(avgCores) ? sum(avgCores) : null;
  const rssKb = known(rss) ? sum(rss) : null;
  return {
    generatorCount: hosts.length,
    hosts,
    generatorCPU: { avgCores: cpu, maxCores: known(maxCores) ? sum(maxCores) : null },
    generatorRSS: { maxKb: rssKb },
    generatorNetwork: {
      rxMbpsMax: maxOf(hosts.map((h) => h.network.rxMbpsMax)),
      txMbpsMax: maxOf(hosts.map((h) => h.network.txMbpsMax)),
    },
    perParticipant: {
      cpuCores: cpu === null ? null : cpu / n,
      rssKb: rssKb === null ? null : rssKb / n,
    },
  };
}

export function sutSections(
  i: AssembleInput,
  fleetLoss: number | null,
): Pick<RungResult, 'sut' | 'network' | 'livekit' | 'nginx' | 'docker'> {
  const n = i.req.rung.participants;
  const all = i.monitor.sutSamples;
  const hold = inWindow(all, i.times.holdStart, i.times.holdEnd);
  const span = hold.length > 1 ? hold : all;
  const ws = windows(span, 'sut');
  const last = all[all.length - 1];
  const gateAt = i.times.gateAt;
  const atGate =
    gateAt === null
      ? null
      : all.reduce<HostSample | null>(
          (b, s) => (!b || Math.abs(s.t - gateAt) < Math.abs(b.t - gateAt) ? s : b),
          null,
        );
  const faults = i.agg.media.faults();
  const isLivekit = (r: string): boolean => r === 'livekit';
  const baseCt = all[0]?.conntrack?.count;
  const peakCt = maxOf(hold.map((s) => s.conntrack?.count));
  return {
    sut: {
      sutCPU: {
        totalAvgPct: meanOf(metric(ws, 'cpuTotalBusyPct')),
        hottestCoreMaxPct: maxOf(metric(ws, 'cpuHotBusyPct')),
        hottestCoreSysSoftTickMaxPct: maxOf(metric(ws, 'cpuHotSysSoftTickPct')),
      },
      sutRSS: {
        usedKbMax: maxOf(all.map((s) => (s.mem ? s.mem.totalKb - s.mem.availableKb : null))),
      },
      memAvailableMinKb: minOf(all.map((s) => s.mem?.availableKb)),
      swapUsedKbMax: maxOf(all.map((s) => s.mem?.swapUsedKb)),
      oomKills: delta(all, (s) => s.oomKills),
      loadAvgMax: maxOf(all.map((s) => s.load1)),
      harnessOverhead: {
        cpuCoresAvg: procCores(all, (r) => r === 'controller'),
        rssKbMax: procRssMax(all, (r) => r === 'controller'),
      },
    },
    network: {
      sutNetwork: {
        rxMbpsMax: maxOf(pairRate(all, (s) => s.net?.rxBytes, 8 / 1e6)),
        txMbpsMax: maxOf(metric(windows(all, 'sut'), 'txMbps')),
        txPpsMax: maxOf(pairRate(all, (s) => s.net?.txPackets, 1)),
      },
      udpErrors: delta(all, udpErrors),
      udpRcvbufErrors: delta(all, udpRcvbuf),
      perSocketDrops: socketDropDeltas(all),
      softnetDrops: delta(all, (s) => s.softnet?.dropped),
      qdiscDrops: delta(all, (s) => s.qdisc?.dropped),
      nicDropsErrs: delta(all, nicDropsErrs),
      conntrack: {
        max: maxOf(all.map((s) => s.conntrack?.count)),
        perParticipant: baseCt === undefined || peakCt === null ? null : (peakCt - baseCt) / n,
      },
      packetLoss: fleetLoss,
    },
    livekit: {
      cpu: {
        avgPct: pct(procCores(span, isLivekit)),
        maxPct: pct(maxOf(procCoresSeries(span, isLivekit))),
      },
      rssKb: { max: procRssMax(all, isLivekit) },
      fds: {
        max: maxOf(all.flatMap((s) => s.procs.filter((p) => isLivekit(p.role)).map((p) => p.fds))),
      },
      participants: { atGate: i.server.countAtGate, atHoldEnd: i.server.countAtHoldEnd },
      reconnects: faults.filter((f) => f.fault === 'reconnected').length,
      connectionFailures: i.agg.failed(),
      errorLines: i.post.log?.errorLines ?? null,
      restarts: delta(
        all,
        (s) => s.sut?.containers?.find((c) => c.name.includes('livekit'))?.restarts,
      ),
    },
    nginx: {
      workerConnections: last?.sut?.nginx?.workerConnections ?? null,
      busiestWorkerFdsMax: maxOf(all.map((s) => maxOf([...(s.sut?.nginx?.workerFds ?? [])]))),
      baselineWorkerFdsMax: maxOf([...(all[0]?.sut?.nginx?.workerFds ?? [])]),
      perWorkerFdsAtGate: [...(atGate?.sut?.nginx?.workerFds ?? [])],
      errorLines: {
        workerConnections: last?.sut?.nginx?.errorWorkerConnections ?? null,
        upstream: last?.sut?.nginx?.errorUpstream ?? null,
      },
    },
    docker: {
      containers: [...(last?.sut?.containers ?? [])],
      containerRestarts: delta(all, (s) => s.sut?.containers?.reduce((a, c) => a + c.restarts, 0)),
    },
  };
}
