/**
 * P8.3.5/P8.3.6 — the supervisor. Two-phase sequencing:
 *
 *   PHASE A (publisher-first): fork ONE publisher worker, connect the
 *   publisher(s) and publish, with bounded retry. Listeners are NOT started
 *   until every publisher is PUBLISHED — so the publish never races a listener
 *   connection burst (the MP_40 failure).
 *
 *   PHASE B (listener ramp): only after publishers are confirmed, fork the
 *   listener workers (bounded ~10 each) and ramp.
 *
 * The exact-N gate still holds: the hold starts only at EXACTLY requested
 * connected + all publishers published; ANY failure/crash aborts and cleans up.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { join } from 'node:path';

import { type MediaPath, type Scenario } from '../core/config';
import { type ParticipantPlan, expandParticipants, roomName } from '../core/identity';
import { getScreenProfile } from '../core/screen-profiles';
import { type LivekitEnv, deleteRooms, ensureRooms, mintTicket } from '../livekit/tokens';
import { MpAggregator } from './aggregate';
import { EventCsv } from './csv';
import { partitionParticipants, perWorker, rampStaggerMs } from './partition';
import {
  type MpResult,
  type WorkerAssignment,
  type WorkerMessage,
  type WorkerParticipant,
} from './types';

export interface SupervisorOptions {
  readonly scenario: Scenario;
  readonly env: LivekitEnv;
  readonly workers: number;
  readonly mediaPath: MediaPath;
  readonly holdSeconds: number;
  readonly connectConcurrency?: number;
  readonly publishRetries?: number;
  readonly eventCsvPath?: string | null;
  readonly phaseATimeoutMs?: number;
  readonly phaseBTimeoutMs?: number;
  /** Delay between starting successive listener workers (default: from rampPerSecond). */
  readonly workerStartStaggerMs?: number;
  /** Bound on each worker's own teardown before it reports a timeout (default 7 s). */
  readonly teardownTimeoutMs?: number;
  /** Time workers get to exit after shutdown before a forced kill (default 10 s, unchanged). */
  readonly shutdownGraceMs?: number;
  readonly workerModule?: string;
  /** Injectable network ops (tests use fakes; production uses the real tokens module). */
  readonly deps?: {
    readonly mintTicket?: typeof mintTicket;
    readonly ensureRooms?: typeof ensureRooms;
    readonly deleteRooms?: typeof deleteRooms;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Shutdown grace is unchanged from P8.3.7; the worker's own teardown bound sits inside it. */
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 7_000;

/** A worker process the supervisor forked and therefore owns. */
interface OwnedWorker {
  readonly workerId: number;
  readonly child: ChildProcess;
  /** Resolves on the process 'exit' event (after its exit was recorded). */
  readonly exited: Promise<void>;
}

/** Resolves true if `p` settles within `ms`, false otherwise; never leaves a timer behind. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const result = await Promise.race([p.then(() => true as const), late]);
  clearTimeout(timer);
  return result;
}

function screenSpec(scenario: Scenario): WorkerAssignment['screen'] {
  if (!scenario.screenProfile) return null;
  const p = getScreenProfile(scenario.screenProfile);
  return p
    ? { width: p.width, height: p.height, fps: p.fps, maxBitrateKbps: p.maxBitrateKbps }
    : null;
}

export async function runSupervisor(opts: SupervisorOptions): Promise<MpResult> {
  const { scenario, env } = opts;
  const runId = `mp-${Date.now()}`;
  const plan = expandParticipants(scenario);
  const requested = plan.length;
  const rooms = Array.from({ length: scenario.rooms }, (_, i) => roomName(scenario, i));
  const publishers = plan.filter((p) => p.role !== 'listener');
  const listeners = plan.filter((p) => p.role === 'listener');
  const spec = screenSpec(scenario);
  const workerModule = opts.workerModule ?? join(__dirname, 'worker.ts');

  const mint = opts.deps?.mintTicket ?? mintTicket;
  const ensure = opts.deps?.ensureRooms ?? ensureRooms;
  const remove = opts.deps?.deleteRooms ?? deleteRooms;

  const tickets = new Map<string, WorkerParticipant>();
  for (const p of plan) {
    const ticket = await mint(env, {
      identity: p.identity,
      room: p.room,
      role: p.role,
      roomCreate: true,
    });
    tickets.set(p.identity, { identity: p.identity, room: p.room, role: p.role, ticket });
  }

  await ensure(env, rooms);
  const agg = new MpAggregator(requested, publishers.length);
  const csv = opts.eventCsvPath ? new EventCsv(opts.eventCsvPath) : null;
  if (csv) await csv.start();

  const owned: OwnedWorker[] = [];
  let shuttingDown = false;

  const forkWorker = (
    workerId: number,
    group: readonly ParticipantPlan[],
    retries: number,
    cc: number,
  ): void => {
    const assignment: WorkerAssignment = {
      runId,
      workerId,
      mediaPath: opts.mediaPath,
      screen: spec,
      connectConcurrency: cc,
      publishRetries: retries,
      teardownTimeoutMs: opts.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS,
      participants: group
        .map((p) => tickets.get(p.identity))
        .filter((x): x is WorkerParticipant => !!x),
    };
    const child = fork(workerModule, [], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    child.on('message', (msg: WorkerMessage) => {
      agg.record(msg);
      void csv?.write(runId, msg, agg.connected());
    });
    // Every exit is recorded. A worker exits only after shutdown, so ANY exit
    // before it (whatever the code) is a crash.
    child.on('exit', (code, signal) => {
      agg.recordExit(workerId, code, signal);
      if (!shuttingDown)
        agg.record({
          type: 'fatal',
          workerId,
          error: `worker exited before shutdown (code ${code}, signal ${signal})`,
        });
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    owned.push({ workerId, child, exited });
    child.send(assignment);
  };

  const finish = async (
    met: boolean,
    aborted: boolean,
    reason: string | null,
  ): Promise<MpResult> => {
    shuttingDown = true;
    for (const w of owned) if (w.child.connected) w.child.send({ type: 'shutdown' } as const);
    await waitExit(owned, opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, agg);
    await remove(env, rooms).catch(() => undefined);
    return {
      runId,
      requested,
      workers: owned.length,
      teardown: agg.teardownSummary(owned.map((w) => w.workerId)),
      connected: agg.connected(),
      failed: agg.failed(),
      publisherPublished: agg.publishersPublished() >= publishers.length,
      workerCrashes: agg.crashes(),
      gateMet: met,
      aborted,
      abortReason: reason,
      holdSeconds: met && !aborted ? opts.holdSeconds : 0,
    };
  };

  // PHASE A — publisher-first (skipped when there is no publisher).
  if (publishers.length > 0) {
    forkWorker(0, publishers, opts.publishRetries ?? 3, 1);
    const a = await waitFor(
      () => agg.publishersReady(),
      () => agg.unreachable(),
      opts.phaseATimeoutMs ?? 30_000,
    );
    if (!a.ok) return finish(false, true, `phase A (publisher): ${a.reason}`);
  }

  // PHASE B — listener ramp across `workers` processes, STAGGERED so the global
  // connect rate honours rampPerSecond (P8.3.7: forking all workers at once
  // bursts the host — 10 cold-starts + ~40 concurrent connects overran loopback
  // UDP buffers and spiked CPU).
  const chunks = partitionParticipants(listeners, opts.workers);
  const stagger =
    opts.workerStartStaggerMs ??
    rampStaggerMs(perWorker(listeners.length, opts.workers), scenario.rampPerSecond);
  for (let i = 0; i < chunks.length; i += 1) {
    forkWorker(i + 1, chunks[i] ?? [], 0, opts.connectConcurrency ?? 4);
    if (agg.unreachable().yes) break;
    if (i < chunks.length - 1) await sleep(stagger);
  }
  const b = await waitFor(
    () => agg.gateMet(),
    () => agg.unreachable(),
    opts.phaseBTimeoutMs ?? 120_000,
  );
  if (!b.ok) return finish(false, true, `phase B (listeners): ${b.reason}`);

  // Hold at full population; abort early on a worker crash.
  const holdEnd = Date.now() + opts.holdSeconds * 1000;
  while (Date.now() < holdEnd) {
    if (agg.crashes() > 0) return finish(true, true, 'worker crash during hold');
    await sleep(500);
  }
  return finish(true, false, null);
}

/** Resolves ok when pred() true; not-ok when unreachable or timeout. Polls agg state. */
async function waitFor(
  pred: () => boolean,
  unreachable: () => { yes: boolean; reason: string },
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return { ok: true, reason: '' };
    const u = unreachable();
    if (u.yes) return { ok: false, reason: u.reason };
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout' };
    await sleep(100);
  }
}

/**
 * Waits for every owned worker to EXIT (its 'exit' event, not merely "signal
 * sent"). Survivors at the grace deadline are recorded as forced BEFORE being
 * SIGKILLed, then awaited so their exit is accounted too.
 */
async function waitExit(
  owned: readonly OwnedWorker[],
  graceMs: number,
  agg: MpAggregator,
): Promise<void> {
  if (await settlesWithin(Promise.all(owned.map((w) => w.exited)), graceMs)) return;
  const survivors = owned.filter((w) => w.child.exitCode === null && w.child.signalCode === null);
  for (const w of survivors) {
    agg.recordForcedKill(w.workerId);
    w.child.kill('SIGKILL');
  }
  await settlesWithin(Promise.all(survivors.map((w) => w.exited)), 5_000);
}
