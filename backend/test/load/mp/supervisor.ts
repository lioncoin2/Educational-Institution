/**
 * P8.3.5 — the supervisor. Forks N worker processes, assigns each a bounded,
 * deterministic slice of participants, aggregates their IPC events, and enforces
 * the EXACT-N gate: the hold timer starts only once exactly the requested number
 * are connected AND the publisher has published. ANY failure or worker crash
 * aborts the whole run — it never holds with fewer than requested. On exit it
 * shuts workers down, deletes the loadtest rooms, and returns one combined
 * result + event CSV.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { join } from 'node:path';

import { type MediaPath, type Scenario } from '../core/config';
import { expandParticipants, roomName } from '../core/identity';
import { getScreenProfile } from '../core/screen-profiles';
import { type LivekitEnv, deleteRooms, ensureRooms, mintTicket } from '../livekit/tokens';
import { MpAggregator } from './aggregate';
import { EventCsv } from './csv';
import { partitionParticipants } from './partition';
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
  readonly eventCsvPath?: string | null;
  readonly gateTimeoutMs?: number;
  readonly workerModule?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const publisherRequired = scenario.speakersPerRoom + scenario.screenSharesPerRoom > 0;

  // Mint a ticket per participant (roomCreate so the first joiner makes the room).
  const tickets: WorkerParticipant[] = [];
  for (const p of plan) {
    const ticket = await mintTicket(env, {
      identity: p.identity,
      room: p.room,
      role: p.role,
      roomCreate: true,
    });
    tickets.push({ identity: p.identity, room: p.room, role: p.role, ticket });
  }
  const chunks = partitionParticipants(plan, opts.workers);
  const spec = screenSpec(scenario);
  const workerModule = opts.workerModule ?? join(__dirname, 'worker.ts');

  await ensureRooms(env, rooms); // backstop; tokens also carry roomCreate

  const agg = new MpAggregator(requested, publisherRequired);
  const csv = opts.eventCsvPath ? new EventCsv(opts.eventCsvPath) : null;
  if (csv) await csv.start();

  let shuttingDown = false;
  const children: ChildProcess[] = [];
  let resolveGate: (() => void) | null = null;
  const gate = new Promise<void>((res) => {
    resolveGate = res;
  });
  const update = (): void => {
    if (agg.gateMet() || agg.unreachable().yes) resolveGate?.();
  };

  let offset = 0;
  chunks.forEach((chunk, workerId) => {
    const assignment: WorkerAssignment = {
      runId,
      workerId,
      mediaPath: opts.mediaPath,
      screen: spec,
      connectConcurrency: opts.connectConcurrency ?? 4,
      participants: tickets.slice(offset, offset + chunk.length),
    };
    offset += chunk.length;
    const child = fork(workerModule, [], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(child);
    child.on('message', (msg: WorkerMessage) => {
      agg.record(msg);
      void csv?.write(runId, msg, agg.connected());
      update();
    });
    child.on('exit', (code) => {
      if (!shuttingDown && code !== 0) {
        agg.record({ type: 'fatal', workerId, error: `worker exited ${code}` });
        update();
      }
    });
    child.send(assignment);
  });

  // Wait for the gate (met or unreachable) or a timeout.
  const timeoutMs = opts.gateTimeoutMs ?? 120_000;
  const timedOut = await Promise.race([gate.then(() => false), sleep(timeoutMs).then(() => true)]);

  const unreachable = agg.unreachable();
  const met = agg.gateMet();
  let aborted = false;
  let abortReason: string | null = null;

  if (!met) {
    aborted = true;
    abortReason = unreachable.yes
      ? unreachable.reason
      : timedOut
        ? `gate timeout: ${agg.connected()}/${requested} connected`
        : `gate not met: ${agg.connected()}/${requested}`;
  } else {
    // Hold at full population; abort early if a worker crashes mid-hold.
    const holdEnd = Date.now() + opts.holdSeconds * 1000;
    while (Date.now() < holdEnd) {
      if (agg.crashes() > 0) {
        aborted = true;
        abortReason = `worker crash during hold`;
        break;
      }
      await sleep(500);
    }
  }

  // Shutdown + cleanup (always).
  shuttingDown = true;
  for (const c of children) c.send({ type: 'shutdown' } as const);
  await waitExit(children, 8000);
  await deleteRooms(env, rooms).catch(() => undefined);

  return {
    runId,
    requested,
    workers: chunks.length,
    connected: agg.connected(),
    failed: agg.failed(),
    publisherPublished: agg.publisherPublished(),
    workerCrashes: agg.crashes(),
    gateMet: met,
    aborted,
    abortReason,
    holdSeconds: met && !aborted ? opts.holdSeconds : 0,
  };
}

async function waitExit(children: readonly ChildProcess[], graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs;
  const alive = () => children.filter((c) => c.exitCode === null && !c.killed);
  while (alive().length > 0 && Date.now() < deadline) await sleep(200);
  for (const c of alive()) c.kill('SIGKILL');
}
