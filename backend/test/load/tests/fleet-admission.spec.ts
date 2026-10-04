import { Admission } from '../fleet/admission';
import { GlobalRamp } from '../fleet/ramp';
import { admissionRate } from '../results/series';
import {
  type ShardPlan,
  type WorkerShard,
  identitiesOf,
  listenerIdentity,
  planShards,
  publisherIdentity,
  roomFor,
} from '../fleet/shards';
import { type TicketRole } from '../livekit/tokens';
import { type MediaTicket, type WorkerParticipant } from '../mp/types';

const RUN = '0123abcd4567ef89';
const ROOM = roomFor(RUN);
const PUBLISHER = publisherIdentity(RUN);

interface MintCall {
  readonly identity: string;
  readonly role: TicketRole;
  /** Controller clock when the ticket was minted. */
  readonly at: number;
}

interface AdmitCall {
  readonly agentIndex: number;
  readonly workerId: number;
  readonly participant: WorkerParticipant;
}

interface RigOptions {
  readonly participants?: number;
  readonly hosts?: number;
  readonly density?: number;
  /** Overrides planShards (to build a deliberately corrupt plan). */
  readonly plan?: ShardPlan;
  readonly ratePerSecond?: number;
  readonly burst?: number;
  readonly inFlightLimit?: number;
  /** Replaces the default fake ticket (e.g. to make one mint fail). */
  readonly mint?: (identity: string, role: TicketRole) => Promise<MediaTicket>;
}

const ticketFor = (identity: string): MediaTicket => ({
  url: 'wss://sut.invalid',
  token: `ticket-for-${identity}`,
});

/** An Admission over the real planShards + GlobalRamp, with a recording mint/admit and a settable clock. */
function rig(o: RigOptions = {}) {
  let clock = 0;
  const mints: MintCall[] = [];
  const admits: AdmitCall[] = [];
  const plan =
    o.plan ??
    planShards({
      runId: RUN,
      participants: o.participants ?? 21,
      hosts: o.hosts ?? 1,
      density: o.density ?? 10,
    });
  const ramp = new GlobalRamp({
    ratePerSecond: o.ratePerSecond ?? 10,
    burst: o.burst,
    inFlightLimit: o.inFlightLimit ?? 4,
  });
  const admission = new Admission(plan, RUN, ROOM, {
    mint: async (identity, role) => {
      mints.push({ identity, role, at: clock });
      return o.mint ? o.mint(identity, role) : ticketFor(identity);
    },
    admit: (agentIndex, workerId, participant) => {
      admits.push({ agentIndex, workerId, participant });
    },
    ramp,
    now: () => clock,
  });
  return {
    plan,
    admission,
    mints,
    admits,
    setNow: (ms: number): void => {
      clock = ms;
    },
    listenerMints: (): MintCall[] => mints.filter((m) => m.role === 'listener'),
  };
}
type Rig = ReturnType<typeof rig>;

/** Listener tickets minted but with no terminal event yet, worst worker. */
function maxUnresolved(r: Rig, resolved: ReadonlySet<string>): number {
  const perWorker = new Map<number, number>();
  for (const a of r.admits) {
    if (a.participant.role !== 'listener' || resolved.has(a.participant.identity)) continue;
    perWorker.set(a.workerId, (perWorker.get(a.workerId) ?? 0) + 1);
  }
  return Math.max(0, ...perWorker.values());
}

interface TickTrace {
  readonly t: number;
  readonly returned: number;
  /** Cumulative listener tickets minted after this tick. */
  readonly minted: number;
  readonly maxUnresolved: number;
}

/**
 * Drives phase B the way the controller does: at each tick time, tickets issued
 * at least `latencyMs` earlier first reach a terminal event (`resolved`), then
 * the admission ticks. Stops when everyone is admitted (or after the last tick).
 */
async function drive(
  r: Rig,
  ticks: readonly number[],
  latencyMs: number,
  resolved = new Set<string>(),
): Promise<TickTrace[]> {
  const trace: TickTrace[] = [];
  for (const t of ticks) {
    if (r.admission.allAdmitted()) break;
    r.setNow(t);
    for (const a of r.admits) {
      const id = a.participant.identity;
      if (a.participant.role !== 'listener' || resolved.has(id)) continue;
      if ((r.admission.issuedAt(id) ?? Infinity) + latencyMs <= t) {
        resolved.add(id);
        r.admission.resolved(id);
      }
    }
    const returned = await r.admission.tick();
    trace.push({
      t,
      returned,
      minted: r.listenerMints().length,
      maxUnresolved: maxUnresolved(r, resolved),
    });
  }
  return trace;
}

