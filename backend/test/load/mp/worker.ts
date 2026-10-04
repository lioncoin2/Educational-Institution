/**
 * P8.3.5 — a generator WORKER process. The supervisor forks one of these per
 * shard; each owns its OWN rtc-node runtime and a BOUNDED set of participants,
 * reports structured events over IPC, and tears down only its own participants.
 * It never touches another worker's native handles.
 *
 * It reaches the WebRTC client by DYNAMIC import of the media driver (under
 * test/livekit/), so this file names no rtc-node and the architecture test
 * stays green. Run via: fork(worker.ts, { execArgv: ['-r','ts-node/register'] }).
 */
import { type WorkerAssignment, type WorkerMessage } from './types';

interface ScreenSpec {
  width: number;
  height: number;
  fps: number;
  maxBitrateKbps: number;
}
interface LoadParticipantLike {
  publishMicrophone(): Promise<void>;
  publishScreenShare(spec: ScreenSpec): Promise<void>;
  disconnect(): Promise<void>;
}
interface Driver {
  readonly LoadParticipant: {
    connect(
      ticket: { url: string; token: string },
      opts: { subscribe: boolean; relay: boolean },
    ): Promise<LoadParticipantLike>;
  };
  disposeMedia(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function send(msg: WorkerMessage): void {
  process.send?.(msg);
}

async function run(a: WorkerAssignment): Promise<void> {
  const driver = (await import('../../livekit/load/media-driver')) as unknown as Driver;
  const relay = a.mediaPath === 'relay';
  const live: LoadParticipantLike[] = [];
  const queue = [...a.participants];

  async function admitOne(p: (typeof a.participants)[number]): Promise<void> {
    try {
      const participant = await driver.LoadParticipant.connect(p.ticket, {
        subscribe: p.role === 'listener',
        relay,
      });
      live.push(participant);
      send({ type: 'connected', workerId: a.workerId, participantId: p.identity, role: p.role });
      if (p.role === 'speaker' || p.role === 'screen') await publish(participant, p);
    } catch (e) {
      send({
        type: 'failed',
        workerId: a.workerId,
        participantId: p.identity,
        role: p.role,
        error: String((e as Error).message ?? e),
      });
    }
  }

  async function publish(
    participant: LoadParticipantLike,
    p: (typeof a.participants)[number],
  ): Promise<void> {
    // Settle briefly after connect, then publish with one retry (RUNG 1: the
    // publisher failed when publishing raced an in-flight connect burst).
    await sleep(300);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (p.role === 'speaker') await participant.publishMicrophone();
        else
          await participant.publishScreenShare(
            a.screen ?? { width: 640, height: 360, fps: 15, maxBitrateKbps: 600 },
          );
        send({ type: 'published', workerId: a.workerId, participantId: p.identity });
        return;
      } catch (e) {
        if (attempt === 1)
          send({
            type: 'publishFailed',
            workerId: a.workerId,
            participantId: p.identity,
            error: String((e as Error).message ?? e),
          });
        else await sleep(500);
      }
    }
  }

  // Bounded-concurrency ramp: `connectConcurrency` admits in flight at a time.
  const workers = Array.from({ length: Math.max(1, a.connectConcurrency) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await admitOne(next);
    }
  });
  await Promise.all(workers);
  send({ type: 'rampDone', workerId: a.workerId });

  await new Promise<void>((resolve) => {
    process.on('message', (m: { type?: string }) => {
      if (m?.type === 'shutdown') resolve();
    });
  });

  for (const participant of live) await participant.disconnect().catch(() => undefined);
  await driver.disposeMedia().catch(() => undefined);
  send({ type: 'cleaned', workerId: a.workerId });
}

// Entry: the assignment arrives as the first IPC message.
process.once('message', (assignment: WorkerAssignment) => {
  send({ type: 'ready', workerId: assignment.workerId });
  run(assignment).catch((e: unknown) => {
    send({
      type: 'fatal',
      workerId: assignment.workerId,
      error: String((e as Error).message ?? e),
    });
    process.exit(1);
  });
});
