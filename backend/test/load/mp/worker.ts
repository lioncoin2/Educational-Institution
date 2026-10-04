/**
 * P8.3.5/P8.3.8 — a generator WORKER. The supervisor forks one per shard; each
 * owns its OWN rtc-node runtime and a BOUNDED set of participants, reports
 * structured events over IPC, and tears down only its own participants.
 *
 * Lifecycle (owned here, once): ready → ramp → rampDone → [shutdown] →
 * teardownStarted → (cleaned | teardownTimeout) → process exit with
 * WORKER_EXIT_CODE. `runWorker` is the lifecycle itself, free of process
 * globals so it is unit-testable with a fake driver; `runWorkerProcess` is the
 * IPC entry shared by the real worker and the test fake.
 *
 * The WebRTC client is reached by DYNAMIC import of the media driver (under
 * test/livekit/), so this file names no rtc-node and the architecture test
 * stays green. Run via: fork(worker.ts, { execArgv: ['-r','ts-node/register'] }).
 */
import {
  type PublisherState,
  WORKER_EXIT_CODE,
  type WorkerAssignment,
  type WorkerMessage,
  type WorkerParticipant,
} from './types';

interface ScreenSpec {
  width: number;
  height: number;
  fps: number;
  maxBitrateKbps: number;
}
export interface LoadParticipantLike {
  publishMicrophone(): Promise<void>;
  publishScreenShare(spec: ScreenSpec): Promise<void>;
  disconnect(): Promise<void>;
}
export interface Driver {
  readonly LoadParticipant: {
    connect(
      ticket: { url: string; token: string },
      opts: { subscribe: boolean; relay: boolean },
    ): Promise<LoadParticipantLike>;
  };
  disposeMedia(): Promise<void>;
}

export interface WorkerIo {
  readonly driver: Driver;
  /** Hands a message to the supervisor; resolves once it is flushed to IPC. */
  readonly send: (msg: WorkerMessage) => Promise<void>;
  /** Resolves when the supervisor asks this worker to shut down. */
  readonly shutdown: Promise<void>;
}

export type WorkerOutcome = 'cleaned' | 'teardownTimeout';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errorText = (e: unknown): string => String((e as Error)?.message ?? e);

/** The worker lifecycle. Returns how teardown ended; never exits the process. */
export async function runWorker(a: WorkerAssignment, io: WorkerIo): Promise<WorkerOutcome> {
  const { driver } = io;
  const relay = a.mediaPath === 'relay';
  const live: LoadParticipantLike[] = [];
  const pubIds: string[] = [];
  const queue = [...a.participants];
  const emit = (msg: WorkerMessage): void => void io.send(msg);
  const pubState = (participantId: string, state: PublisherState): void =>
    emit({ type: 'publisherState', workerId: a.workerId, participantId, state });

  emit({ type: 'ready', workerId: a.workerId });

  async function admitOne(p: WorkerParticipant): Promise<void> {
    const isPub = p.role === 'speaker' || p.role === 'screen';
    if (isPub) pubState(p.identity, 'connecting');
    try {
      const participant = await driver.LoadParticipant.connect(p.ticket, {
        subscribe: p.role === 'listener',
        relay,
      });
      if (isPub) pubIds.push(p.identity);
      live.push(participant);
      emit({ type: 'connected', workerId: a.workerId, participantId: p.identity, role: p.role });
      if (isPub) {
        pubState(p.identity, 'connected');
        await publish(participant, p);
      }
    } catch (e) {
      if (isPub) pubState(p.identity, 'failed');
      emit({
        type: 'failed',
        workerId: a.workerId,
        participantId: p.identity,
        role: p.role,
        error: errorText(e),
      });
    }
  }

  /**
   * Publishes with BOUNDED, backed-off retries (P8.3.6). `publishTrack`
   * resolving is the authoritative "published" signal; a persistent failure is
   * reported, never hidden.
   */
  async function publish(participant: LoadParticipantLike, p: WorkerParticipant): Promise<void> {
    await sleep(200);
    const maxAttempts = Math.max(1, a.publishRetries + 1);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      emit({ type: 'publishAttempt', workerId: a.workerId, participantId: p.identity, attempt });
      pubState(p.identity, 'publishing');
      try {
        if (p.role === 'speaker') await participant.publishMicrophone();
        else
          await participant.publishScreenShare(
            a.screen ?? { width: 640, height: 360, fps: 15, maxBitrateKbps: 600 },
          );
        pubState(p.identity, 'published');
        emit({ type: 'published', workerId: a.workerId, participantId: p.identity });
        return;
      } catch (e) {
        if (attempt === maxAttempts - 1) {
          pubState(p.identity, 'failed');
          emit({
            type: 'publishFailed',
            workerId: a.workerId,
            participantId: p.identity,
            error: errorText(e),
          });
        } else {
          await sleep(500 * 2 ** attempt); // exponential backoff
        }
      }
    }
  }

  /** Disconnect everything, bounded by teardownTimeoutMs; report exactly one terminal event. */
  async function teardown(): Promise<WorkerOutcome> {
    emit({ type: 'teardownStarted', workerId: a.workerId, participants: live.length });
    let disconnected = 0;
    const work = (async (): Promise<true> => {
      for (const participant of live) {
        await participant.disconnect().catch(() => undefined);
        disconnected += 1;
      }
      for (const id of pubIds) pubState(id, 'disconnected');
      await driver.disposeMedia().catch(() => undefined);
      return true;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), a.teardownTimeoutMs);
    });
    const finished = await Promise.race([work, deadline]);
    clearTimeout(timer);
    if (finished) {
      await io.send({ type: 'cleaned', workerId: a.workerId });
      return 'cleaned';
    }
    await io.send({
      type: 'teardownTimeout',
      workerId: a.workerId,
      pending: live.length - disconnected,
    });
    return 'teardownTimeout';
  }

  // Bounded-concurrency ramp: `connectConcurrency` admits in flight at a time.
  const lanes = Array.from({ length: Math.max(1, a.connectConcurrency) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await admitOne(next);
    }
  });
  await Promise.all(lanes);
  emit({ type: 'rampDone', workerId: a.workerId });

  await io.shutdown;
  return teardown();
}

/**
 * The worker process entry: wires IPC, runs the lifecycle, and EXITS with the
 * shared exit code once teardown has reported. The shutdown listener is
 * registered immediately so a shutdown sent mid-ramp is never lost.
 */
export function runWorkerProcess(loadDriver: () => Promise<Driver>): void {
  let requestShutdown: () => void = () => undefined;
  const shutdown = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });
  process.on('message', (m: { type?: string }) => {
    if (m?.type === 'shutdown') requestShutdown();
  });
  const send = (msg: WorkerMessage): Promise<void> =>
    new Promise((resolve) => {
      if (!process.send) return resolve();
      process.send(msg, undefined, undefined, () => resolve());
    });

  process.once('message', (assignment: WorkerAssignment) => {
    void (async () => {
      try {
        const driver = await loadDriver();
        const outcome = await runWorker(assignment, { driver, send, shutdown });
        process.exit(
          outcome === 'cleaned' ? WORKER_EXIT_CODE.cleaned : WORKER_EXIT_CODE.teardownTimeout,
        );
      } catch (e) {
        await send({ type: 'fatal', workerId: assignment.workerId, error: errorText(e) });
        process.exit(WORKER_EXIT_CODE.fatal);
      }
    })();
  });
}

if (require.main === module) {
  runWorkerProcess(async () => import('../../livekit/load/media-driver'));
}
