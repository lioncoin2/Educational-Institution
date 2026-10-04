/**
 * P8.3.5/P8.3.8/P8.4 — a generator WORKER. Its agent forks one per shard; each
 * owns its OWN rtc-node runtime and a BOUNDED set of participants, admitted one
 * just-in-time ticket at a time (the controller owns pacing), reports structured
 * events over IPC, and tears down only its own participants.
 *
 * Lifecycle (owned here, once): ready → admit* → [shutdown | IPC disconnect |
 * SIGTERM] → teardownStarted → (cleaned | teardownTimeout) → process exit with
 * WORKER_EXIT_CODE. `runWorker` is the lifecycle itself, free of process globals
 * so it is unit-testable with a fake driver; `runWorkerProcess` is the IPC
 * entry shared by the real worker and the test fake. Media observation is
 * delegated to mp/worker-media.ts.
 *
 * The WebRTC client is reached through the driver port (mp/driver.ts) whose
 * adapter is loaded by DYNAMIC import, so this file names no rtc-node.
 */
import { type Driver, type LoadParticipantLike } from './driver';
import {
  type PublisherState,
  WORKER_EXIT_CODE,
  type WorkerAssignment,
  type WorkerCommand,
  type WorkerMessage,
  type WorkerParticipant,
} from './types';
import { WorkerMedia } from './worker-media';

export interface WorkerIo {
  readonly driver: Driver;
  /** Hands a message to the host; resolves once it is flushed to IPC. */
  readonly send: (msg: WorkerMessage) => Promise<void>;
  /** Registers the single command handler (admit / shutdown). */
  readonly onCommand: (handler: (cmd: WorkerCommand) => void) => void;
}

export type WorkerOutcome = 'cleaned' | 'teardownTimeout';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errorText = (e: unknown): string => String((e as Error)?.message ?? e);

/** The worker lifecycle. Returns how teardown ended; never exits the process. */
export async function runWorker(a: WorkerAssignment, io: WorkerIo): Promise<WorkerOutcome> {
  const { driver } = io;
  const live: LoadParticipantLike[] = [];
  const pubIds: string[] = [];
  const connecting = new Set<Promise<void>>();
  const emit = (msg: WorkerMessage): void => void io.send(msg);
  const pubState = (participantId: string, state: PublisherState): void =>
    emit({ type: 'publisherState', workerId: a.workerId, participantId, state });
  const media = new WorkerMedia(a, emit);
  let closing = false;
  let requestShutdown: () => void = () => undefined;
  const shutdown = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });

  async function admitOne(p: WorkerParticipant): Promise<void> {
    const isPub = p.role !== 'listener';
    if (isPub) pubState(p.identity, 'connecting');
    let participant: LoadParticipantLike;
    try {
      participant = await driver.LoadParticipant.connect(p.ticket, {
        subscribe: p.role === 'listener',
        ice: a.ice,
      });
    } catch (e) {
      // `failed` means exactly "the connect failed" — never a later error of a connected participant.
      if (isPub) pubState(p.identity, 'failed');
      emit({
        type: 'failed',
        workerId: a.workerId,
        participantId: p.identity,
        role: p.role,
        error: errorText(e),
      });
      return;
    }
    if (closing) {
      await participant.disconnect().catch(() => undefined);
      return;
    }
    if (isPub) pubIds.push(p.identity);
    live.push(participant);
    emit({ type: 'connected', workerId: a.workerId, participantId: p.identity, role: p.role });
    media.watch(p.identity, p.role, participant);
    if (isPub) {
      pubState(p.identity, 'connected');
      await publish(participant, p); // reports its own failure (publishFailed), never throws
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
        let trackSid = '';
        if (p.role === 'speaker') ({ trackSid } = await participant.publishMicrophone());
        else
          await participant.publishScreenShare(
            a.screen ?? { width: 640, height: 360, fps: 15, maxBitrateKbps: 600 },
          );
        pubState(p.identity, 'published');
        emit({ type: 'published', workerId: a.workerId, participantId: p.identity, trackSid });
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
    closing = true;
    media.stop();
    emit({ type: 'teardownStarted', workerId: a.workerId, participants: live.length });
    let disconnected = 0;
    const work = (async (): Promise<true> => {
      await Promise.allSettled([...connecting]);
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
      pending: live.length - disconnected + connecting.size,
    });
    return 'teardownTimeout';
  }

  io.onCommand((cmd) => {
    if (cmd.type === 'shutdown') return requestShutdown();
    if (closing) return;
    const p = admitOne(cmd.participant);
    connecting.add(p);
    void p.finally(() => connecting.delete(p));
  });
  emit({ type: 'ready', workerId: a.workerId });
  media.start();
  await shutdown;
  return teardown();
}

/**
 * The worker process entry: wires IPC, runs the lifecycle, and EXITS with the
 * shared exit code once teardown has reported. Losing the IPC channel (the
 * agent died) and SIGTERM/SIGINT are treated as shutdown, so a worker never
 * outlives its host with media still connected.
 */
export function runWorkerProcess(loadDriver: () => Promise<Driver>): void {
  // Commands that arrive before the lifecycle registers its handler (e.g. while
  // the driver loads) are buffered, never dropped.
  let handler: ((cmd: WorkerCommand) => void) | null = null;
  const early: WorkerCommand[] = [];
  let assignment: WorkerAssignment | null = null;
  const dispatch = (cmd: WorkerCommand): void => {
    if (handler) handler(cmd);
    else early.push(cmd);
  };
  const stop = (): void => dispatch({ type: 'shutdown' });
  process.on('disconnect', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const send = (msg: WorkerMessage): Promise<void> =>
    new Promise((resolve) => {
      if (!process.send || !process.connected) return resolve();
      process.send(msg, undefined, undefined, () => resolve());
    });

  process.on('message', (m: WorkerAssignment | WorkerCommand) => {
    if (assignment === null && 'runId' in m) {
      assignment = m;
      void (async () => {
        try {
          const driver = await loadDriver();
          const outcome = await runWorker(m, {
            driver,
            send,
            onCommand: (h) => {
              handler = h;
              for (const cmd of early.splice(0)) h(cmd);
            },
          });
          process.exit(
            outcome === 'cleaned' ? WORKER_EXIT_CODE.cleaned : WORKER_EXIT_CODE.teardownTimeout,
          );
        } catch (e) {
          await send({ type: 'fatal', workerId: m.workerId, error: errorText(e) });
          process.exit(WORKER_EXIT_CODE.fatal);
        }
      })();
      return;
    }
    if ('type' in m) dispatch(m);
  });
}

if (require.main === module) {
  runWorkerProcess(async () => import('../../livekit/load/media-driver'));
}