const every = (stepMs: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => i * stepMs);

const shardOfIndex = (plan: ShardPlan, index: number): WorkerShard | undefined =>
  plan.listeners.find((s) => index >= s.start && index < s.end);

describe('fleet/admission — the publisher (phase A)', () => {
  it('mints the publisher with the publisher role and admits it on worker 0 of agent 0', async () => {
    const r = rig({ participants: 21, hosts: 2, density: 5 });
    await expect(r.admission.admitPublisher()).resolves.toBe(PUBLISHER);
    expect(r.mints).toEqual([{ identity: PUBLISHER, role: 'publisher', at: 0 }]);
    expect(r.admits).toEqual([
      {
        agentIndex: 0,
        workerId: 0,
        participant: {
          identity: PUBLISHER,
          room: ROOM,
          role: 'speaker',
          ticket: ticketFor(PUBLISHER),
        },
      },
    ]);
    expect(r.admission.minted()).toEqual(new Set([PUBLISHER]));
    expect(r.admission.issuedAt(PUBLISHER)).toBe(0);
  });

  it('admits the publisher only once: a second admitPublisher throws and mints nothing', async () => {
    const r = rig();
    await r.admission.admitPublisher();
    await expect(r.admission.admitPublisher()).rejects.toThrow(
      `identity ${PUBLISHER} already minted`,
    );
    expect(r.mints).toHaveLength(1);
    expect(r.admits).toHaveLength(1);
  });

  it('the publisher is the first ticket of the run and no ramp tick ever mints it again', async () => {
    const r = rig({ participants: 21, hosts: 2, density: 5, ratePerSecond: 50, burst: 5 });
    await r.admission.admitPublisher();
    await drive(r, every(100, 100), 0);
    expect(r.admission.allAdmitted()).toBe(true);
    expect(r.mints[0]).toEqual({ identity: PUBLISHER, role: 'publisher', at: 0 });
    expect(r.mints.filter((m) => m.identity === PUBLISHER)).toHaveLength(1);
    expect(r.mints.slice(1).every((m) => m.role === 'listener')).toBe(true);
    expect(r.admits.filter((a) => a.workerId === 0)).toHaveLength(1);
  });

  it('a failed publisher mint records nothing: no owner, no admission, no issue time', async () => {
    const r = rig({
      mint: async () => {
        throw new Error('mint refused');
      },
    });
    await expect(r.admission.admitPublisher()).rejects.toThrow('mint refused');
    expect(r.admits).toEqual([]);
    expect(r.admission.owns(0, PUBLISHER)).toBe(false);
    expect(r.admission.minted().size).toBe(0);
    expect(r.admission.issuedAt(PUBLISHER)).toBeUndefined();
  });
});

