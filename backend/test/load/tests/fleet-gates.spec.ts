import { type Role } from '../core/identity';
import {
  clientGateProblems,
  type GateExpectation,
  serverIdentityProblems,
  transportGateProblems,
} from '../fleet/gates';
import { type RunParticipant } from '../livekit/room-ops';
import { MpAggregator } from '../mp/aggregate';
import { type TransportReport, type WorkerMessage } from '../mp/types';

/**
 * fleet/gates.ts — the global exact-N gate (design §7) as pure checks: the
 * SFU's own participant list against the minted set, and the controller's
 * single aggregator fed real WorkerMessages (connected is not healthy).
 */

const PUB = 'p84-gates-P00000';
const L = (k: number): string => `p84-gates-L${String(k).padStart(5, '0')}`;
const MINTED: ReadonlySet<string> = new Set([PUB, L(1), L(2)]);

const TURN_FREE: GateExpectation = {
  requested: 3,
  publisher: PUB,
  ice: 'turn-free',
  udpPort: 7882,
};
const RELAY: GateExpectation = { ...TURN_FREE, ice: 'relay' };

// --- server side -------------------------------------------------------------

const sfu = (identity: string, over: Partial<RunParticipant> = {}): RunParticipant => ({
  identity,
  active: true,
  audioTracks: identity === PUB ? 1 : 0,
  ...over,
});
const HEALTHY_SFU: readonly RunParticipant[] = [sfu(PUB), sfu(L(1)), sfu(L(2))];

const PUB_TRACK = 'publisher does not hold exactly one audio track';

describe('fleet/gates — serverIdentityProblems', () => {
  it('exactly the minted set, all ACTIVE, publisher with one audio track → no problem', () => {
    expect(serverIdentityProblems(HEALTHY_SFU, MINTED, PUB)).toEqual([]);
    expect(serverIdentityProblems([...HEALTHY_SFU].reverse(), MINTED, PUB)).toEqual([]);
  });

  it('an identity nobody minted is extra', () => {
    expect(serverIdentityProblems([...HEALTHY_SFU, sfu('intruder')], MINTED, PUB)).toEqual([
      '1 unexpected identities on the SFU',
    ]);
  });

  it('a minted identity the SFU does not list is missing', () => {
    expect(serverIdentityProblems([sfu(PUB), sfu(L(1))], MINTED, PUB)).toEqual([
      '1 minted identities missing on the SFU',
    ]);
  });

  it('a swapped identity (same count) is both extra and missing — counts alone are not enough', () => {
    expect(serverIdentityProblems([sfu(PUB), sfu(L(1)), sfu(L(9))], MINTED, PUB)).toEqual([
      '1 unexpected identities on the SFU',
      '1 minted identities missing on the SFU',
    ]);
  });

  it('counts every participant that is not ACTIVE', () => {
    const list = [sfu(PUB), sfu(L(1), { active: false }), sfu(L(2), { active: false })];
    expect(serverIdentityProblems(list, MINTED, PUB)).toEqual(['2 participants not ACTIVE']);
  });

  it.each([0, 2])('a publisher holding %i audio tracks fails', (audioTracks) => {
    const list = [sfu(PUB, { audioTracks }), sfu(L(1)), sfu(L(2))];
    expect(serverIdentityProblems(list, MINTED, PUB)).toEqual([PUB_TRACK]);
  });

  it('a publisher absent from the SFU is missing and holds no track', () => {
    expect(serverIdentityProblems([sfu(L(1)), sfu(L(2))], MINTED, PUB)).toEqual([
      '1 minted identities missing on the SFU',
      PUB_TRACK,
    ]);
  });

  it('an empty participant list: every minted identity missing', () => {
    expect(serverIdentityProblems([], MINTED, PUB)).toEqual([
      '3 minted identities missing on the SFU',
      PUB_TRACK,
    ]);
  });

  it('reports every problem at once, in a stable order', () => {
    const list = [sfu(PUB, { active: false, audioTracks: 0 }), sfu('intruder')];
    expect(serverIdentityProblems(list, MINTED, PUB)).toEqual([
      '1 unexpected identities on the SFU',
      '2 minted identities missing on the SFU',
      '1 participants not ACTIVE',
      PUB_TRACK,
    ]);
  });
});

// --- client side (the single aggregator) -------------------------------------

const connected = (workerId: number, participantId: string, role: Role = 'listener') =>
  ({ type: 'connected', workerId, participantId, role }) satisfies WorkerMessage;
const failed = (workerId: number, participantId: string) =>
  ({
    type: 'failed',
    workerId,
    participantId,
    role: 'listener',
    error: 'join timeout',
  }) satisfies WorkerMessage;
const published = (workerId: number, participantId: string) =>
  ({ type: 'published', workerId, participantId, trackSid: 'TR_pub' }) satisfies WorkerMessage;
