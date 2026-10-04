import { MpAggregator } from '../mp/aggregate';
import { EVENT_CSV_HEADER, eventRow } from '../mp/csv';
import { type WorkerMessage } from '../mp/types';

const conn = (w: number, id: string): WorkerMessage => ({
  type: 'connected',
  workerId: w,
  participantId: id,
  role: 'listener',
});

describe('MP aggregator + exact gate', () => {
  it('gate is met only at EXACTLY requested, zero failures, publisher published', () => {
    const agg = new MpAggregator(3, true);
    agg.record(conn(0, 'a'));
    agg.record({ type: 'connected', workerId: 0, participantId: 'pub', role: 'speaker' });
    agg.record({ type: 'published', workerId: 0, participantId: 'pub' });
    expect(agg.gateMet()).toBe(false); // only 2 connected
    agg.record(conn(1, 'b'));
    expect(agg.connected()).toBe(3);
    expect(agg.gateMet()).toBe(true);
  });

  it('does not meet the gate if the publisher has not published', () => {
    const agg = new MpAggregator(2, true);
    agg.record(conn(0, 'a'));
    agg.record({ type: 'connected', workerId: 1, participantId: 'pub', role: 'speaker' });
    expect(agg.gateMet()).toBe(false);
    agg.record({ type: 'published', workerId: 1, participantId: 'pub' });
    expect(agg.gateMet()).toBe(true);
  });

  it('a single connect failure makes the run unreachable (never hold with fewer)', () => {
    const agg = new MpAggregator(3, false);
    agg.record(conn(0, 'a'));
    agg.record(conn(0, 'b'));
    agg.record({ type: 'failed', workerId: 1, participantId: 'c', role: 'listener', error: 'x' });
    expect(agg.gateMet()).toBe(false);
    expect(agg.unreachable()).toEqual({
      yes: true,
      reason: expect.stringContaining('connect failure'),
    });
  });

  it('a worker crash makes it unreachable', () => {
    const agg = new MpAggregator(2, false);
    agg.record(conn(0, 'a'));
    agg.record({ type: 'fatal', workerId: 1, error: 'boom' });
    expect(agg.unreachable().yes).toBe(true);
    expect(agg.crashes()).toBe(1);
  });

  it('a publisher publish failure makes it unreachable', () => {
    const agg = new MpAggregator(1, true);
    agg.record({ type: 'connected', workerId: 0, participantId: 'pub', role: 'speaker' });
    agg.record({ type: 'publishFailed', workerId: 0, participantId: 'pub', error: 'x' });
    expect(agg.unreachable()).toEqual({ yes: true, reason: 'publisher failed to publish' });
  });
});

describe('MP event CSV', () => {
  it('has the keyed header and formats rows (errors sanitized)', () => {
    expect(EVENT_CSV_HEADER).toBe('run_id,worker_id,participant_id,t_ms,event,state');
    const row = eventRow('mp-1', conn(2, 'p7'), 5, 1000).split(',');
    expect(row[0]).toBe('mp-1');
    expect(row[1]).toBe('2');
    expect(row[2]).toBe('p7');
    expect(row[4]).toBe('connected');
    expect(row[5]).toBe('connected=5');
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
    expect(err).not.toContain('\n2'); // newline/comma sanitized out of the field
    expect(err).toContain('error:');
  });
});