describe('fleet/admission — listener tickets are minted just in time at the ramp rate', () => {
  it('mints nothing before the first tick; then exactly one ticket per credit, stamped at its tick', async () => {
    // 10/s, burst 1, a 100 ms controller tick: one credit (= one ticket) per tick.
    const r = rig({ participants: 21, hosts: 2, density: 5, ratePerSecond: 10, burst: 1 });
    await r.admission.admitPublisher();
    expect(r.listenerMints()).toEqual([]);

    const trace = await drive(r, every(100, 50), 0);
    expect(trace).toHaveLength(20);
    expect(trace.map((s) => s.returned)).toEqual(new Array<number>(20).fill(1));
    expect(r.listenerMints().map((m) => m.at)).toEqual(every(100, 20));
    for (const m of r.listenerMints()) expect(r.admission.issuedAt(m.identity)).toBe(m.at);
    // The measured ramp: listener grant times only, in order (the publisher is not a ramp step).
    expect(r.admission.listenerGrantTimes()).toEqual(every(100, 20));
  });

  it('regression: grant times, not issue times — a slow first mint never inflates the measured rate', async () => {
    // Cold run: the first JWT signing was slow, issue stamps (taken after the mint) compressed,
    // and a 20/s ramp measured 22.7/s. Here the first listener mint takes 30 ms of clock.
    let first = true;
    let slow: Rig | null = null;
    slow = rig({
      participants: 6,
      ratePerSecond: 10,
      mint: async (identity) => {
        if (first && identity.includes('-L')) {
          first = false;
          slow?.setNow(30);
        }
        return ticketFor(identity);
      },
    });
    const r = slow;
    await r.admission.admitPublisher();
    await drive(r, every(100, 10), 0);
    const listeners = r.listenerMints().map((m) => m.identity);
    const issued = listeners.map((id) => r.admission.issuedAt(id) ?? Number.NaN);
    expect(admissionRate(issued)).toBeGreaterThan(10); // what issue stamps would have reported
    const granted = r.admission.listenerGrantTimes();
    expect(granted).toEqual(every(100, 5));
    expect(admissionRate(granted)).toBe(10);
  });

  it('a coarse or jittery tick neither lowers the rate nor exceeds burst + rate × elapsed', async () => {
    const rate = 10;
    const r = rig({ participants: 41, hosts: 2, density: 10, ratePerSecond: rate, burst: 1 });
    await r.admission.admitPublisher();
    const trace = await drive(r, [0, 250, 1_000, 1_030, 2_600, 2_700, 4_000, 5_500], 0);
    expect(trace.map((s) => s.t)).toEqual([0, 250, 1_000, 1_030, 2_600, 2_700, 4_000]);
    for (const s of trace) {
      // burst (1) + rate × elapsed, never more, and never less while work and slots remain.
      expect(s.minted).toBe(Math.min(40, 1 + Math.floor((rate * s.t) / 1_000)));
    }
    // Every ticket was minted by the tick that granted it (just in time), never ahead.
    for (const s of trace)
      expect(r.listenerMints().filter((m) => m.at === s.t)).toHaveLength(s.returned);
    expect(trace.reduce((sum, s) => sum + s.returned, 0)).toBe(40);
  });

  it('relays each minted ticket unchanged, with the listener role and the run room', async () => {
    const r = rig({ participants: 6, hosts: 1, density: 10, ratePerSecond: 100, burst: 10 });
    await r.admission.admitPublisher();
    await drive(r, every(100, 10), 0);
    const listeners = r.admits.filter((a) => a.workerId !== 0);
    expect(listeners).toHaveLength(5);
    for (const a of listeners) {
      expect(a.participant).toEqual({
        identity: a.participant.identity,
        room: ROOM,
        role: 'listener',
        ticket: ticketFor(a.participant.identity),
      });
    }
    expect(r.listenerMints().every((m) => m.role === 'listener')).toBe(true);
  });
});

