import { mediaMetrics } from '../fleet/monitor';
import { MpAggregator } from '../mp/aggregate';
import { type MediaFaultKind, type MediaWindow, type WorkerMessage } from '../mp/types';
import { ABORT_SCHEMA } from '../observe/sample';
import {
  HOLD,
  INTERVAL,
  PUBLISHER,
  RUN,
  RUNG,
  genSample,
  monitorWith,
} from './support/monitor-fixtures';

// ---------------------------------------------------------------------------------------------
// mediaMetrics

const fault = (
  workerId: number,
  participantId: string,
  kind: MediaFaultKind,
  reason: string | null = null,
): WorkerMessage => ({ type: 'mediaFault', workerId, participantId, fault: kind, reason });

const mediaWindow = (workerId: number, w: Partial<MediaWindow> = {}): WorkerMessage => ({
  type: 'mediaWindow',
  workerId,
  window: {
    t: 0,
    listeners: 10,
    subscribed: 10,
    receiving: 10,
    stalled: 0,
    gaps: 0,
    packetsReceived: 1_000,
    packetsLost: 0,
    lossBands: { green: 10, yellow: 0, red: 0 },
    jitterMsMax: 4,
    loopLagMsP95: 3,
    ...w,
  },
});

/** An aggregator fed `events` as [message, receive time] pairs. */
function aggregatorWith(events: ReadonlyArray<readonly [WorkerMessage, number]>): MpAggregator {
  const agg = new MpAggregator(11, 1);
  for (const [msg, at] of events) agg.record(msg, at);
  return agg;
}

