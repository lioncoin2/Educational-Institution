import { type MediaStatsSnapshot, type SelectedPair } from '../mp/driver';
import {
  classifyTransport,
  lossBand,
  type StepResult,
  stepParticipant,
  transportProblems,
  WindowAccumulator,
} from '../mp/media-health';
import { type TransportReport } from '../mp/types';

const WINDOW = 5000;
const NOW = 1_700_000_100_000;
const OPTS = { windowMs: WINDOW, nowMs: NOW };
const BANDS = { green: 0.005, red: 0.02 };

const pair = (over: Partial<SelectedPair> = {}): SelectedPair => ({
  protocol: 'udp',
  localType: 'host',
  remoteType: 'host',
  remotePort: 7882,
  lastPacketReceivedMs: null,
  ...over,
});

const snap = (
  statsTsMs: number,
  received: number | null,
  lost = 0,
  over: Partial<MediaStatsSnapshot> = {},
): MediaStatsSnapshot => ({
  statsTsMs,
  inbound:
    received === null ? null : { packetsReceived: received, packetsLost: lost, jitterSec: 0.004 },
  outbound: null,
  selectedPair: pair(),
  localCandidateTypes: ['host'],
  ...over,
});

const PREV = snap(NOW - WINDOW, 1000, 10);
const GAP: StepResult = {
  kind: 'gap',
  receivedDelta: 0,
  lostDelta: 0,
  lossRatio: null,
  jitterMs: null,
};

describe('media health — stepParticipant', () => {
  it('first: no previous reading, or no inbound baseline yet', () => {
    const first = { kind: 'first', receivedDelta: 0, lostDelta: 0, lossRatio: null, jitterMs: 4 };
    expect(stepParticipant(null, snap(NOW, 250), OPTS)).toEqual(first);
    expect(stepParticipant(snap(NOW - WINDOW, null), snap(NOW, 250), OPTS)).toEqual(first);
    expect(stepParticipant(null, snap(NOW, null), OPTS)).toMatchObject({
      kind: 'first',
      jitterMs: null,
    });
  });

  it('ok: deltas, loss ratio and jitter between two readings', () => {
    expect(stepParticipant(PREV, snap(NOW, 1240, 20), OPTS)).toEqual({
      kind: 'ok',
      receivedDelta: 240,
      lostDelta: 10,
      lossRatio: 0.04,
      jitterMs: 4,
    });
  });

  it('stall: no packet between two successful readings a full window apart', () => {
    expect(stepParticipant(PREV, snap(NOW, 1000, 10), OPTS)).toEqual({
      kind: 'stall',
      receivedDelta: 0,
      lostDelta: 0,
      lossRatio: null,
      jitterMs: 4,
    });
    expect(stepParticipant(PREV, snap(NOW, 1000, 60), OPTS)).toMatchObject({
      kind: 'stall',
      lossRatio: 1,
    });
  });

  it('stall: the selected pair confirms no packet for a window', () => {
    const quiet = snap(NOW, 1000, 10, {
      selectedPair: pair({ lastPacketReceivedMs: NOW - WINDOW }),
    });
    expect(stepParticipant(PREV, quiet, OPTS).kind).toBe('stall');
  });

  it('lastPacketReceived cross-check prevents a false stall', () => {
    const recent = snap(NOW, 1000, 10, {
      selectedPair: pair({ lastPacketReceivedMs: NOW - WINDOW + 1 }),
    });
    expect(stepParticipant(PREV, recent, OPTS).kind).toBe('ok');
  });

  it('no stall when the readings are less than a window apart', () => {
    const early = snap(NOW - WINDOW + 1, 1000, 10);
    expect(stepParticipant(snap(NOW - 2 * WINDOW + 2, 1000, 10), early, OPTS).kind).toBe('ok');
  });

  it('gap: a missing sample is never a stall', () => {
    expect(stepParticipant(PREV, null, OPTS)).toEqual(GAP);
    expect(stepParticipant(null, null, OPTS)).toEqual(GAP);
  });

  it('gap: a late sample (older than two windows), even with no baseline', () => {
    const late = NOW - 2 * WINDOW - 1;
    expect(stepParticipant(snap(late - WINDOW, 1000), snap(late, 1000), OPTS)).toEqual(GAP);
    expect(stepParticipant(null, snap(late, 1000), OPTS)).toEqual(GAP);
    const edge = NOW - 2 * WINDOW;
    expect(stepParticipant(snap(edge - WINDOW, 1000), snap(edge, 1250), OPTS).kind).toBe('ok');
  });

  it('gap: a reading not newer than the previous one', () => {
    expect(stepParticipant(snap(NOW, 1000), snap(NOW, 1000), OPTS)).toEqual(GAP);
    expect(stepParticipant(snap(NOW, 1000), snap(NOW - 1, 1000), OPTS)).toEqual(GAP);
  });

  it('gap: a counter reset (packetsReceived backwards, or the inbound stream vanished)', () => {
    expect(stepParticipant(PREV, snap(NOW, 5, 10), OPTS)).toEqual(GAP);
    expect(stepParticipant(PREV, snap(NOW, null), OPTS)).toEqual(GAP);
  });

  it('a packetsLost step down (late/duplicate packets, W3C estimate) is not a gap: lost delta 0', () => {
    expect(stepParticipant(PREV, snap(NOW, 1250, 0), OPTS)).toMatchObject({
      kind: 'ok',
      receivedDelta: 250,
      lostDelta: 0,
      lossRatio: 0,
    });
  });
});

