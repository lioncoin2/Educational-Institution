import {
  type CleanupDeps,
  type CleanupInputs,
  cleanupRun,
  conntrackRecovered,
} from '../fleet/cleanup';
import { type RoomOps } from '../livekit/room-ops';
import { PARAMETERS } from '../observe/rules';
import { type HostSample, SAMPLE_SCHEMA } from '../observe/sample';

const ROOM = 'loadtest-p84-0123456789abcdef';
const CLOSED_AT = 1_000_000;
const BASE_CT = 1_000;

/** A SUT sample carrying only what cleanup reads: conntrack and relay-range sockets. */
function sut(conntrack: number | null, relaySockets: number | null): HostSample {
  return {
    schema: SAMPLE_SCHEMA,
    runId: '0123456789abcdef',
    rung: 'S2',
    host: 'sut',
    role: 'sut',
    t: 0,
    seq: 0,
    clockOffsetMs: null,
    cores: null,
    cpuClockMs: null,
    load1: null,
    mem: null,
    oomKills: null,
    net: null,
    qdisc: null,
    udp: { v4: null, v6: null },
    softnet: null,
    conntrack: conntrack === null ? null : { count: conntrack, max: 262_144 },
    udpSockets: null,
    procs: [],
    sut: {
      relaySockets,
      turnTlsEstab: 0,
      fwNewFlows: null,
      containers: null,
      livekitHttp: 200,
      nginx: null,
    },
    gen: null,
  };
}

interface Script {
  /** DeleteRoom's outcome (default: succeeds). */
  readonly remove?: () => Promise<void>;
  /** `loadtest-` rooms still on the SFU, or the error listing them fails with (default: none). */
  readonly rooms?: Array<{ name: string; participants: number }> | Error;
  /** Load-test DB rows (default 0; null = unreadable). */
  readonly rows?: number | null;
  /** Successive SUT samples; the last repeats (default: one clean, recovered sample). */
  readonly samples?: ReadonlyArray<HostSample | null>;
  readonly now?: number;
}

function fake(s: Script = {}): { deps: CleanupDeps; calls: string[]; sleeps: number[] } {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let sampled = 0;
  const unused = async (): Promise<never> => {
    throw new Error('not a cleanup operation');
  };
  const rooms: RoomOps = {
    assertAbsent: unused,
    create: unused,
    participants: unused,
    remove: async (room) => {
      calls.push(`remove ${room}`);
      if (s.remove) await s.remove();
    },
    loadtestRooms: async () => {
      calls.push('loadtestRooms');
      if (s.rooms instanceof Error) throw s.rooms;
      return s.rooms ?? [];
    },
  };
  const deps: CleanupDeps = {
    rooms,
    dbRows: async () => {
      calls.push('dbRows');
      return s.rows === undefined ? 0 : s.rows;
    },
    sutSample: async () => {
      calls.push('sutSample');
      const list = s.samples ?? [sut(BASE_CT, 0)];
      const next = list[Math.min(sampled, list.length - 1)];
      sampled += 1;
      return next ?? null;
    },
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
      sleeps.push(ms);
    },
    now: () => s.now ?? CLOSED_AT,
  };
  return { deps, calls, sleeps };
}

const inputs = (i: Partial<CleanupInputs> = {}): CleanupInputs => ({
  room: ROOM,
  baseline: sut(BASE_CT, 0),
  generatorProcesses: { 'agent-0': 0, 'agent-1': 0 },
  closedAt: CLOSED_AT,
  recoveryWaitMs: 0,
  recheckMs: 0,
  ...i,
});

