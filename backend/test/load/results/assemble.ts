/**
 * P8.4 — assembles the per-rung result (`p84-rung-result/v1`, design §11) from
 * what the controller observed, and classifies it. Composition only: resource
 * sections are results/host-sections.ts, validity is results/validity.ts, the
 * verdict is results/verdict.ts. Pure given its input; every number comes from
 * observe/rules.ts through those modules.
 */
import { type HostSample } from '../observe/sample';
import { type AssembleInput } from './assemble-input';
import { generatorHosts, generatorSection, sutSections } from './host-sections';
import { RESULT_SCHEMA, type RungResult } from './schema';
import {
  admissionRate,
  delta,
  inWindow,
  maxOf,
  nicDropsErrs,
  percentile,
  udpErrors,
} from './series';
import { judged, validityOf } from './validity';
import { classify } from './verdict';

export { type AssembleInput } from './assemble-input';

const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());
const countBy = <T>(xs: readonly T[], key: (x: T) => string): Record<string, number> =>
  xs.reduce<Record<string, number>>((acc, x) => {
    const k = key(x);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

/** Any drop/error counter that rose in the second half of the hold ("acceptable YELLOW" input). */
function counterRoseInSecondHalf(i: AssembleInput): boolean {
  const { holdStart, holdEnd } = i.times;
  if (holdStart === null || holdEnd === null) return false;
  const second = inWindow(i.monitor.sutSamples, (holdStart + holdEnd) / 2, holdEnd);
  const reads = [
    udpErrors,
    nicDropsErrs,
    (s: HostSample) => s.softnet?.dropped ?? null,
    (s: HostSample) => s.qdisc?.dropped ?? null,
  ];
  return reads.some((read) => (delta(second, read) ?? 0) > 0);
}

function mediaAndTransport(
  i: AssembleInput,
): Pick<RungResult, 'media' | 'transport'> & { fleetLoss: number | null } {
  const { agg, times } = i;
  const n = i.req.rung.participants;
  const faults = agg.media.faults();
  const hold = agg.media
    .windows()
    .filter((w) => times.holdStart !== null && w.at >= times.holdStart);
  const recv = hold.reduce((s, w) => s + w.window.packetsReceived, 0);
  const lost = hold.reduce((s, w) => s + w.window.packetsLost, 0);
  const fleetLoss = recv + lost > 0 ? lost / (recv + lost) : null;
  const red = maxOf(hold.map((w) => w.window.lossBands.red)) ?? 0;
  const yellow = maxOf(hold.map((w) => w.window.lossBands.yellow)) ?? 0;
  const transports = [...agg.media.transports().values()];
  const sut = i.monitor.sutSamples;
  const gens = [...i.monitor.genSamples.values()].flat();
  return {
    fleetLoss,
    media: {
      stalls: faults.filter((f) => f.fault === 'stall').length,
      disconnects: countBy(
        faults.filter((f) => f.fault === 'disconnected'),
        (f) => f.reason ?? 'UNKNOWN',
      ),
      reconnects: faults.filter((f) => f.fault === 'reconnected').length,
      unsubscribes: faults.filter((f) => f.fault === 'unsubscribed').length,
      packetLoss: {
        fleet: fleetLoss,
        listenersByBand: { green: Math.max(0, n - 1 - red - yellow), yellow, red },
      },
      jitterMsMax: maxOf(hold.map((w) => w.window.jitterMsMax)),
      trackNotBound: i.post.log?.trackNotBound ?? null,
      contentProbe: {
        probes: agg.media.probes().length,
        ok: agg.media.probes().filter((p) => p.ok).length,
      },
    },
    transport: {
      selectedPairs: countBy(
        transports,
        (r) => `${r.protocol}/${r.localType}->${r.remoteType}:${r.remotePort ?? '-'}`,
      ),
      relayCandidates: transports.filter((r) => r.localCandidateTypes.includes('relay')).length,
      relaySocketsMax: maxOf(sut.map((s) => s.sut?.relaySockets)),
      fwNewFlows3478Delta: delta(sut, (s) => s.sut?.fwNewFlows?.udp3478),
      generatorFlowsTo3478Max: maxOf(gens.map((s) => s.gen?.flowsToSut3478)),
      turnTlsEstabMax: maxOf(sut.map((s) => s.sut?.turnTlsEstab)),
      turnQuotaEvents: i.post.log?.turnQuota ?? null,
    },
  };
}

export function assembleResult(i: AssembleInput): RungResult {
  const { agg, monitor, times, req } = i;
  const n = req.rung.participants;
  const hosts = generatorHosts(i);
  const { fleetLoss, media, transport } = mediaAndTransport(i);
  const hostSections = sutSections(i, fleetLoss);
  const validity = validityOf(i, monitor.sutSamples, [...monitor.genSamples.values()].flat());
  const rampSeconds =
    times.rampStart !== null && times.rampEnd !== null
      ? (times.rampEnd - times.rampStart) / 1000
      : null;
  const connect = [...i.connectMs];
  const counted = judged(i);
  const result: Omit<RungResult, 'verdict'> = {
    schema: RESULT_SCHEMA,
    meta: {
      runId: req.runId,
      rung: req.rung.id,
      requested: n,
      startedAt: iso(times.startedAt) ?? '',
      endedAt: iso(times.endedAt) ?? '',
      harnessCommit: i.commit,
      bundleSha256: i.hellos.map((h) => h.bundleSha256),
      calibration: req.calibration ? { density: req.density } : null,
    },
    profile: {
      rooms: 1,
      publishers: 1,
      media: 'audio/red 440 Hz tone, dtx off',
      path: 'A',
      iceMode: req.ice,
      listenersHidden: false,
      generatorHosts: hosts.map((h) => h.host),
      density: req.density,
    },
    timing: {
      rampDuration: rampSeconds,
      rampRate: { target: req.rampPerSecond, actual: admissionRate(i.listenerGrantedAt) },
      connectionDuration: {
        p50: percentile(connect, 50),
        p95: percentile(connect, 95),
        max: maxOf(connect),
      },
      gateAt: iso(times.gateAt),
      holdSeconds: {
        planned: req.rung.holdSeconds,
        actual:
          times.holdStart !== null && times.holdEnd !== null
            ? (times.holdEnd - times.holdStart) / 1000
            : 0,
      },
    },
    gate: {
      connected: agg.connected(),
      failed: agg.failed(),
      crashes: agg.crashes(),
      publisherPublished: agg.publishersReady(),
      // Phase B starts only after the SFU confirmed the publisher's track (design §5).
      publisherServerConfirmed: times.rampStart !== null,
      subscribed: agg.media.subscribed(),
      receiving: agg.media.receiving(),
      serverIdentitySetMatch: { atGate: i.server.atGate, atHoldEnd: i.server.atHoldEnd },
      gateMet: times.gateAt !== null,
    },
    media,
    transport,
    generator: generatorSection(i, hosts),
    ...hostSections,
    watchdog: {
      safetyAbort: i.abort,
      firedRules: monitor.fired.map((f) => f.ruleId),
      yellowRules: unique(counted.map((o) => o.ruleId)),
      missingMetrics: [...monitor.missing],
    },
    validity,
    cleanup: {
      teardown: agg.teardownSummary(i.workerIds),
      cleanupRooms: i.cleanup.cleanupRooms,
      cleanupParticipants: i.cleanup.cleanupParticipants,
      cleanupRows: i.cleanup.cleanupRows,
      generatorProcesses: i.cleanup.generatorProcesses,
      relaySockets: i.cleanup.relaySockets,
      hostRecovered: i.cleanup.hostRecovered,
      verified: i.cleanup.verified,
    },
    evidence: [],
  };
  const sutOrMedia = counted.filter((o) => o.scope !== 'generator');
  const verdict = classify(
    {
      validity,
      fired: [
        ...monitor.fired.map((f) => ({ ruleId: f.ruleId, at: f.at })),
        // M-unbound is judged post-rung from the LiveKit log (errata E3).
        ...((i.post.log?.trackNotBound ?? 0) > 0
          ? [{ ruleId: 'M-unbound', at: times.endedAt }]
          : []),
      ],
      yellow: unique(sutOrMedia.map((o) => o.ruleId)),
      overRedNotSustained: unique(sutOrMedia.filter((o) => o.overRed).map((o) => o.ruleId)),
      gateMet: times.gateAt !== null,
      holdCompleted: i.holdCompleted,
      gateFailure: i.gateFailure,
      cleanupVerified: i.cleanup.verified,
      hostRecovered: i.cleanup.hostRecovered.conntrack,
      safetyAbort: i.abort,
      acceptable: {
        holdSeconds: req.rung.holdSeconds,
        counterIncrementsInSecondHalf: counterRoseInSecondHalf(i),
        gaugesWithinNoise: null,
      },
    },
    (hostSections.livekit.restarts ?? 0) > 0,
  );
  return { ...result, verdict };
}