describe('fleet/admission — identities: minted once, in disjoint per-shard ranges', () => {
  it.each([
    [2, 1, 10],
    [21, 2, 5],
    [100, 3, 10],
    [101, 4, 7],
  ])(
    'N=%i hosts=%i density=%i: each of the N−1 listeners is minted once, to the shard whose range holds it',
    async (participants, hosts, density) => {
      const r = rig({ participants, hosts, density, ratePerSecond: 50, burst: 5 });
      await r.admission.admitPublisher();
      await drive(r, every(100, 1_000), 0);
      expect(r.admission.allAdmitted()).toBe(true);

      const minted = r.mints.map((m) => m.identity);
      expect(new Set(minted).size).toBe(minted.length);
      expect(r.listenerMints()).toHaveLength(participants - 1);

      const byWorker = new Map<number, string[]>();
      for (const a of r.admits.filter((x) => x.workerId !== 0)) {
        const shard = r.plan.listeners.find((s) => s.workerId === a.workerId);
        expect(shard).toBeDefined();
        expect(a.agentIndex).toBe(shard!.agentIndex);
        byWorker.set(a.workerId, [...(byWorker.get(a.workerId) ?? []), a.participant.identity]);
      }
      for (const shard of r.plan.listeners)
        expect(byWorker.get(shard.workerId)).toEqual(identitiesOf(RUN, shard));

      const all = [...byWorker.values()].flat();
      expect(new Set(all).size).toBe(participants - 1);
      expect(new Set(all)).toEqual(
        new Set(Array.from({ length: participants - 1 }, (_, i) => listenerIdentity(RUN, i))),
      );
    },
  );

  it('minting an identity twice throws before the second mint; the first owner keeps it', async () => {
    // A corrupt plan whose shards overlap on index 1: the ledger must refuse the
    // second ticket for L00001 rather than mint a duplicate identity (V-dup).
    const plan: ShardPlan = {
      publisher: { workerId: 0, agentIndex: 0, kind: 'publisher', start: 0, end: 0 },
      listeners: [
        { workerId: 1, agentIndex: 0, kind: 'listeners', start: 0, end: 2 },
        { workerId: 2, agentIndex: 0, kind: 'listeners', start: 1, end: 3 },
      ],
      totalListeners: 3,
    };
    const r = rig({ plan, ratePerSecond: 100, burst: 4 });
    const l1 = listenerIdentity(RUN, 1);
    await expect(r.admission.tick()).rejects.toThrow(`identity ${l1} already minted`);
    expect(r.mints.map((m) => m.identity)).toEqual([listenerIdentity(RUN, 0), l1]);
    expect(r.admits.map((a) => [a.workerId, a.participant.identity])).toEqual([
      [1, listenerIdentity(RUN, 0)],
      [2, l1],
    ]);
    expect(r.admission.owns(2, l1)).toBe(true);
    expect(r.admission.owns(1, l1)).toBe(false);
  });

  it('minted() is exactly the publisher plus the N−1 listener identities (the server-side check set)', async () => {
    const r = rig({ participants: 33, hosts: 3, density: 4, ratePerSecond: 50, burst: 5 });
    await r.admission.admitPublisher();
    await drive(r, every(100, 1_000), 0);
    const expected = new Set([PUBLISHER, ...r.plan.listeners.flatMap((s) => identitiesOf(RUN, s))]);
    expect(expected.size).toBe(33);
    expect(r.admission.minted()).toEqual(expected);
  });
});

describe('fleet/admission — owns(): agent reports are scoped to identities minted to that worker', () => {
  it('is true only for the worker an identity was minted to — never for a merely planned one', async () => {
    const r = rig({ participants: 21, hosts: 2, density: 5, ratePerSecond: 10, burst: 1 });
    await r.admission.admitPublisher();
    await drive(r, every(100, 7), 0); // 7 of 20 listeners minted, spread over the shards
    expect(r.listenerMints()).toHaveLength(7);

    const minted = new Set(r.listenerMints().map((m) => m.identity));
    const workerIds = [0, ...r.plan.listeners.map((s) => s.workerId), 99];
    for (let index = 0; index < 20; index += 1) {
      const id = listenerIdentity(RUN, index);
      const owner = shardOfIndex(r.plan, index)!.workerId;
      for (const w of workerIds)
        expect(r.admission.owns(w, id)).toBe(minted.has(id) && w === owner);
    }
    // Every shard has both minted and not-yet-minted identities at this point.
    for (const s of r.plan.listeners) {
      const ids = identitiesOf(RUN, s);
      expect(ids.some((id) => minted.has(id))).toBe(true);
      expect(ids.some((id) => !minted.has(id))).toBe(true);
    }
    for (const w of workerIds) expect(r.admission.owns(w, PUBLISHER)).toBe(w === 0);
  });

  it('is false for another run’s identity, an unknown identity and the empty string', async () => {
    const r = rig({ participants: 3, ratePerSecond: 100, burst: 2 });
    await r.admission.admitPublisher();
    await drive(r, [0], 0);
    expect(r.admission.allAdmitted()).toBe(true);
    for (const id of [
      listenerIdentity('ffffffffffffffff', 0),
      publisherIdentity('ffffffffffffffff'),
      'p84-0123abcd-L99999',
      '',
    ]) {
      for (const w of [0, 1, 2]) expect(r.admission.owns(w, id)).toBe(false);
    }
  });
});

