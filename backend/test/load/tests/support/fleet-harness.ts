/**
 * TEST SUPPORT (not a spec): runs the REAL controller against REAL local agents
 * (agent-main --local) forking the REAL worker lifecycle with the fake media
 * driver — the whole fleet path except rtc-node, SSH and LiveKit. Rooms are an
 * in-memory RoomOps whose participant list mirrors the minted identities (as the
 * SFU would once they join); the SUT is the real SutSampler over quiet readers
 * with a local health endpoint. Fake-driver behaviour per participant comes from
 * markers in its ticket (mp/fake-worker.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ControllerTiming,
  DEFAULT_TIMING,
  type RungOutcome,
  runRung,
} from '../../fleet/controller';
import { type LocalEndpoint } from '../../fleet/endpoints';
import { type RoomOps, type RunParticipant } from '../../livekit/room-ops';
import { type TicketRole } from '../../livekit/tokens';
import { ProcessManager } from '../../mp/process-manager';
import { systemReaders } from '../../observe/host-base';
import { quietReaders } from '../../observe/quiet-readers';
import { SUT_DEFAULTS, SutSampler } from '../../observe/sut-sampler';
import { type P84Rung } from '../../scenarios/p84-ladder';
import { newRunId } from '../../fleet/shards';

export const FAKE_WORKER = join(__dirname, '..', '..', 'mp', 'fake-worker.ts');

export const FAST: ControllerTiming = {
  ...DEFAULT_TIMING,
  helloTimeoutMs: 45_000,
  readyTimeoutMs: 45_000,
  sampleIntervalMs: 500,
  statsIntervalMs: 500,
  heartbeatMs: 250,
  deadManMs: 8_000,
  teardownTimeoutMs: 2_000,
  shutdownGraceMs: 4_000,
  phaseATimeoutMs: 20_000,
  gateTailMs: 8_000,
  watchAfterTeardownMs: 300,
  tickMs: 50,
  publishRetries: 0,
  recoveryWaitMs: 0,
  recheckMs: 0,
};

export interface FakeRooms {
  readonly ops: RoomOps;
  readonly created: Array<{ room: string; maxParticipants: number }>;
  readonly deleted: string[];
  readonly minted: Map<string, TicketRole>;
}

/** An in-memory SFU control plane; `foreign` adds an identity nobody minted. */
export function fakeRooms(opts: { foreign?: boolean } = {}): FakeRooms {
  const created: FakeRooms['created'] = [];
  const deleted: string[] = [];
  const minted = new Map<string, TicketRole>();
  const live = (room: string): boolean =>
    created.some((c) => c.room === room) && !deleted.includes(room);
  const ops: RoomOps = {
    assertAbsent: async (room) => {
      if (live(room)) throw new Error(`room ${room} exists`);
    },
    create: async (room, maxParticipants) => {
      created.push({ room, maxParticipants });
    },
    participants: async () => {
      const list: RunParticipant[] = [...minted].map(([identity, role]) => ({
        identity,
        active: true,
        audioTracks: role === 'publisher' ? 1 : 0,
      }));
      if (opts.foreign) list.push({ identity: 'intruder', active: true, audioTracks: 0 });
      return list;
    },
    remove: async (room) => {
      deleted.push(room);
    },
    loadtestRooms: async () =>
      created.filter((c) => live(c.room)).map((c) => ({ name: c.room, participants: 0 })),
  };
  return { ops, created, deleted, minted };
}

export type Marker = (identity: string, role: TicketRole) => string;

export interface FleetRun extends RungOutcome {
  readonly rooms: FakeRooms;
  readonly runId: string;
}

let health: Server | null = null;
let healthUrl = '';

/** A local LiveKit-health stand-in answering 200; started once per test file. */
export async function startHealth(): Promise<void> {
  health = createServer((_req, res) => {
    res.writeHead(200);
    res.end('OK');
  });
  await new Promise<void>((resolve) => health?.listen(0, '127.0.0.1', resolve));
  const addr = health.address();
  healthUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;
}

export async function stopHealth(): Promise<void> {
  await new Promise<void>((resolve) => health?.close(() => resolve()));
}

/** Runs one rung of the local fleet with `hosts` local agents. */
export async function runLocalFleet(o: {
  rung: P84Rung;
  hosts: number;
  density: number;
  marker?: Marker;
  ice?: 'turn-free' | 'relay';
  foreign?: boolean;
  timing?: Partial<ControllerTiming>;
}): Promise<FleetRun> {
  const runsDir = mkdtempSync(join(tmpdir(), 'p84-runs-'));
  const runId = newRunId();
  const rooms = fakeRooms({ foreign: o.foreign });
  const endpoints: LocalEndpoint[] = Array.from({ length: o.hosts }, () => ({
    kind: 'local',
    workerModule: FAKE_WORKER,
    runsDir,
  }));
  try {
    const outcome = await runRung(
      {
        runId,
        rung: o.rung,
        rampPerSecond: o.rung.rampPerSecond,
        density: o.density,
        ice: o.ice ?? 'turn-free',
        calibration: false,
        sutAddress: '127.0.0.1',
        udpPort: 7882,
      },
      {
        endpoints,
        pm: new ProcessManager(),
        parentEnv: process.env,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        rooms: rooms.ops,
        mint: async (identity, role) => {
          rooms.minted.set(identity, role);
          return { url: 'ws://fake', token: `${o.marker?.(identity, role) ?? ''}-t-${identity}` };
        },
        sut: new SutSampler(quietReaders(systemReaders(), { role: 'sut' }), {
          ...SUT_DEFAULTS,
          livekitHealthUrl: healthUrl,
          runId,
          rung: o.rung.id,
          harnessPids: [{ pid: process.pid, role: 'controller' }],
        }),
        dbRows: async () => 0,
        postRung: async () => ({
          log: {
            participantActive: { total: 0, udp: 0, tcp: 0, other: 0, identities: 0 },
            relayPairs: 0,
            turnQuota: 0,
            trackNotBound: 0,
            duplicateParticipant: 0,
            errorLines: 0,
            unparsedLines: 0,
            matchedLines: 0,
          },
          ticketLeaks: 0,
        }),
        csv: null,
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      { ...FAST, ...o.timing },
    );
    return { ...outcome, rooms, runId };
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
}