describe('fleet/cleanup — verification', () => {
  it('is verified when rooms, participants, rows, generator processes and relay sockets are all zero', async () => {
    const { deps, calls } = fake();
    const report = await cleanupRun(deps, inputs());
    expect(report).toEqual({
      cleanupRooms: 0,
      cleanupParticipants: 0,
      cleanupRows: 0,
      generatorProcesses: { 'agent-0': 0, 'agent-1': 0 },
      relaySockets: 0,
      hostRecovered: { conntrack: true, cpu: null },
      verified: true,
      problems: [],
    });
    // DeleteRoom first, then the verification reads, then the recovery wait and SUT sample.
    expect(calls).toEqual([`remove ${ROOM}`, 'loadtestRooms', 'dbRows', 'sleep 0', 'sutSample']);
  });

  it.each<{
    name: string;
    script: Script;
    input?: Partial<CleanupInputs>;
    problems: string[];
    fields: Record<string, unknown>;
  }>([
    {
      name: 'the run room is still listed',
      script: { rooms: [{ name: ROOM, participants: 0 }] },
      problems: ['loadtest rooms left: 1'],
      fields: { cleanupRooms: 1, cleanupParticipants: 0 },
    },
    {
      name: 'participants are left in loadtest rooms',
      script: {
        rooms: [
          { name: ROOM, participants: 2 },
          { name: 'loadtest-p84-fedcba9876543210', participants: 3 },
        ],
      },
      problems: ['loadtest rooms left: 2', 'participants left: 5'],
      fields: { cleanupRooms: 2, cleanupParticipants: 5 },
    },
    {
      name: 'the room listing fails',
      script: { rooms: new Error('twirp: unavailable') },
      problems: ['loadtest rooms left: unknown', 'participants left: unknown'],
      fields: { cleanupRooms: null, cleanupParticipants: null },
    },
    {
      name: 'load-test DB rows are left',
      script: { rows: 3 },
      problems: ['load-test DB rows: 3'],
      fields: { cleanupRows: 3 },
    },
    {
      name: 'the DB row count is unreadable',
      script: { rows: null },
      problems: ['load-test DB rows: unknown'],
      fields: { cleanupRows: null },
    },
    {
      name: 'a generator process is still alive',
      script: {},
      input: { generatorProcesses: { 'agent-0': 0, 'agent-1': 2 } },
      problems: ['generator processes left (or unreported)'],
      fields: { generatorProcesses: { 'agent-0': 0, 'agent-1': 2 } },
    },
    {
      name: 'an agent never reported its processes',
      script: {},
      input: { generatorProcesses: { 'agent-0': null, 'agent-1': 0 } },
      problems: ['generator processes left (or unreported)'],
      fields: { generatorProcesses: { 'agent-0': null, 'agent-1': 0 } },
    },
    {
      name: 'relay-range sockets are left on the SUT',
      script: { samples: [sut(BASE_CT, 2)] },
      problems: ['relay sockets: 2'],
      fields: { relaySockets: 2 },
    },
    {
      name: 'the relay-socket count is unreadable',
      script: { samples: [sut(BASE_CT, null)] },
      problems: ['relay sockets: unknown'],
      fields: { relaySockets: null },
    },
    {
      name: 'the SUT sample has no SUT section',
      script: { samples: [{ ...sut(BASE_CT, 0), sut: null }] },
      problems: ['relay sockets: unknown', 'TURN/TLS connections: unknown'],
      fields: { relaySockets: null },
    },
  ])('is not verified when $name', async ({ script, input, problems, fields }) => {
    const { deps } = fake(script);
    const report = await cleanupRun(deps, inputs(input));
    expect(report.verified).toBe(false);
    expect(report.problems).toEqual(problems);
    expect(report).toMatchObject(fields);
  });

  it('reports every problem at once', async () => {
    const { deps } = fake({
      rooms: [{ name: ROOM, participants: 1 }],
      rows: null,
      samples: [sut(BASE_CT, 1)],
    });
    const report = await cleanupRun(deps, inputs({ generatorProcesses: { 'agent-0': 1 } }));
    expect(report.problems).toEqual([
      'loadtest rooms left: 1',
      'participants left: 1',
      'load-test DB rows: unknown',
      'generator processes left (or unreported)',
      'relay sockets: 1',
    ]);
    expect(report.verified).toBe(false);
  });

  it('reports a DeleteRoom failure instead of throwing, and still verifies the rest', async () => {
    const { deps, calls } = fake({
      remove: async () => {
        throw new Error('twirp error: not_found');
      },
      rooms: [{ name: ROOM, participants: 0 }],
    });
    const report = await cleanupRun(deps, inputs());
    expect(report.problems).toEqual([
      'DeleteRoom failed: twirp error: not_found',
      'loadtest rooms left: 1',
    ]);
    expect(report.verified).toBe(false);
    expect(calls).toEqual([`remove ${ROOM}`, 'loadtestRooms', 'dbRows', 'sleep 0', 'sutSample']);
  });

  it('a DeleteRoom failure alone is enough to leave cleanup unverified', async () => {
    const { deps } = fake({
      remove: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:7880');
      },
    });
    const report = await cleanupRun(deps, inputs());
    expect(report).toMatchObject({
      cleanupRooms: 0,
      verified: false,
      problems: ['DeleteRoom failed: connect ECONNREFUSED 127.0.0.1:7880'],
    });
  });

  it('without a SUT sampler (local runs) relay sockets and conntrack are not judged', async () => {
    const { deps, calls } = fake({ samples: [null] });
    const report = await cleanupRun(deps, inputs());
    expect(report).toMatchObject({
      relaySockets: null,
      hostRecovered: { conntrack: null, cpu: null },
      verified: true,
      problems: [],
    });
    expect(calls.filter((c) => c === 'sutSample')).toHaveLength(1);
  });
});