const subscribed = (workerId: number, participantId: string) =>
  ({ type: 'subscribed', workerId, participantId, trackSid: 'TR_pub' }) satisfies WorkerMessage;
const receiving = (workerId: number, participantId: string) =>
  ({ type: 'receiving', workerId, participantId }) satisfies WorkerMessage;
const fatal = (workerId: number) =>
  ({ type: 'fatal', workerId, error: 'boom' }) satisfies WorkerMessage;

function aggregator(...msgs: WorkerMessage[]): MpAggregator {
  const agg = new MpAggregator(TURN_FREE.requested, 1);
  for (const m of msgs) agg.record(m, 1_000);
  return agg;
}

/** Publisher on worker 0 connected and published; both listeners on worker 1 up and receiving. */
const HEALTHY_CLIENT: readonly WorkerMessage[] = [
  connected(0, PUB, 'speaker'),
  published(0, PUB),
  connected(1, L(1)),
  subscribed(1, L(1)),
  receiving(1, L(1)),
  connected(1, L(2)),
  subscribed(1, L(2)),
  receiving(1, L(2)),
];

describe('fleet/gates — clientGateProblems', () => {
  it('N connected, publisher published, N−1 subscribed and receiving → no problem', () => {
    expect(clientGateProblems(aggregator(...HEALTHY_CLIENT), TURN_FREE)).toEqual([]);
  });

  it('a publisher-only rung (N = 1) needs no listener', () => {
    const agg = aggregator(connected(0, PUB, 'speaker'), published(0, PUB));
    expect(clientGateProblems(agg, { ...TURN_FREE, requested: 1 })).toEqual([]);
  });

  it('connected is exact-N: one more than requested fails too', () => {
    const agg = aggregator(...HEALTHY_CLIENT, connected(2, L(3)));
    expect(clientGateProblems(agg, TURN_FREE)).toEqual(['connected 4/3']);
  });

  it('fewer connected than requested', () => {
    const agg = aggregator(
      connected(0, PUB, 'speaker'),
      published(0, PUB),
      connected(1, L(1)),
      subscribed(1, L(1)),
      receiving(1, L(1)),
    );
    expect(clientGateProblems(agg, TURN_FREE)).toEqual([
      'connected 2/3',
      'subscribed 1/2',
      'receiving 1/2',
    ]);
  });

  it('a connect failure fails the gate even with N connected', () => {
    const agg = aggregator(...HEALTHY_CLIENT, failed(2, L(3)));
    expect(clientGateProblems(agg, TURN_FREE)).toEqual(['1 connect failures']);
  });

  it('worker crashes are counted per worker, not per report', () => {
    const agg = aggregator(...HEALTHY_CLIENT, fatal(1), fatal(1), fatal(2));
    expect(clientGateProblems(agg, TURN_FREE)).toEqual(['2 worker crashes']);
  });

  it('the publisher connected but never published', () => {
    const agg = aggregator(...HEALTHY_CLIENT.filter((m) => m.type !== 'published'));
    expect(clientGateProblems(agg, TURN_FREE)).toEqual(['publisher not published']);
  });

  it('connected is not healthy: a subscribed listener that is not receiving fails', () => {
    const agg = aggregator(
      ...HEALTHY_CLIENT.filter((m) => !(m.type === 'receiving' && m.participantId === L(2))),
    );
    expect(clientGateProblems(agg, TURN_FREE)).toEqual(['receiving 1/2']);
  });

  it('an unsubscribe removes the listener from the subscribed count', () => {
    const agg = aggregator(...HEALTHY_CLIENT, {
      type: 'mediaFault',
      workerId: 1,
      participantId: L(2),
      fault: 'unsubscribed',
      reason: null,
    });
    expect(clientGateProblems(agg, TURN_FREE)).toEqual(['subscribed 1/2']);
  });

  it('repeated subscribed/receiving reports of one listener count once', () => {
    const agg = aggregator(
      connected(0, PUB, 'speaker'),
      published(0, PUB),
      connected(1, L(1)),
      connected(1, L(2)),
      subscribed(1, L(1)),
      subscribed(1, L(1)),
      receiving(1, L(1)),
      receiving(1, L(1)),
    );
    expect(clientGateProblems(agg, TURN_FREE)).toEqual(['subscribed 1/2', 'receiving 1/2']);
  });

  it('reports every client problem at once, in a stable order', () => {
    const agg = aggregator(
      connected(0, PUB, 'speaker'),
      connected(1, L(1)),
      failed(1, L(2)),
      fatal(2),
    );
    expect(clientGateProblems(agg, TURN_FREE)).toEqual([
      'connected 2/3',
      '1 connect failures',
      '1 worker crashes',
      'publisher not published',
      'subscribed 0/2',
      'receiving 0/2',
    ]);
  });
});