describe('media health — lossBand', () => {
  it('bands on the passed-in edges: green below, red above, yellow between inclusive', () => {
    expect(lossBand(null, BANDS)).toBeNull();
    expect(lossBand(0, BANDS)).toBe('green');
    expect(lossBand(0.0049, BANDS)).toBe('green');
    expect(lossBand(0.005, BANDS)).toBe('yellow');
    expect(lossBand(0.02, BANDS)).toBe('yellow');
    expect(lossBand(0.0201, BANDS)).toBe('red');
    expect(lossBand(1, BANDS)).toBe('red');
  });

  it('hard-codes no threshold', () => {
    const wide = { green: 0.1, red: 0.3 };
    expect(lossBand(0.05, wide)).toBe('green');
    expect(lossBand(0.2, wide)).toBe('yellow');
    expect(lossBand(0.31, wide)).toBe('red');
  });
});

describe('media health — classifyTransport', () => {
  it('is null until a pair is selected', () => {
    expect(classifyTransport(snap(NOW, 0, 0, { selectedPair: null }))).toBeNull();
  });

  it('copies the selected pair and the deduplicated, sorted gathered types', () => {
    const s = snap(NOW, 0, 0, {
      selectedPair: pair({ localType: 'srflx', lastPacketReceivedMs: NOW }),
      localCandidateTypes: ['srflx', 'host', 'host', 'prflx', 'srflx'],
    });
    expect(classifyTransport(s)).toEqual({
      protocol: 'udp',
      localType: 'srflx',
      remoteType: 'host',
      remotePort: 7882,
      localCandidateTypes: ['host', 'prflx', 'srflx'],
    });
  });
});

describe('media health — transportProblems (T2)', () => {
  const report = (over: Partial<TransportReport> = {}): TransportReport => ({
    protocol: 'udp',
    localType: 'host',
    remoteType: 'host',
    remotePort: 7882,
    localCandidateTypes: ['host', 'srflx'],
    ...over,
  });
  const turnFree = { mode: 'turn-free', udpPort: 7882 } as const;
  const relay = { mode: 'relay', udpPort: 7882 } as const;

  it('turn-free: a direct udp pair to the SUT port is proven', () => {
    expect(transportProblems(report(), turnFree)).toEqual([]);
    for (const localType of ['srflx', 'prflx'] as const)
      expect(transportProblems(report({ localType }), turnFree)).toEqual([]);
  });

  it('turn-free: a gathered relay candidate fails even when not selected', () => {
    const r = report({ localCandidateTypes: ['host', 'relay'] });
    expect(transportProblems(r, turnFree)).toEqual(['relay local candidate gathered']);
  });

  it('turn-free: tcp selected', () => {
    expect(transportProblems(report({ protocol: 'tcp' }), turnFree)).toEqual([
      'selected protocol tcp, expected udp',
    ]);
  });

  it('turn-free: a relay or unclassified local, or relay remote, candidate selected', () => {
    expect(transportProblems(report({ localType: 'relay' }), turnFree)).toEqual([
      'selected local candidate relay, expected host/srflx/prflx',
    ]);
    expect(transportProblems(report({ localType: 'unknown' }), turnFree)).toEqual([
      'selected local candidate unknown, expected host/srflx/prflx',
    ]);
    expect(transportProblems(report({ remoteType: 'relay' }), turnFree)).toEqual([
      'selected remote candidate relay',
    ]);
  });

  it('turn-free: wrong or unknown remote port', () => {
    expect(transportProblems(report({ remotePort: 3478 }), turnFree)).toEqual([
      'selected remote port 3478, expected 7882',
    ]);
    expect(transportProblems(report({ remotePort: null }), turnFree)).toEqual([
      'selected remote port unknown, expected 7882',
    ]);
  });

  it('turn-free: an E2-style relayed session reports every violation', () => {
    const e2 = report({
      protocol: 'tcp',
      localType: 'relay',
      remotePort: 3478,
      localCandidateTypes: ['host', 'relay', 'srflx'],
    });
    expect(transportProblems(e2, turnFree)).toHaveLength(4);
  });

  it('relay positive control: only a relay local candidate proves the detector', () => {
    const relayed = report({
      localType: 'relay',
      remotePort: 3478,
      localCandidateTypes: ['host', 'relay'],
    });
    expect(transportProblems(relayed, relay)).toEqual([]);
    expect(transportProblems(report(), relay)).toEqual([
      'selected local candidate host, expected relay',
    ]);
  });
});