describe('fleet/cleanup — recovery wait and re-check', () => {
  it('waits until closedAt + recoveryWaitMs before sampling the SUT', async () => {
    const { deps, calls, sleeps } = fake({ now: CLOSED_AT + 12_000 });
    await cleanupRun(deps, inputs({ recoveryWaitMs: 30_000 }));
    expect(sleeps).toEqual([18_000]);
    expect(calls.slice(-2)).toEqual(['sleep 18000', 'sutSample']);
  });

  it('defaults the wait to P-rec-ct afterSeconds', async () => {
    const { deps, sleeps } = fake();
    await cleanupRun(deps, inputs({ recoveryWaitMs: undefined }));
    expect(sleeps).toEqual([PARAMETERS['P-rec-ct'].afterSeconds * 1000]);
  });

  it('does not wait once the recovery time has already passed', async () => {
    const { deps, sleeps } = fake({ now: CLOSED_AT + 500_000 });
    await cleanupRun(deps, inputs({ recoveryWaitMs: 30_000 }));
    expect(sleeps).toEqual([0]);
  });

  it('re-checks a conntrack miss exactly once, after recheckMs', async () => {
    const { deps, calls, sleeps } = fake({ samples: [sut(5_000, 0), sut(BASE_CT + 100, 0)] });
    const report = await cleanupRun(deps, inputs({ recheckMs: 7_000 }));
    expect(sleeps).toEqual([0, 7_000]);
    expect(calls.slice(-4)).toEqual(['sleep 0', 'sutSample', 'sleep 7000', 'sutSample']);
    expect(report.hostRecovered.conntrack).toBe(true);
    expect(report.verified).toBe(true);
  });

  it('defaults the re-check delay to P-rec-miss recheckSeconds', async () => {
    const { deps, sleeps } = fake({ samples: [sut(5_000, 0), sut(BASE_CT, 0)] });
    await cleanupRun(deps, inputs({ recheckMs: undefined }));
    expect(sleeps).toEqual([0, PARAMETERS['P-rec-miss'].recheckSeconds * 1000]);
  });

  it('a miss that persists after the one re-check is hostRecovered=false, not unverified cleanup', async () => {
    const { deps, calls } = fake({
      samples: [sut(5_000, 0), sut(5_000, 0), sut(BASE_CT, 0)],
    });
    const report = await cleanupRun(deps, inputs());
    expect(calls.filter((c) => c === 'sutSample')).toHaveLength(2);
    expect(report).toMatchObject({
      hostRecovered: { conntrack: false, cpu: null },
      verified: true,
      problems: [],
    });
  });

  it('reads relay sockets from the re-check sample', async () => {
    const cleared = fake({ samples: [sut(5_000, 4), sut(BASE_CT, 0)] });
    expect(await cleanupRun(cleared.deps, inputs())).toMatchObject({
      relaySockets: 0,
      verified: true,
    });
    const appeared = fake({ samples: [sut(5_000, 0), sut(5_000, 3)] });
    expect(await cleanupRun(appeared.deps, inputs())).toMatchObject({
      relaySockets: 3,
      verified: false,
      problems: ['relay sockets: 3'],
    });
  });

  it.each<{
    name: string;
    baseline: HostSample | null;
    sample: HostSample;
    conntrack: boolean | null;
  }>([
    {
      name: 'conntrack recovered',
      baseline: sut(BASE_CT, 0),
      sample: sut(BASE_CT + 200, 0),
      conntrack: true,
    },
    { name: 'there is no baseline', baseline: null, sample: sut(50_000, 0), conntrack: null },
    {
      name: 'the baseline has no conntrack',
      baseline: sut(null, 0),
      sample: sut(50_000, 0),
      conntrack: null,
    },
    {
      name: 'the sample has no conntrack',
      baseline: sut(BASE_CT, 0),
      sample: sut(null, 0),
      conntrack: null,
    },
  ])('takes no re-check when $name', async ({ baseline, sample, conntrack }) => {
    const { deps, sleeps } = fake({ samples: [sample, sut(BASE_CT, 0)] });
    const report = await cleanupRun(deps, inputs({ baseline }));
    expect(sleeps).toHaveLength(1);
    expect(report.hostRecovered.conntrack).toBe(conntrack);
  });
});

describe('fleet/cleanup — conntrackRecovered (P-rec-ct)', () => {
  const { fraction, absolute } = PARAMETERS['P-rec-ct'];

  it.each([0, 1_000, 2_000, 10_000, 50_000])(
    'baseline %i: recovered at baseline + max(fraction × baseline, absolute), not one above',
    (baseline) => {
      const edge = baseline + Math.max(fraction * baseline, absolute);
      expect(conntrackRecovered(baseline, edge)).toBe(true);
      expect(conntrackRecovered(baseline, edge + 1)).toBe(false);
    },
  );

  it('the absolute allowance governs a small baseline, the fraction a large one', () => {
    const small = 1_000;
    expect(fraction * small).toBeLessThan(absolute);
    expect(conntrackRecovered(small, small + absolute)).toBe(true);
    expect(conntrackRecovered(small, small + absolute + 1)).toBe(false);
    const large = 10_000;
    expect(fraction * large).toBeGreaterThan(absolute);
    expect(conntrackRecovered(large, large + absolute + 1)).toBe(true);
    expect(conntrackRecovered(large, large + fraction * large)).toBe(true);
    expect(conntrackRecovered(large, large + fraction * large + 1)).toBe(false);
  });

  it('a count at or below the baseline has recovered', () => {
    expect(conntrackRecovered(BASE_CT, BASE_CT)).toBe(true);
    expect(conntrackRecovered(BASE_CT, 0)).toBe(true);
  });
});