describe('fleet/monitor — mediaMetrics', () => {
  it('counts nothing, and leaves the loss metrics missing, before any media evidence', () => {
    expect(mediaMetrics(aggregatorWith([]), PUBLISHER, HOLD)).toEqual({
      mConnectFailures: 0,
      mPublisherFaults: 0,
      mStalls: 0,
      mDrops: 0,
      mReconnects: 0,
      mLossFleetRatio: null,
      mLossListenersRed: null,
      mLossListenersYellow: null,
    });
  });

  it('counts disconnects, unsubscribes, subscription failures and publisher loss as drops — except DUPLICATE_IDENTITY', () => {
    const at = HOLD + 1;
    const agg = aggregatorWith([
      [fault(1, 'L1', 'disconnected', 'SIGNAL_CLOSE'), at],
      [fault(1, 'L2', 'disconnected', 'DUPLICATE_IDENTITY'), at],
      [fault(1, 'L3', 'disconnected', null), at],
      [fault(2, 'L4', 'unsubscribed'), at],
      [fault(2, 'L5', 'subscriptionFailed'), at],
      [fault(2, 'L6', 'publisherGone'), at],
      [fault(2, 'L7', 'reconnecting'), at],
      [fault(2, 'L8', 'stall'), at],
    ]);
    expect(mediaMetrics(agg, PUBLISHER, HOLD).mDrops).toBe(5);
  });

  it('a DUPLICATE_IDENTITY disconnect alone is no drop (V-dup judges it)', () => {
    const agg = aggregatorWith([[fault(1, 'L1', 'disconnected', 'DUPLICATE_IDENTITY'), HOLD]]);
    expect(mediaMetrics(agg, PUBLISHER, HOLD)).toMatchObject({ mDrops: 0, mPublisherFaults: 0 });
  });

  it('counts stalls and completed reconnects separately from drops', () => {
    const agg = aggregatorWith([
      [fault(1, 'L1', 'stall'), HOLD + 1],
      [fault(1, 'L2', 'stall'), HOLD + 2],
      [fault(2, 'L3', 'reconnecting'), HOLD + 3],
      [fault(2, 'L3', 'reconnected'), HOLD + 4],
    ]);
    expect(mediaMetrics(agg, PUBLISHER, HOLD)).toMatchObject({
      mStalls: 2,
      mReconnects: 1,
      mDrops: 0,
    });
  });

  it('counts only faults received at or after `since`', () => {
    const agg = aggregatorWith([
      [fault(1, 'L1', 'stall'), HOLD - 1],
      [fault(1, 'L2', 'disconnected', 'SIGNAL_CLOSE'), HOLD - 500],
      [fault(1, 'L3', 'reconnected'), HOLD - 1],
      [fault(1, 'L4', 'stall'), HOLD],
    ]);
    expect(mediaMetrics(agg, PUBLISHER, HOLD)).toMatchObject({
      mStalls: 1,
      mDrops: 0,
      mReconnects: 0,
    });
  });

  it('takes fleet loss and listener loss bands from each worker’s latest window since `since`', () => {
    const agg = aggregatorWith([
      // before the hold: ignored
      [
        mediaWindow(1, {
          packetsReceived: 0,
          packetsLost: 1_000,
          lossBands: { green: 0, yellow: 0, red: 10 },
        }),
        HOLD - 1,
      ],
      // superseded by worker 1's later window
      [
        mediaWindow(1, {
          packetsReceived: 500,
          packetsLost: 500,
          lossBands: { green: 0, yellow: 5, red: 5 },
        }),
        HOLD + 1_000,
      ],
      [
        mediaWindow(1, {
          packetsReceived: 990,
          packetsLost: 10,
          lossBands: { green: 9, yellow: 1, red: 0 },
        }),
        HOLD + 2_000,
      ],
      [
        mediaWindow(2, {
          packetsReceived: 970,
          packetsLost: 30,
          lossBands: { green: 9, yellow: 0, red: 1 },
        }),
        HOLD + 1_500,
      ],
    ]);
    const m = mediaMetrics(agg, PUBLISHER, HOLD);
    expect(m.mLossFleetRatio).toBeCloseTo(40 / 2_000, 12);
    expect(m.mLossListenersRed).toBe(1);
    expect(m.mLossListenersYellow).toBe(1);
  });

  it('leaves the fleet ratio missing when the windows carry no packets, but still counts bands', () => {
    const agg = aggregatorWith([[mediaWindow(1, { packetsReceived: 0, packetsLost: 0 }), HOLD]]);
    expect(mediaMetrics(agg, PUBLISHER, HOLD)).toMatchObject({
      mLossFleetRatio: null,
      mLossListenersRed: 0,
      mLossListenersYellow: 0,
    });
  });

  it('leaves every loss metric missing when no window arrived since `since`', () => {
    const agg = aggregatorWith([[mediaWindow(1, { packetsLost: 900 }), HOLD - 1]]);
    expect(mediaMetrics(agg, PUBLISHER, HOLD)).toMatchObject({
      mLossFleetRatio: null,
      mLossListenersRed: null,
      mLossListenersYellow: null,
    });
  });

  it('counts publisher faults only for the publisher identity, never its completed reconnect', () => {
    const agg = aggregatorWith([
      [fault(0, PUBLISHER, 'stall'), HOLD + 1],
      [fault(0, PUBLISHER, 'disconnected', 'SIGNAL_CLOSE'), HOLD + 2],
      [fault(0, PUBLISHER, 'reconnected'), HOLD + 3],
      [fault(0, PUBLISHER, 'stall'), HOLD - 1], // before the hold
      [fault(1, 'p84-01234567-L00001', 'disconnected', 'SIGNAL_CLOSE'), HOLD + 1],
      [fault(1, 'p84-01234567-L00002', 'stall'), HOLD + 1],
    ]);
    expect(mediaMetrics(agg, PUBLISHER, HOLD)).toMatchObject({
      mPublisherFaults: 2,
      mStalls: 2,
      mDrops: 2,
    });
  });

  it('reports connect failures from the aggregator', () => {
    const agg = aggregatorWith([
      [{ type: 'failed', workerId: 1, participantId: 'L1', role: 'listener', error: 'x' }, HOLD],
      [{ type: 'failed', workerId: 2, participantId: 'L2', role: 'listener', error: 'y' }, HOLD],
    ]);
    expect(mediaMetrics(agg, PUBLISHER, HOLD).mConnectFailures).toBe(2);
  });
});