describe('fleet/admission — in-flight accounting', () => {
  it('without terminal events a shard stops at the in-flight limit; each resolved() frees one ticket', async () => {
    const r = rig({ participants: 9, hosts: 1, density: 8, ratePerSecond: 100, inFlightLimit: 3 });
    await r.admission.admitPublisher();
    for (const t of every(100, 10)) {
      r.setNow(t);
      await r.admission.tick();
    }
    expect(r.listenerMints()).toHaveLength(3);

    r.admission.resolved(r.listenerMints()[0].identity);
    r.setNow(1_000);
    await expect(r.admission.tick()).resolves.toBe(1);
    expect(r.listenerMints()).toHaveLength(4);
    r.setNow(1_100);
    await expect(r.admission.tick()).resolves.toBe(0);
  });

  it('resolved() for an identity that was never minted frees nothing', async () => {
    const r = rig({ participants: 9, hosts: 1, density: 8, ratePerSecond: 100, inFlightLimit: 2 });
    await r.admission.admitPublisher();
    await r.admission.tick(); // t=0: burst 1
    r.setNow(100);
    await r.admission.tick(); // up to the limit of 2
    expect(r.listenerMints()).toHaveLength(2);
    r.admission.resolved(listenerIdentity(RUN, 7)); // planned, not minted
    r.admission.resolved(listenerIdentity('ffffffffffffffff', 0));
    r.admission.resolved('not-an-identity');
    r.setNow(200);
    await expect(r.admission.tick()).resolves.toBe(0);
    expect(r.listenerMints()).toHaveLength(2);
  });

  it('through a whole ramp, unresolved tickets per worker never exceed the limit, and the limit is reached', async () => {
    // One shard of 30 at 20/s with a 400 ms connect: twice the limit would be wanted in flight.
    const r = rig({ participants: 31, hosts: 1, density: 30, ratePerSecond: 20, inFlightLimit: 4 });
    await r.admission.admitPublisher();
    const trace = await drive(r, every(50, 400), 400);
    expect(r.admission.allAdmitted()).toBe(true);
    expect(r.listenerMints()).toHaveLength(30);
    expect(Math.max(...trace.map((s) => s.maxUnresolved))).toBe(4);
  });

  it('a duplicate terminal event for one identity does not free a second in-flight slot', async () => {
    // A worker can report `failed` after `connected` for the same participant
    // (mp/worker.ts emits `failed` from the same catch), and agent input is
    // untrusted (design §3). In-flight = tickets issued with no terminal event yet
    // (design §6), so a second terminal event for the same ticket must not count.
    const r = rig({
      participants: 9,
      hosts: 1,
      density: 8,
      ratePerSecond: 100,
      burst: 10,
      inFlightLimit: 2,
    });
    await r.admission.admitPublisher();
    await r.admission.tick(); // t=0: L00000, L00001 (limit 2)
    const [first] = r.listenerMints();
    r.admission.resolved(first.identity); // connected
    r.admission.resolved(first.identity); // the same participant again (e.g. failed)
    r.setNow(100);
    await r.admission.tick();
    const resolved = new Set([first.identity]);
    expect(maxUnresolved(r, resolved)).toBeLessThanOrEqual(2);
  });
});

describe('fleet/admission — completion', () => {
  it('allAdmitted() turns true exactly when the (N−1)th listener ticket is minted, not before', async () => {
    const r = rig({ participants: 21, hosts: 2, density: 5, ratePerSecond: 10, burst: 1 });
    await r.admission.admitPublisher();
    expect(r.admission.allAdmitted()).toBe(false);
    const resolved = new Set<string>();
    for (const t of every(100, 20)) {
      r.setNow(t);
      for (const m of r.listenerMints()) {
        if (resolved.has(m.identity)) continue;
        resolved.add(m.identity);
        r.admission.resolved(m.identity);
      }
      await r.admission.tick();
      expect(r.admission.allAdmitted()).toBe(r.listenerMints().length === 20);
    }
    expect(r.listenerMints()).toHaveLength(20);
    expect(r.admission.allAdmitted()).toBe(true);
    // Later ticks mint nothing more.
    for (const t of [2_000, 5_000, 60_000]) {
      r.setNow(t);
      await expect(r.admission.tick()).resolves.toBe(0);
    }
    expect(r.listenerMints()).toHaveLength(20);
  });

  it('N=2: the single listener completes the admission', async () => {
    const r = rig({ participants: 2, ratePerSecond: 2 });
    await r.admission.admitPublisher();
    expect(r.admission.allAdmitted()).toBe(false);
    await expect(r.admission.tick()).resolves.toBe(1);
    expect(r.admission.allAdmitted()).toBe(true);
    expect(r.listenerMints().map((m) => m.identity)).toEqual([listenerIdentity(RUN, 0)]);
  });
});
