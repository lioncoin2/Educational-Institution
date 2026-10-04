/**
 * P8.4 — the fleet CONTROLLER (design §1, §5–§7, §12). Runs on the SUT (the
 * credential authority) and generates no media. It alone owns the runId, the
 * rung, the room, the publisher, the global ramp, the global exact-N and media
 * gate, the global abort, result aggregation and cleanup. One rung per call:
 *
 *   prepare → A (publisher) → B (listener ramp) → gate → hold → teardown → verify → result
 *
 * Every phase can abort; every abort ends in the same teardown and verification.
 * Run state and agent-message handling live in fleet/run-context.ts.
 */
import { type HostSample } from '../observe/sample';
import { assembleResult } from '../results/assemble';
import { cleanupRun } from './cleanup';
import { clientGateProblems, transportGateProblems } from './gates';
import { mediaMetrics } from './monitor';
import { type WorkerSpec } from './protocol';
import { RunContext } from './run-context';
import {
  type ControllerDeps,
  type ControllerTiming,
  DEFAULT_TIMING,
  type RungOutcome,
  type RungRequest,
} from './rung-config';
import { runTag } from './shards';

export {
  type ControllerDeps,
  type ControllerTiming,
  DEFAULT_TIMING,
  type PostRungEvidence,
  type RungOutcome,
  type RungRequest,
} from './rung-config';

/** Publisher reports where packets sent rose in each of the last `windows` reports. */
function publisherFlowing(sent: ReadonlyArray<{ packetsSent: number }>, windows: number): boolean {
  if (sent.length < windows + 1) return false;
  const tail = sent.slice(-(windows + 1));
  return tail.every((s, i) => i === 0 || s.packetsSent > (tail[i - 1]?.packetsSent ?? Infinity));
}

/** Room, agents (hello + commit check), worker assignment, heartbeats, SUT baseline. */
async function prepare(c: RunContext): Promise<void> {
  const { req, deps, timing, plan } = c;
  await deps.rooms.assertAbsent(c.room);
  await deps.rooms.create(c.room, c.n);
  c.session.start(deps.endpoints, req.runId, deps.parentEnv);
  c.hellos = await c.session.hellos(timing.helloTimeoutMs, deps.commit);
  deps.endpoints.forEach((_e, a) => {
    const workers: WorkerSpec[] = plan.listeners
      .filter((s) => s.agentIndex === a)
      .map((s, i) => ({
        workerId: s.workerId,
        kind: 'listeners',
        capacity: s.end - s.start,
        probe: i === 0,
      }));
    if (a === plan.publisher.agentIndex)
      workers.unshift({
        workerId: plan.publisher.workerId,
        kind: 'publisher',
        capacity: 1,
        probe: false,
      });
    c.session.assign(a, req.runId, req.rung.id, workers, {
      ice: { mode: req.ice },
      teardownTimeoutMs: timing.teardownTimeoutMs,
      shutdownGraceMs: timing.shutdownGraceMs,
      statsIntervalMs: timing.statsIntervalMs,
      sampleIntervalMs: timing.sampleIntervalMs,
      heartbeatMs: timing.heartbeatMs,
      deadManMs: timing.deadManMs,
      publishRetries: timing.publishRetries,
      sutAddress: req.sutAddress,
    });
  });
  await c.session.readies(timing.readyTimeoutMs);
  c.session.startHeartbeats(timing.heartbeatMs, timing.deadManMs);
  await c.monitor.start();
}

/** Phase A: the publisher alone — published, sending, and confirmed by the SFU (design §5). */
async function publisherPhase(c: RunContext): Promise<string | null> {
  c.phase = 'A';
  await c.admission.admitPublisher();
  const failure = await c.waitFor(async () => {
    if (!c.agg.publishersReady() || !publisherFlowing(c.agg.media.publisherSent(), 2)) return false;
    const list = await c.deps.rooms.participants(c.room);
    return list.some((p) => p.identity === c.publisher && p.audioTracks === 1);
  }, c.timing.phaseATimeoutMs);
  return failure ? `phase A (publisher): ${failure}` : null;
}

