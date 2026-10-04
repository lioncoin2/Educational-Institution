import { fakeDriver } from '../mp/fake-worker';
import {
  type WorkerAssignment,
  type WorkerCommand,
  type WorkerMessage,
  type WorkerParticipant,
} from '../mp/types';
import { type WorkerOutcome, runWorker } from '../mp/worker';

/**
 * Unit tests for the REAL worker lifecycle (runWorker) driven by the fake media
 * driver — no fork, no rtc-node, no network (P8.3.8, P8.4): ticket-at-a-time
 * admission, publish, media evidence, and the bounded teardown contract.
 */
function participant(
  identity: string,
  role: WorkerParticipant['role'],
  token = 't',
): WorkerParticipant {
  return { identity, room: 'loadtest-p84-x', role, ticket: { url: 'ws://x', token } };
}

function assignment(over: Partial<WorkerAssignment> = {}): WorkerAssignment {
  return {
    runId: '0123456789abcdef',
    workerId: 7,
    ice: { mode: 'turn-free', stunUrls: ['stun:127.0.0.1:3479'] },
    screen: null,
    publishRetries: 0,
    teardownTimeoutMs: 2_000,
    statsIntervalMs: 200,
    probe: false,
    ...over,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Starts a worker, admits `people`, lets it run for `holdMs`, then shuts it down. */
async function run(a: WorkerAssignment, people: WorkerParticipant[], holdMs = 100) {
  const sent: WorkerMessage[] = [];
  let command: (cmd: WorkerCommand) => void = () => undefined;
  const outcome: Promise<WorkerOutcome> = runWorker(a, {
    driver: fakeDriver,
    send: async (m) => {
      sent.push(m);
    },
    onCommand: (h) => {
      command = h;
    },
  });
  for (const p of people) command({ type: 'admit', participant: p });
  await sleep(holdMs);
  command({ type: 'shutdown' });
  const result = await outcome;
  return { outcome: result, sent, types: sent.map((m) => m.type) };
}

describe('worker lifecycle (runWorker)', () => {
  it('normal cleanup: teardownStarted then exactly one cleaned, outcome cleaned', async () => {
    const { outcome, types, sent } = await run(assignment(), [
      participant('l1', 'listener'),
      participant('l2', 'listener'),
    ]);
    expect(outcome).toBe('cleaned');
    expect(types.filter((t) => t === 'cleaned')).toHaveLength(1);
    expect(types.filter((t) => t === 'teardownTimeout')).toHaveLength(0);
    expect(types.indexOf('teardownStarted')).toBeLessThan(types.indexOf('cleaned'));
    expect(types[types.length - 1]).toBe('cleaned'); // terminal
    expect(sent.find((m) => m.type === 'teardownStarted')).toMatchObject({ participants: 2 });
  });

  it('a hung disconnect becomes a bounded, explicit teardownTimeout — never a cleaned', async () => {
    const { outcome, types, sent } = await run(assignment({ teardownTimeoutMs: 50 }), [
      participant('l1', 'listener'),
      participant('l2', 'listener', 'HANG'),
    ]);
    expect(outcome).toBe('teardownTimeout');
    expect(types).not.toContain('cleaned');
    expect(types.filter((t) => t === 'teardownTimeout')).toHaveLength(1);
    expect(sent.find((m) => m.type === 'teardownTimeout')).toMatchObject({ pending: 1 });
  });

  it('publisher states in lifecycle order, connecting BEFORE connected; published carries the track SID', async () => {
    const { sent } = await run(assignment(), [participant('pub', 'speaker')], 400);
    const states = sent.flatMap((m) => (m.type === 'publisherState' ? [m.state] : []));
    expect(states).toEqual(['connecting', 'connected', 'publishing', 'published', 'disconnected']);
    const connecting = sent.findIndex(
      (m) => m.type === 'publisherState' && m.state === 'connecting',
    );
    expect(connecting).toBeLessThan(sent.findIndex((m) => m.type === 'connected'));
    expect(sent.find((m) => m.type === 'published')).toMatchObject({ trackSid: 'TR_fake_audio' });
  });

  it('a persistent publish failure is reported, not hidden', async () => {
    const { types, sent } = await run(
      assignment(),
      [participant('pub', 'speaker', 'PUBFAIL')],
      400,
    );
    expect(types).toContain('publishFailed');
    expect(types).not.toContain('published');
    const states = sent.flatMap((m) => (m.type === 'publisherState' ? [m.state] : []));
    expect(states).toContain('failed');
  });

  it('a connect failure is reported as failed for that participant only', async () => {
    const { sent } = await run(assignment(), [
      participant('ok', 'listener'),
      participant('bad', 'listener', 'FAILCONN'),
    ]);
    expect(
      sent
        .filter((m) => m.type === 'connected')
        .map((m) => 'participantId' in m && m.participantId),
    ).toEqual(['ok']);
    expect(sent.find((m) => m.type === 'failed')).toMatchObject({ participantId: 'bad' });
  });

  it('listeners report subscribed, receiving, transport and windows (media evidence)', async () => {
    const { sent } = await run(assignment(), [participant('l1', 'listener')], 700);
    expect(sent.find((m) => m.type === 'subscribed')).toMatchObject({
      participantId: 'l1',
      trackSid: 'TR_fake_audio',
    });
    expect(sent.find((m) => m.type === 'receiving')).toMatchObject({ participantId: 'l1' });
    expect(sent.find((m) => m.type === 'transport')).toMatchObject({
      report: { protocol: 'udp', localType: 'host', remoteType: 'host', remotePort: 7882 },
    });
    const windows = sent.flatMap((m) => (m.type === 'mediaWindow' ? [m.window] : []));
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[windows.length - 1]).toMatchObject({
      listeners: 1,
      subscribed: 1,
      receiving: 1,
      stalled: 0,
    });
  });

  it('a listener that never subscribes is visible (no subscribed event, window counts it)', async () => {
    const { sent } = await run(assignment(), [participant('l1', 'listener', 'NOSUB')], 500);
    expect(sent.some((m) => m.type === 'subscribed')).toBe(false);
    const windows = sent.flatMap((m) => (m.type === 'mediaWindow' ? [m.window] : []));
    expect(windows[windows.length - 1]).toMatchObject({ listeners: 1, subscribed: 0 });
  });

  it('a stalled listener raises a stall fault', async () => {
    const { sent } = await run(
      assignment({ statsIntervalMs: 300 }),
      [participant('l1', 'listener', 'STALL')],
      2_200,
    );
    expect(sent.some((m) => m.type === 'mediaFault' && m.fault === 'stall')).toBe(true);
  });

  it('a duplicate-identity eviction is reported with its reason', async () => {
    const { sent } = await run(assignment(), [participant('l1', 'listener', 'DUP')], 1_300);
    expect(sent.find((m) => m.type === 'mediaFault' && m.fault === 'disconnected')).toMatchObject({
      reason: 'DUPLICATE_IDENTITY',
    });
  });

  it('relay transport is reported as such (T2 evidence)', async () => {
    const { sent } = await run(
      assignment({ ice: { mode: 'relay' } }),
      [participant('l1', 'listener')],
      400,
    );
    expect(sent.find((m) => m.type === 'transport')).toMatchObject({
      report: {
        localType: 'relay',
        localCandidateTypes: expect.arrayContaining(['relay']) as string[],
      },
    });
  });

  it('the sampled content probe decodes the 440 Hz tone', async () => {
    const { sent } = await run(assignment({ probe: true }), [participant('l1', 'listener')], 300);
    const probe = sent.find((m) => m.type === 'probe');
    expect(probe).toMatchObject({ ok: true });
  });

  it('faults raised by its own teardown are not reported', async () => {
    const { sent } = await run(assignment(), [participant('l1', 'listener')], 300);
    const teardownAt = sent.findIndex((m) => m.type === 'teardownStarted');
    expect(sent.slice(teardownAt).some((m) => m.type === 'mediaFault')).toBe(false);
  });
});
