import { MpAggregator } from '../mp/aggregate';
import { EVENT_CSV_HEADER, eventRow } from '../mp/csv';
import { WORKER_EXIT_CODE, type WorkerMessage } from '../mp/types';

const conn = (w: number, id: string): WorkerMessage => ({
  type: 'connected',
  workerId: w,
  participantId: id,
  role: 'listener',
});

describe('MP aggregator — phase gates', () => {
  it('phase A: publishersReady only after every publisher has published', () => {
    const agg = new MpAggregator(3, 1);
    agg.record({ type: 'connected', workerId: 0, participantId: 'pub', role: 'speaker' });
    expect(agg.publishersReady()).toBe(false);
    agg.record({ type: 'published', workerId: 0, participantId: 'pub' });
    expect(agg.publishersReady()).toBe(true);
  });

  it('phase B: full gate is EXACTLY requested connected + publishers published, zero failures', () => {
    const agg = new MpAggregator(3, 1);
    agg.record({ type: 'connected', workerId: 0, participantId: 'pub', role: 'speaker' });
    agg.record({ type: 'published', workerId: 0, participantId: 'pub' });
    agg.record(conn(1, 'a'));
    expect(agg.gateMet()).toBe(false); // 2/3 connected
    agg.record(conn(1, 'b'));
    expect(agg.connected()).toBe(3);
    expect(agg.gateMet()).toBe(true);
  });

  it('does not meet the gate while a required publisher is unpublished', () => {
    const agg = new MpAggregator(2, 1);
    agg.record({ type: 'connected', workerId: 0, participantId: 'pub', role: 'speaker' });
    agg.record(conn(1, 'a'));
    expect(agg.gateMet()).toBe(false);
    agg.record({ type: 'published', workerId: 0, participantId: 'pub' });
    expect(agg.gateMet()).toBe(true);
  });

  it('a single connect failure makes the run unreachable', () => {
    const agg = new MpAggregator(3, 0);
    agg.record(conn(0, 'a'));
    agg.record({ type: 'failed', workerId: 1, participantId: 'c', role: 'listener', error: 'x' });
    expect(agg.unreachable()).toEqual({
      yes: true,
      reason: expect.stringContaining('connect failure'),
    });
  });

  it('a publisher publish failure makes it unreachable (phase A abort)', () => {
    const agg = new MpAggregator(1, 1);
    agg.record({ type: 'connected', workerId: 0, participantId: 'pub', role: 'speaker' });
    agg.record({ type: 'publishFailed', workerId: 0, participantId: 'pub', error: 'timeout' });
    expect(agg.publishersReady()).toBe(false);
    expect(agg.unreachable()).toEqual({ yes: true, reason: 'publisher failed to publish' });
  });

  it('a worker crash makes it unreachable', () => {
    const agg = new MpAggregator(2, 0);
    agg.record({ type: 'fatal', workerId: 1, error: 'boom' });
    expect(agg.unreachable().yes).toBe(true);
    expect(agg.crashes()).toBe(1);
  });

  it('tracks publisher state transitions and ignores publishAttempt in the gate', () => {
    const agg = new MpAggregator(1, 1);
    for (const state of ['connecting', 'connected', 'publishing', 'published'] as const)
      agg.record({ type: 'publisherState', workerId: 0, participantId: 'pub', state });
    agg.record({ type: 'publishAttempt', workerId: 0, participantId: 'pub', attempt: 0 });
    expect(agg.publisherStateOf('pub')).toBe('published');
    expect(agg.connected()).toBe(0); // publishAttempt/publisherState are telemetry only
  });
});

describe('MP event CSV', () => {
  it('has the keyed header and formats rows (errors sanitized)', () => {
    expect(EVENT_CSV_HEADER).toBe('run_id,worker_id,participant_id,t_ms,event,state');
    const row = eventRow('mp-1', conn(2, 'p7'), 5, 1000).split(',');
    expect(row).toEqual(['mp-1', '2', 'p7', '1000', 'connected', 'connected=5']);
    const err = eventRow(
      'mp-1',
      {
        type: 'failed',
        workerId: 0,
        participantId: 'p1',
        role: 'listener',
        error: 'bad, thing\n2',
      },
      0,
      1000,
    );
    expect(err).not.toContain('\n2');
    expect(err).toContain('error:');
  });
});