describe('fleet/monitor — media rules', () => {
  it('a drop is a media RED raised by the controller', () => {
    const { monitor, aborts } = monitorWith(null);
    const agg = aggregatorWith([
      [mediaWindow(1), HOLD + 1],
      [fault(1, 'L1', 'disconnected', 'SIGNAL_CLOSE'), HOLD + 2],
    ]);
    monitor.evaluateMedia(HOLD + INTERVAL, mediaMetrics(agg, PUBLISHER, HOLD));
    expect(aborts).toEqual([
      {
        schema: ABORT_SCHEMA,
        runId: RUN,
        rung: RUNG,
        at: HOLD + INTERVAL,
        source: 'controller',
        rule: 'M-drop',
        observed: { value: 1, unit: 'events', samples: [1] },
        threshold: { op: '>', value: 0, sustain: 'instant' },
        classHint: null,
        validity: false,
        detail: 'M-drop > 0 (instant)',
      },
    ]);
    expect(monitor.fired).toMatchObject([{ ruleId: 'M-drop', scope: 'media', host: 'fleet' }]);
  });

  it('a DUPLICATE_IDENTITY eviction alone raises nothing', () => {
    const { monitor, aborts } = monitorWith(null);
    const agg = aggregatorWith([
      [mediaWindow(1), HOLD + 1],
      [fault(1, 'L1', 'disconnected', 'DUPLICATE_IDENTITY'), HOLD + 2],
    ]);
    monitor.evaluateMedia(HOLD + INTERVAL, mediaMetrics(agg, PUBLISHER, HOLD));
    expect(aborts).toEqual([]);
    expect(monitor.notGreen).toEqual([]);
    expect([...monitor.missing]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// RunMonitor — generator samples

describe('fleet/monitor — generator warm-up and judging', () => {
  it('warm-up: judges neither the first sample nor any before the first lag window; judgedAgents follows', () => {
    const { monitor, aborts } = monitorWith(null);
    monitor.addGeneratorSample(0, genSample(0), 0, null);
    expect(monitor.genSamples.get(0)).toHaveLength(1);
    expect(monitor.judgedAgents.size).toBe(0);
    monitor.addGeneratorSample(0, genSample(1), 0, null);
    expect(monitor.genSamples.get(0)).toHaveLength(2);
    expect(monitor.judgedAgents.size).toBe(0);
    // Unjudged samples are evidence only: nothing missing, nothing banded.
    expect([...monitor.missing]).toEqual([]);
    expect(monitor.notGreen).toEqual([]);

    monitor.addGeneratorSample(0, genSample(2), 0, 12);
    expect([...monitor.judgedAgents]).toEqual([0]);
    expect([...monitor.missing]).toEqual([]); // every generator metric was present
    expect(monitor.notGreen).toEqual([]);
    expect(aborts).toEqual([]);
  });

  it('after warm-up, a sample with no new lag window is still judged on everything but G-lag', () => {
    const { monitor, aborts } = monitorWith(null);
    monitor.addGeneratorSample(0, genSample(0), 0, 12);
    monitor.addGeneratorSample(0, genSample(1), 0, 12);
    const stray = {
      gen: {
        ...genSample(2).gen!,
        processGroup: { members: 4, workers: 2, helpers: 0, unexplained: 1 },
      },
    };
    monitor.addGeneratorSample(0, genSample(2, stray), 0, null); // no new window
    expect([...monitor.missing]).toEqual([]); // G-lag unobserved, not missing
    expect(aborts).toMatchObject([{ rule: 'G-proc' }]); // the other rules still ran
  });

  it('a crash reported with the first sample is not judged; the first judged sample fires G-proc', () => {
    const { monitor, aborts } = monitorWith(null);
    monitor.addGeneratorSample(0, genSample(0), 1, 12);
    expect(aborts).toEqual([]);
    monitor.addGeneratorSample(0, genSample(1), 1, 12);
    expect(aborts).toEqual([
      {
        schema: ABORT_SCHEMA,
        runId: RUN,
        rung: RUNG,
        at: INTERVAL,
        source: 'gen-watchdog:gen-1',
        rule: 'G-proc',
        observed: { value: 1, unit: 'workers', samples: [1] },
        threshold: { op: '>', value: 0, sustain: 'instant' },
        classHint: 'A',
        validity: true,
        detail: 'G-proc > 0 (instant)',
      },
    ]);
    expect(monitor.fired).toMatchObject([{ ruleId: 'G-proc', scope: 'generator', host: 'gen-1' }]);
  });

  it('regression: one lag spike followed by samples without a new window is never a sustained RED', () => {
    // Captured intermittent failure: a single 392 ms window was re-judged on every later sample
    // ("G-lag > 200 (4 consecutive samples)", samples [392, 392, 392, 392]) → a safety abort.
    const { monitor, aborts } = monitorWith(null);
    monitor.addGeneratorSample(0, genSample(0), 0, 12);
    monitor.addGeneratorSample(0, genSample(1), 0, 392);
    for (let i = 2; i < 8; i += 1) monitor.addGeneratorSample(0, genSample(i), 0, null);
    expect(aborts).toEqual([]);
    expect(monitor.fired).toEqual([]);
    expect([...monitor.missing]).toEqual([]); // unobserved, not missing
    expect(monitor.notGreen.filter((o) => o.ruleId === 'G-lag')).toHaveLength(1);
    // Four FRESH windows over the RED edge are still a sustained RED.
    for (let i = 8; i < 11; i += 1) monitor.addGeneratorSample(0, genSample(i), 0, 392);
    expect(aborts).toMatchObject([{ rule: 'G-lag', observed: { samples: [392, 392, 392, 392] } }]);
  });

  it('an unexplained process in the agent’s group fires G-proc', () => {
    const { monitor, aborts } = monitorWith(null);
    const stray = {
      gen: {
        ...genSample(1).gen!,
        processGroup: { members: 4, workers: 2, helpers: 0, unexplained: 1 },
      },
    };
    monitor.addGeneratorSample(0, genSample(0), 0, 12);
    monitor.addGeneratorSample(0, genSample(1, stray), 0, 12);
    expect(aborts).toMatchObject([
      { rule: 'G-proc', observed: { value: 1, unit: 'processes' }, validity: true },
    ]);
  });

  it('keeps a separate sustain streak per agent', () => {
    const { monitor, aborts } = monitorWith(null);
    const g2 = { host: 'gen-2' };
    monitor.addGeneratorSample(0, genSample(0), 0, 300);
    monitor.addGeneratorSample(1, genSample(0, g2), 0, 300);
    // G-lag is a gauge: RED after 4 consecutive samples over 200 ms — per agent, not fleet-wide.
    for (let i = 1; i <= 3; i += 1) {
      monitor.addGeneratorSample(0, genSample(i), 0, 300);
      monitor.addGeneratorSample(1, genSample(i, g2), 0, 300);
    }
    expect(aborts).toEqual([]);
    expect(monitor.notGreen.filter((o) => o.ruleId === 'G-lag')).toHaveLength(6);
    expect(monitor.notGreen.every((o) => o.scope === 'generator' && o.overRed)).toBe(true);
    monitor.addGeneratorSample(0, genSample(4), 0, 300);
    expect(aborts).toMatchObject([
      {
        source: 'gen-watchdog:gen-1',
        rule: 'G-lag',
        at: 4 * INTERVAL,
        observed: { value: 300, unit: 'ms', samples: [300, 300, 300, 300] },
        threshold: { op: '>', value: 200, sustain: '4 consecutive samples' },
      },
    ]);
    expect([...monitor.judgedAgents].sort()).toEqual([0, 1]);
  });

  it('records a missing generator metric per host (fail closed), without firing', () => {
    const { monitor, aborts } = monitorWith(null);
    const blind = { clockOffsetMs: null, gen: { ...genSample(1).gen!, processGroup: null } };
    monitor.addGeneratorSample(0, genSample(0), 0, 12);
    monitor.addGeneratorSample(0, genSample(1, blind), 0, 12);
    expect([...monitor.missing].sort()).toEqual(['gen-1:G-clock', 'gen-1:G-proc']);
    expect(aborts).toEqual([]);
  });
});
