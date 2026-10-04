import { PassThrough, Writable } from 'node:stream';

import { FleetSession, type SessionHandlers } from '../fleet/session';
import { type ProcessManager } from '../mp/process-manager';

/** An agent stdin whose process is gone: every write fails asynchronously with EPIPE. */
const deadStdin = (): Writable =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });

function sessionWithDeadAgent(): { session: FleetSession; lost: string[] } {
  const pm = {
    spawn: () => ({ child: { stdin: deadStdin(), stdout: new PassThrough() } }),
  } as unknown as ProcessManager;
  const lost: string[] = [];
  const handlers: SessionHandlers = {
    onWorker: () => undefined,
    onExit: () => undefined,
    onSample: () => undefined,
    onAbort: () => undefined,
    onLost: (agent, why) => lost.push(`${agent}: ${why}`),
  };
  const session = new FleetSession(pm, handlers);
  session.start(
    [{ kind: 'local', workerModule: 'unused', runsDir: 'unused' }],
    '0123456789abcdef',
    {},
  );
  return { session, lost };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('fleet/session — a write to an agent that is gone', () => {
  it('regression: EPIPE on an agent stdin is a lost link, never an uncaught exception', async () => {
    // Captured in a full-suite run: "write EPIPE" thrown from writeMessage while an agent exited.
    const { session, lost } = sessionWithDeadAgent();
    session.admit(0, 1, {
      identity: 'p84-01234567-L00000',
      room: 'loadtest-p84-0123456789abcdef',
      role: 'listener',
      ticket: { url: 'wss://sut.invalid', token: 't' },
    });
    await settle();
    expect(lost).toEqual(['0: agent stdin: EPIPE']);
    session.admit(0, 1, {
      identity: 'p84-01234567-L00001',
      room: 'loadtest-p84-0123456789abcdef',
      role: 'listener',
      ticket: { url: 'wss://sut.invalid', token: 't' },
    });
    await settle();
    expect(lost).toHaveLength(1); // the link is marked ended: nothing more is written to it
  });
});