describe('MP aggregator — teardown classification (P8.3.8)', () => {
  it('classifies each owned worker: cleaned, timed out, exited unclean, forced', () => {
    const agg = new MpAggregator(0, 0);
    // w1: cleaned + exit 0
    agg.record({ type: 'cleaned', workerId: 1 });
    agg.recordExit(1, WORKER_EXIT_CODE.cleaned, null);
    // w2: self-reported teardown timeout
    agg.record({ type: 'teardownTimeout', workerId: 2, pending: 3 });
    agg.recordExit(2, WORKER_EXIT_CODE.teardownTimeout, null);
    // w3: exited without reporting (e.g. died mid-teardown)
    agg.recordExit(3, null, 'SIGSEGV');
    // w4: still alive at the deadline -> forced kill
    agg.recordForcedKill(4);
    agg.recordExit(4, null, 'SIGKILL');
    expect(agg.teardownSummary([1, 2, 3, 4])).toEqual({
      workers: 4,
      cleaned: 1,
      timedOut: 1,
      exitedUnclean: 1,
      forced: 1,
    });
  });

  it('never counts a forced kill as cleaned, even if cleaned was sent first', () => {
    const agg = new MpAggregator(0, 0);
    agg.record({ type: 'cleaned', workerId: 1 });
    agg.recordForcedKill(1);
    agg.recordExit(1, null, 'SIGKILL');
    expect(agg.teardownSummary([1])).toMatchObject({ cleaned: 0, forced: 1 });
  });

  it('cleaned requires a clean exit code too', () => {
    const agg = new MpAggregator(0, 0);
    agg.record({ type: 'cleaned', workerId: 1 });
    agg.recordExit(1, WORKER_EXIT_CODE.fatal, null);
    expect(agg.teardownSummary([1])).toMatchObject({ cleaned: 0, exitedUnclean: 1 });
  });

  it('teardown messages do not affect the gate or failure counts', () => {
    const agg = new MpAggregator(1, 0);
    agg.record({ type: 'connected', workerId: 0, participantId: 'a', role: 'listener' });
    agg.record({ type: 'teardownStarted', workerId: 0, participants: 1 });
    agg.record({ type: 'teardownTimeout', workerId: 0, pending: 1 });
    expect(agg.gateMet()).toBe(true);
    expect(agg.unreachable().yes).toBe(false);
  });
});

describe('MP event CSV — publisher and teardown payloads (P8.3.8)', () => {
  it('serializes the actual PublisherState value', () => {
    for (const state of [
      'connecting',
      'connected',
      'publishing',
      'published',
      'disconnected',
    ] as const) {
      const row = eventRow(
        'r',
        { type: 'publisherState', workerId: 0, participantId: 'pub', state },
        1,
        1000,
      ).split(',');
      expect(row[4]).toBe('publisherState');
      expect(row[5]).toBe(`publisherState=${state}`);
    }
  });

  it('serializes attempt and teardown payloads', () => {
    const cell = (m: WorkerMessage) => eventRow('r', m, 0, 1000).split(',')[5];
    expect(cell({ type: 'publishAttempt', workerId: 0, participantId: 'p', attempt: 2 })).toBe(
      'attempt=2',
    );
    expect(cell({ type: 'teardownStarted', workerId: 3, participants: 10 })).toBe(
      'participants=10',
    );
    expect(cell({ type: 'teardownTimeout', workerId: 3, pending: 4 })).toBe('pending=4');
    expect(eventRow('r', { type: 'cleaned', workerId: 3 }, 9, 1000).split(',')[2]).toBe('worker');
  });
});