describe('media health — WindowAccumulator', () => {
  const live = { subscribed: true, receiving: true };
  const ok = (received: number, lost = 0, jitterMs: number | null = 3): StepResult => ({
    kind: 'ok',
    receivedDelta: received,
    lostDelta: lost,
    lossRatio: received + lost === 0 ? null : lost / (received + lost),
    jitterMs,
  });

  it('aggregates one window and passes t and listeners through', () => {
    const acc = new WindowAccumulator(BANDS);
    acc.addStep('a', ok(250, 0, 7), live);
    acc.addStep('b', { ...ok(0), kind: 'stall' }, { subscribed: true, receiving: false });
    acc.addStep('c', GAP, { subscribed: false, receiving: false });
    acc.addStep('d', ok(248, 2, null), live);
    expect(acc.flush(1000, 5)).toEqual({
      t: 1000,
      listeners: 5,
      subscribed: 3,
      receiving: 2,
      stalled: 1,
      gaps: 1,
      packetsReceived: 498,
      packetsLost: 2,
      lossBands: { green: 1, yellow: 1, red: 0 },
      jitterMsMax: 7,
      loopLagMsP95: 0,
    });
  });

  it('counts one degraded listener red although the fleet ratio is green', () => {
    const acc = new WindowAccumulator(BANDS);
    for (let i = 0; i < 99; i += 1) acc.addStep(`l${i}`, ok(250), live);
    acc.addStep('degraded', ok(225, 25), live);
    const w = acc.flush(5000, 100);
    expect(lossBand(w.packetsLost / (w.packetsReceived + w.packetsLost), BANDS)).toBe('green');
    expect(w.lossBands).toEqual({ green: 99, yellow: 0, red: 1 });
  });

  it('merges a listener stepped twice: summed loss, latest state, sticky stall', () => {
    const acc = new WindowAccumulator(BANDS);
    acc.addStep('a', { ...ok(0), kind: 'stall' }, { subscribed: true, receiving: false });
    acc.addStep('a', ok(195, 5), live);
    expect(acc.flush(0, 1)).toMatchObject({
      subscribed: 1,
      receiving: 1,
      stalled: 1,
      packetsReceived: 195,
      packetsLost: 5,
      lossBands: { green: 0, yellow: 0, red: 1 },
    });
  });

  it('loop lag p95 is nearest-rank over the window samples', () => {
    const acc = new WindowAccumulator(BANDS);
    for (let ms = 20; ms >= 1; ms -= 1) acc.addLoopLag(ms);
    expect(acc.flush(0, 0).loopLagMsP95).toBe(19);
    for (const ms of [9, 1, 8, 2, 7, 3, 6, 4, 5, 250]) acc.addLoopLag(ms);
    expect(acc.flush(0, 0).loopLagMsP95).toBe(250);
    acc.addLoopLag(42);
    expect(acc.flush(0, 0).loopLagMsP95).toBe(42);
  });

  it('flush resets every accumulator', () => {
    const acc = new WindowAccumulator(BANDS);
    acc.addStep('a', ok(250, 10, 9), live);
    acc.addStep('b', GAP, live);
    acc.addLoopLag(80);
    acc.flush(0, 2);
    expect(acc.flush(5000, 2)).toEqual({
      t: 5000,
      listeners: 2,
      subscribed: 0,
      receiving: 0,
      stalled: 0,
      gaps: 0,
      packetsReceived: 0,
      packetsLost: 0,
      lossBands: { green: 0, yellow: 0, red: 0 },
      jitterMsMax: 0,
      loopLagMsP95: 0,
    });
  });

  it('folds real steps from stepParticipant', () => {
    const acc = new WindowAccumulator(BANDS);
    acc.addStep('a', stepParticipant(PREV, snap(NOW, 1250, 10), OPTS), live);
    acc.addStep('b', stepParticipant(PREV, snap(NOW, 1000, 10), OPTS), live);
    acc.addStep('c', stepParticipant(PREV, null, OPTS), live);
    expect(acc.flush(NOW, 3)).toMatchObject({
      stalled: 1,
      gaps: 1,
      packetsReceived: 250,
      packetsLost: 0,
      lossBands: { green: 1, yellow: 0, red: 0 },
      jitterMsMax: 4,
    });
  });
});