// --- transport (design §17 T2) ------------------------------------------------

const DIRECT: TransportReport = {
  protocol: 'udp',
  localType: 'host',
  remoteType: 'host',
  remotePort: 7882,
  localCandidateTypes: ['host', 'srflx'],
};
const RELAYED: TransportReport = {
  protocol: 'udp',
  localType: 'relay',
  remoteType: 'host',
  remotePort: 7882,
  localCandidateTypes: ['host', 'relay', 'srflx'],
};

/** An aggregator holding these selected-pair reports, in insertion order. */
function withTransports(reports: ReadonlyArray<readonly [string, TransportReport]>): MpAggregator {
  return aggregator(
    ...reports.map(
      ([participantId, report]) =>
        ({ type: 'transport', workerId: 1, participantId, report }) satisfies WorkerMessage,
    ),
  );
}

describe('fleet/gates — transportGateProblems', () => {
  it('turn-free: every minted identity on a direct udp pair to the SUT port → no problem', () => {
    const agg = withTransports([
      [PUB, DIRECT],
      [L(1), { ...DIRECT, localType: 'srflx' }],
      [L(2), { ...DIRECT, localType: 'prflx' }],
    ]);
    expect(transportGateProblems(agg, MINTED, TURN_FREE)).toEqual([]);
  });

  it('counts minted identities without a selected pair', () => {
    const agg = withTransports([[PUB, DIRECT]]);
    expect(transportGateProblems(agg, MINTED, TURN_FREE)).toEqual([
      '2 participants without a selected pair',
    ]);
  });

  it('a report from an identity nobody minted does not cover a minted one', () => {
    const agg = withTransports([
      [PUB, DIRECT],
      [L(1), DIRECT],
      ['intruder', DIRECT],
    ]);
    expect(transportGateProblems(agg, MINTED, TURN_FREE)).toEqual([
      '1 participants without a selected pair',
    ]);
  });

  it('turn-free: a gathered relay candidate fails even when the selected pair is direct', () => {
    const agg = withTransports([
      [PUB, DIRECT],
      [L(1), { ...DIRECT, localCandidateTypes: ['host', 'relay'] }],
      [L(2), DIRECT],
    ]);
    expect(transportGateProblems(agg, MINTED, TURN_FREE)).toEqual([
      `${L(1)}: relay local candidate gathered`,
    ]);
  });

  it('turn-free: a tcp pair fails', () => {
    const agg = withTransports([
      [PUB, DIRECT],
      [L(1), DIRECT],
      [L(2), { ...DIRECT, protocol: 'tcp' }],
    ]);
    expect(transportGateProblems(agg, MINTED, TURN_FREE)).toEqual([
      `${L(2)}: selected protocol tcp, expected udp`,
    ]);
  });

  it('turn-free: the SUT UDP port comes from the expectation', () => {
    const agg = withTransports([
      [PUB, DIRECT],
      [L(1), DIRECT],
      [L(2), { ...DIRECT, remotePort: null }],
    ]);
    expect(transportGateProblems(agg, MINTED, { ...TURN_FREE, udpPort: 7883 })).toEqual([
      `${PUB}: selected remote port 7882, expected 7883`,
      `${L(1)}: selected remote port 7882, expected 7883`,
      `${L(2)}: selected remote port unknown, expected 7883`,
    ]);
  });

  it('turn-free: an E2-style relayed participant reports every violation, per identity', () => {
    const agg = withTransports([
      [PUB, DIRECT],
      [
        L(1),
        {
          protocol: 'tcp',
          localType: 'relay',
          remoteType: 'relay',
          remotePort: 3478,
          localCandidateTypes: ['host', 'relay'],
        },
      ],
      [L(2), DIRECT],
    ]);
    expect(transportGateProblems(agg, MINTED, TURN_FREE)).toEqual([
      `${L(1)}: relay local candidate gathered`,
      `${L(1)}: selected protocol tcp, expected udp`,
      `${L(1)}: selected local candidate relay, expected host/srflx/prflx`,
      `${L(1)}: selected remote candidate relay`,
      `${L(1)}: selected remote port 3478, expected 7882`,
    ]);
  });

  it('relay positive control: every participant must select a relay local candidate', () => {
    const agg = withTransports([
      [PUB, RELAYED],
      [L(1), { ...RELAYED, protocol: 'tcp', remotePort: 3478 }],
      [L(2), DIRECT],
    ]);
    expect(transportGateProblems(agg, MINTED, RELAY)).toEqual([
      `${L(2)}: selected local candidate host, expected relay`,
    ]);
  });

  it('relay positive control still needs a selected pair per minted identity', () => {
    const agg = withTransports([[PUB, RELAYED]]);
    expect(transportGateProblems(agg, MINTED, RELAY)).toEqual([
      '2 participants without a selected pair',
    ]);
  });
});