/** Phase B + gate: the globally paced listener ramp, then the exact-N + media gate (design §6–§8). */
async function rampAndGate(c: RunContext): Promise<string | null> {
  const { deps, timing, timeline } = c;
  c.phase = 'B';
  timeline.rampStart = deps.now();
  while (!c.admission.allAdmitted() && !c.blocked()) {
    await c.admission.tick();
    await deps.sleep(timing.tickMs);
  }
  timeline.rampEnd = deps.now();
  c.phase = 'gate';
  const rate = (c.n - 1) / Math.max(0.001, (timeline.rampEnd - timeline.rampStart) / 1000);
  const expect = {
    requested: c.n,
    publisher: c.publisher,
    ice: c.req.ice,
    udpPort: c.req.udpPort,
  } as const;
  const problems = (): string[] => [
    ...clientGateProblems(c.agg, expect),
    ...transportGateProblems(c.agg, c.admission.minted(), expect),
  ];
  const failure = await c.waitFor(
    async () => {
      if (problems().length > 0) return false;
      const s = await c.serverCheck();
      c.server.atGate = s.ok;
      c.server.countAtGate = s.count;
      return s.ok;
    },
    Math.ceil(((c.n - 1) / Math.max(rate, 0.001)) * 1000) + timing.gateTailMs,
  );
  return failure ? `gate: ${failure} (${problems().slice(0, 5).join('; ')})` : null;
}

/** The hold: media rules every window; the SFU's identity set re-checked at the end. */
async function hold(c: RunContext): Promise<boolean> {
  const { deps, timeline } = c;
  c.phase = 'hold';
  timeline.gateAt = deps.now();
  timeline.holdStart = timeline.gateAt;
  const until = timeline.holdStart + c.req.rung.holdSeconds * 1000;
  while (deps.now() < until && !c.abort) {
    await deps.sleep(Math.min(c.timing.statsIntervalMs, Math.max(0, until - deps.now())));
    c.monitor.evaluateMedia(deps.now(), mediaMetrics(c.agg, c.publisher, timeline.holdStart));
  }
  timeline.holdEnd = deps.now();
  if (c.abort) return false;
  const s = await c.serverCheck();
  c.server.atHoldEnd = s.ok;
  c.server.countAtHoldEnd = s.count;
  if (!s.ok) c.raiseController('server-identity', s.problems.join('; '), 'F');
  return s.ok;
}

export async function runRung(
  req: RungRequest,
  deps: ControllerDeps,
  timing: ControllerTiming = DEFAULT_TIMING,
): Promise<RungOutcome> {
  const c = new RunContext(req, deps, timing);
  let gateFailure: string | null = null;
  let holdCompleted = false;
  try {
    await prepare(c);
    gateFailure = (await publisherPhase(c)) ?? (await rampAndGate(c));
    if (gateFailure) c.timeline.failureAt = deps.now();
    else holdCompleted = await hold(c);
  } catch (e) {
    c.raiseController('controller-error', String((e as Error)?.message ?? e), 'F');
  }

  c.phase = 'teardown';
  const teardownStart = deps.now();
  const byes = await c.session.shutdown(
    c.abort ? `abort: ${c.abort.rule}` : 'complete',
    timing.shutdownGraceMs + timing.teardownTimeoutMs + 5_000,
  );
  await deps.sleep(Math.max(0, teardownStart + timing.watchAfterTeardownMs - deps.now()));
  const cleanup = await cleanupRun(
    {
      rooms: deps.rooms,
      dbRows: deps.dbRows,
      sutSample: async () => (deps.sut ? deps.sut.sample() : null),
      sleep: deps.sleep,
      now: deps.now,
    },
    {
      room: c.room,
      baseline: c.monitor.baseline(),
      generatorProcesses: Object.fromEntries(
        byes.map((b) => [c.agentKey(b.index), b.liveChildren]),
      ),
      closedAt: deps.now(),
      recoveryWaitMs: timing.recoveryWaitMs,
      recheckMs: timing.recheckMs,
    },
  );
  c.monitor.stop();
  const post = await deps.postRung({
    sinceMs: c.startedAt,
    untilMs: deps.now(),
    room: c.room,
    identityPrefix: `p84-${runTag(req.runId)}-`,
    generatorIps: c.hellos.flatMap((h) => h.host.ipv4),
  });
  const result = assembleResult({
    req,
    commit: deps.commit,
    hellos: c.hellos,
    times: { startedAt: c.startedAt, endedAt: deps.now(), ...c.timeline },
    holdCompleted,
    gateFailure,
    agg: c.agg,
    publisher: c.publisher,
    minted: c.admission.minted(),
    listenerGrantedAt: c.admission.listenerGrantTimes(),
    connectMs: c.connectMs,
    server: c.server,
    monitor: c.monitor,
    abort: c.abort,
    cleanup,
    post,
    agentIndexOfWorker: (workerId) => c.agentIndexOfWorker(workerId),
    failureAt: c.timeline.failureAt,
    workerIds: c.workerIds(),
  });
  const samples: Record<string, readonly HostSample[]> = { sut: c.monitor.sutSamples };
  for (const [agent, series] of c.monitor.genSamples) samples[c.agentKey(agent)] = series;
  return { result, samples };
}
