import { LOAD_ROOM_PREFIX } from '../core/identity';
import {
  type ShardPlan,
  type ShardPlanInput,
  type WorkerShard,
  identitiesOf,
  listenerIdentity,
  newRunId,
  planShards,
  publisherIdentity,
  roomFor,
  runTag,
} from '../fleet/shards';

const RUN = '0123abcd4567ef89';
const SIZES = [2, 3, 4, 5, 7, 10, 11, 20, 21, 33, 64, 99, 100, 101, 300, 1000, 3000, 10000];
const HOSTS = [1, 2, 3, 4, 5, 7];
const DENSITIES = [1, 2, 3, 7, 10, 20, 30, 50];

const plan = (participants: number, hosts: number, density: number): ShardPlan =>
  planShards({ runId: RUN, participants, hosts, density });

const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);
const sizeOf = (s: { start: number; end: number }): number => s.end - s.start;

/** Per-host sums of `value(size)` over the listener shards, indexed by agent. */
function perHost(p: ShardPlan, hosts: number, value: (size: number) => number): number[] {
  const totals = new Array<number>(hosts).fill(0);
  for (const s of p.listeners) totals[s.agentIndex] += value(sizeOf(s));
  return totals;
}

/** Every property a plan must satisfy, as the names of those it violates (empty = ok). */
function violations(input: ShardPlanInput, p: ShardPlan): string[] {
  const { participants: n, hosts, density } = input;
  const { publisher, listeners } = p;
  const listenersPerHost = perHost(p, hosts, (size) => size);
  const workersPerHost = perHost(p, hosts, () => 1);
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ['totalListeners = N−1', p.totalListeners === n - 1],
    [
      'publisher is worker 0 on agent 0 with an empty range',
      publisher.workerId === 0 &&
        publisher.agentIndex === 0 &&
        publisher.kind === 'publisher' &&
        publisher.start === 0 &&
        publisher.end === 0,
    ],
    // Contiguous from 0, non-empty and ending at N−1 ⇒ disjoint and an exact cover.
    [
      'ranges contiguous from 0',
      listeners.every((s, i) => s.start === (i === 0 ? 0 : listeners[i - 1].end)),
    ],
    ['ranges end at N−1', listeners.at(-1)?.end === n - 1],
    [
      'ranges non-empty and ≤ density',
      listeners.every((s) => sizeOf(s) >= 1 && sizeOf(s) <= density),
    ],
    ['listener kind', listeners.every((s) => s.kind === 'listeners')],
    ['workerIds 1..W in range order', listeners.every((s, i) => s.workerId === i + 1)],
    [
      'agents in range, one contiguous block each',
      listeners.every(
        (s, i) =>
          s.agentIndex >= 0 &&
          s.agentIndex < hosts &&
          (i === 0 || s.agentIndex >= listeners[i - 1].agentIndex),
      ),
    ],
    ['listeners per host differ by ≤ 1', spread(listenersPerHost) <= 1],
    [
      'participants per host (with the publisher) differ by ≤ 1',
      spread(listenersPerHost.map((c, h) => c + (h === 0 ? 1 : 0))) <= 1,
    ],
    [
      'fewest workers per host',
      workersPerHost.every((w, h) => w === Math.ceil(listenersPerHost[h] / density)),
    ],
    [
      'worker sizes per host differ by ≤ 1',
      listenersPerHost.every((_, h) => {
        const sizes = listeners.filter((s) => s.agentIndex === h).map(sizeOf);
        return sizes.length === 0 || spread(sizes) <= 1;
      }),
    ],
    ['deterministic', JSON.stringify(planShards({ ...input })) === JSON.stringify(p)],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

describe('fleet shards — run id, room and identities', () => {
  it('mints 64-bit lowercase-hex run ids from the CSPRNG', () => {
    const ids = Array.from({ length: 50 }, () => newRunId());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('derives the room and identities from the run id', () => {
    expect(runTag(RUN)).toBe('0123abcd');
    expect(roomFor(RUN)).toBe('loadtest-p84-0123abcd4567ef89');
    expect(roomFor(RUN).startsWith(LOAD_ROOM_PREFIX)).toBe(true);
    expect(publisherIdentity(RUN)).toBe('p84-0123abcd-P0');
    expect(listenerIdentity(RUN, 0)).toBe('p84-0123abcd-L00000');
    expect(listenerIdentity(RUN, 42)).toBe('p84-0123abcd-L00042');
    expect(listenerIdentity(RUN, 99999)).toBe('p84-0123abcd-L99999');
  });

  it('refuses malformed run ids and listener indices', () => {
    for (const bad of ['', '0123ABCD4567EF89', '0123abcd', '0123abcd4567ef89a', 'loadtest-x'])
      expect(() => roomFor(bad)).toThrow(RangeError);
    expect(() => publisherIdentity('xyz')).toThrow(RangeError);
    for (const bad of [-1, 1.5, Number.NaN, 100000])
      expect(() => listenerIdentity(RUN, bad)).toThrow(RangeError);
  });
});

describe('fleet shards — plan', () => {
  it('splits a small run as documented (remainder on the last host)', () => {
    expect(plan(12, 2, 4)).toEqual({
      publisher: { workerId: 0, agentIndex: 0, kind: 'publisher', start: 0, end: 0 },
      listeners: [
        { workerId: 1, agentIndex: 0, kind: 'listeners', start: 0, end: 3 },
        { workerId: 2, agentIndex: 0, kind: 'listeners', start: 3, end: 5 },
        { workerId: 3, agentIndex: 1, kind: 'listeners', start: 5, end: 8 },
        { workerId: 4, agentIndex: 1, kind: 'listeners', start: 8, end: 11 },
      ],
      totalListeners: 11,
    });
  });

  it('S1 (N=2): one publisher worker and one single-listener worker', () => {
    const p = plan(2, 1, 10);
    expect(p.listeners).toEqual([
      { workerId: 1, agentIndex: 0, kind: 'listeners', start: 0, end: 1 },
    ]);
    expect(identitiesOf(RUN, p.publisher)).toEqual(['p84-0123abcd-P0']);
    expect(identitiesOf(RUN, p.listeners[0])).toEqual(['p84-0123abcd-L00000']);
  });

  it('R1 (N=100, 2 hosts, d=10): 49 + 50 listeners in 5 + 5 workers', () => {
    const p = plan(100, 2, 10);
    expect(perHost(p, 2, (size) => size)).toEqual([49, 50]);
    expect(p.listeners.map(sizeOf)).toEqual([10, 10, 10, 10, 9, ...new Array<number>(5).fill(10)]);
  });

  it('a host left without listeners gets no worker', () => {
    const p = plan(3, 4, 10);
    expect(p.listeners.map((s) => [s.agentIndex, s.start, s.end])).toEqual([
      [2, 0, 1],
      [3, 1, 2],
    ]);
  });

  it('the property checker catches broken plans', () => {
    const input: ShardPlanInput = { runId: RUN, participants: 21, hosts: 2, density: 4 };
    const p = planShards(input);
    const mutate = (i: number, patch: Partial<WorkerShard>): ShardPlan => ({
      ...p,
      listeners: p.listeners.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    });
    expect(violations(input, p)).toEqual([]);
    expect(violations(input, mutate(1, { start: p.listeners[1].start + 1 }))).toContain(
      'ranges contiguous from 0',
    );
    expect(violations(input, mutate(0, { end: p.listeners[0].end + 1 }))).toContain(
      'ranges non-empty and ≤ density',
    );
    expect(violations(input, mutate(2, { agentIndex: 1 }))).toContain(
      'listeners per host differ by ≤ 1',
    );
    expect(violations(input, mutate(3, { workerId: 9 }))).toContain(
      'workerIds 1..W in range order',
    );
  });

  it.each(SIZES)('every property holds for N=%i over all hosts × densities', (participants) => {
    const failures: string[] = [];
    for (const hosts of HOSTS)
      for (const density of DENSITIES) {
        const input = { runId: RUN, participants, hosts, density };
        for (const v of violations(input, planShards(input)))
          failures.push(`hosts=${hosts} density=${density}: ${v}`);
      }
    expect(failures).toEqual([]);
  });

  it('identities are unique across the whole fleet and follow the shard ranges', () => {
    for (const [n, hosts, density] of [
      [2, 1, 1],
      [21, 3, 4],
      [1000, 4, 30],
      [10000, 7, 50],
    ] as const) {
      const p = plan(n, hosts, density);
      const all = [p.publisher, ...p.listeners].flatMap((s) => identitiesOf(RUN, s));
      expect(new Set(all).size).toBe(n);
      expect(all).toEqual([
        publisherIdentity(RUN),
        ...Array.from({ length: n - 1 }, (_, i) => listenerIdentity(RUN, i)),
      ]);
    }
  });

  it('throws RangeError on invalid input', () => {
    const ok: ShardPlanInput = { runId: RUN, participants: 10, hosts: 1, density: 10 };
    for (const bad of [
      { participants: 1 },
      { participants: 0 },
      { participants: 2.5 },
      { participants: Number.NaN },
      { participants: 100002 },
      { hosts: 0 },
      { hosts: 1.5 },
      { density: 0 },
      { density: 1.2 },
      { runId: 'not-a-run' },
    ])
      expect(() => planShards({ ...ok, ...bad })).toThrow(RangeError);
    expect(() => planShards({ ...ok, participants: 100001 })).not.toThrow();
  });
});
