import { fakeDriver } from '../mp/fake-worker';
import { type WorkerAssignment, type WorkerMessage, type WorkerParticipant } from '../mp/types';
import { runWorker } from '../mp/worker';

/**
 * Unit tests for the REAL worker lifecycle (runWorker) driven by the fake media
 * driver — no fork, no rtc-node, no network (P8.3.8).
 */
function participant(
  identity: string,
  role: WorkerParticipant['role'],
  token = 't',
): WorkerParticipant {
  return { identity, room: 'loadtest-x-r0', role, ticket: { url: 'ws://x', token } };
}

function assignment(
  participants: WorkerParticipant[],
  over: Partial<WorkerAssignment> = {},
): WorkerAssignment {
  return {
    runId: 'r',
    workerId: 7,
    mediaPath: 'direct',
    screen: null,
    connectConcurrency: 2,
    publishRetries: 0,
    teardownTimeoutMs: 2_000,
    participants,
    ...over,
  };
}

async function run(a: WorkerAssignment) {
  const sent: WorkerMessage[] = [];
  const outcome = await runWorker(a, {
    driver: fakeDriver,
    send: async (m) => {
      sent.push(m);
    },
    shutdown: Promise.resolve(),
  });
  const types = sent.map((m) => m.type);
  return { outcome, sent, types };
}

describe('worker lifecycle (runWorker)', () => {
  it('normal cleanup: teardownStarted then exactly one cleaned, outcome cleaned', async () => {
    const { outcome, types, sent } = await run(
      assignment([participant('l1', 'listener'), participant('l2', 'listener')]),
    );
    expect(outcome).toBe('cleaned');
    expect(types.filter((t) => t === 'cleaned')).toHaveLength(1);
    expect(types.filter((t) => t === 'teardownTimeout')).toHaveLength(0);
    expect(types.indexOf('rampDone')).toBeLessThan(types.indexOf('teardownStarted'));
    expect(types.indexOf('teardownStarted')).toBeLessThan(types.indexOf('cleaned'));
    expect(types[types.length - 1]).toBe('cleaned'); // terminal
    expect(sent.find((m) => m.type === 'teardownStarted')).toMatchObject({ participants: 2 });
  });

  it('a hung disconnect becomes a bounded, explicit teardownTimeout — never a cleaned', async () => {
    const { outcome, types, sent } = await run(
      assignment([participant('l1', 'listener'), participant('l2', 'listener', 'HANG')], {
        teardownTimeoutMs: 50,
      }),
    );
    expect(outcome).toBe('teardownTimeout');
    expect(types).not.toContain('cleaned');
    expect(types.filter((t) => t === 'teardownTimeout')).toHaveLength(1);
    expect(sent.find((m) => m.type === 'teardownTimeout')).toMatchObject({ pending: 1 });
  });

  it('publisher states are emitted in lifecycle order, connecting BEFORE the connect completes', async () => {
    const { sent } = await run(assignment([participant('pub', 'speaker')]));
    const states = sent.flatMap((m) => (m.type === 'publisherState' ? [m.state] : []));
    expect(states).toEqual(['connecting', 'connected', 'publishing', 'published', 'disconnected']);
    const connecting = sent.findIndex(
      (m) => m.type === 'publisherState' && m.state === 'connecting',
    );
    const connected = sent.findIndex((m) => m.type === 'connected');
    expect(connecting).toBeLessThan(connected);
  });

  it('a persistent publish failure is reported, not hidden', async () => {
    const { types, sent } = await run(assignment([participant('pub', 'speaker', 'PUBFAIL')]));
    expect(types).toContain('publishFailed');
    expect(types).not.toContain('published');
    const states = sent.flatMap((m) => (m.type === 'publisherState' ? [m.state] : []));
    expect(states).toContain('failed');
  });
});
