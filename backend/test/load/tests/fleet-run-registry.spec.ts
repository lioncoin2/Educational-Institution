import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ProcProbe,
  type RunFile,
  defaultProcProbe,
  readRunFile,
  runDir,
  signalRecorded,
  writeRunFile,
} from '../fleet/run-registry';

/**
 * The generator's per-run PID registry: atomic pids.json round trip, and the
 * emergency-stop policy over a fake OS (children before the agent, PID-reuse
 * safety via starttime, the own-process-group guard). The real /proc probe is
 * checked against this process and one detached child the test owns.
 */
const RUN = '0123456789abcdef';
const FILE: RunFile = {
  runId: RUN,
  agent: { pid: 100, pgid: 100, starttime: 5000 },
  children: [
    { pid: 101, starttime: 5001, label: 'worker:0' },
    { pid: 102, starttime: 5002, label: 'worker:1' },
  ],
};
const ALL_LIVE = { 100: 5000, 101: 5001, 102: 5002 };

/** A fake OS: live pid → starttime, the caller's pgid, and every signal sent, in order. */
function fakeOs(live: Readonly<Record<number, number>>, ownPgid = 7) {
  const probed: number[] = [];
  const kills: Array<[number, NodeJS.Signals]> = [];
  const failing = new Map<number, Error>();
  const probe: ProcProbe = {
    starttime: async (pid) => {
      probed.push(pid);
      return live[pid] ?? null;
    },
    ownPgid: () => ownPgid,
    kill: (pid, signal) => {
      const err = failing.get(pid);
      if (err) throw err;
      kills.push([pid, signal]);
    },
  };
  return { probe, probed, kills, failing };
}

let runs: string;

beforeEach(async () => {
  runs = join(await mkdtemp(join(tmpdir(), 'p84-registry-')), 'runs');
});

afterEach(async () => rm(join(runs, '..'), { recursive: true, force: true }));

describe('run registry — pids.json', () => {
  it('runDir accepts only 16 lowercase hex digits', () => {
    expect(runDir('/var/lib/p84/runs', RUN)).toBe(`/var/lib/p84/runs/${RUN}`);
    for (const bad of [
      '',
      RUN.slice(1),
      `${RUN}0`,
      RUN.toUpperCase(),
      '../0123456789abc',
      `${RUN}/..`,
    ])
      expect(() => runDir(runs, bad)).toThrow('invalid runId');
  });

  it('writes atomically into a private run dir and reads the same file back', async () => {
    await writeRunFile(runs, FILE);
    expect(await readRunFile(runs, RUN)).toEqual(FILE);
    expect((await stat(join(runs, RUN))).mode & 0o777).toBe(0o700);
    expect((await stat(join(runs, RUN, 'pids.json'))).mode & 0o777).toBe(0o600);

    const updated: RunFile = {
      ...FILE,
      children: [...FILE.children, { pid: 103, starttime: 9, label: 'w' }],
    };
    await writeRunFile(runs, updated);
    expect(await readRunFile(runs, RUN)).toEqual(updated);
    expect(await readdir(join(runs, RUN))).toEqual(['pids.json']);
  });

  it('a run without pids.json reads as null', async () => {
    expect(await readRunFile(runs, RUN)).toBeNull();
  });

  it('refuses to write an invalid run file', async () => {
    await expect(writeRunFile(runs, { ...FILE, runId: 'x' })).rejects.toThrow('invalid runId');
    const pidZero: RunFile = { ...FILE, children: [{ pid: 0, starttime: 1, label: 'w' }] };
    await expect(writeRunFile(runs, pidZero)).rejects.toThrow('invalid run file');
    await expect(readdir(runs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['not JSON', '{'],
    ['another run', JSON.stringify({ ...FILE, runId: 'fedcba9876543210' })],
    ['a group pid', JSON.stringify({ ...FILE, agent: { ...FILE.agent, pid: -100 } })],
    ['no children', JSON.stringify({ runId: RUN, agent: FILE.agent })],
  ])('a pids.json holding %s is rejected, never read as empty', async (_label, text) => {
    await mkdir(join(runs, RUN), { recursive: true });
    await writeFile(join(runs, RUN, 'pids.json'), text);
    await expect(readRunFile(runs, RUN)).rejects.toThrow('malformed');
  });
});

describe('run registry — signalRecorded', () => {
  it('signals the children first, then the agent, with the requested signal', async () => {
    const os = fakeOs(ALL_LIVE);
    expect(await signalRecorded(FILE, 'SIGTERM', os.probe)).toEqual({
      signalled: [101, 102, 100],
      skipped: [],
    });
    expect(os.kills).toEqual([
      [101, 'SIGTERM'],
      [102, 'SIGTERM'],
      [100, 'SIGTERM'],
    ]);
  });

  it('skips a reused pid (starttime changed) and one that is gone', async () => {
    const os = fakeOs({ 100: 5000, 101: 9999 });
    const report = await signalRecorded(FILE, 'SIGKILL', os.probe);
    expect(report).toEqual({
      signalled: [100],
      skipped: [
        { pid: 101, reason: 'pid reused (starttime 9999, recorded 5001)' },
        { pid: 102, reason: 'not running' },
      ],
    });
    expect(os.kills).toEqual([[100, 'SIGKILL']]);
  });

  it('signals nothing when the run shares the caller’s process group', async () => {
    const os = fakeOs(ALL_LIVE, FILE.agent.pgid);
    const report = await signalRecorded(FILE, 'SIGTERM', os.probe);
    expect(report.signalled).toEqual([]);
    expect(report.skipped.map((s) => s.pid)).toEqual([101, 102, 100]);
    expect(report.skipped.every((s) => s.reason === 'same process group as the caller')).toBe(true);
    expect(os.kills).toEqual([]);
  });

  it('a failed kill or probe is reported and the rest are still signalled', async () => {
    const os = fakeOs(ALL_LIVE);
    os.failing.set(101, Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }));
    const probe: ProcProbe = {
      ...os.probe,
      starttime: async (pid) => {
        if (pid === 102) throw new Error('unparsable /proc/102/stat');
        return os.probe.starttime(pid);
      },
    };
    expect(await signalRecorded(FILE, 'SIGTERM', probe)).toEqual({
      signalled: [100],
      skipped: [
        { pid: 101, reason: 'failed: ESRCH' },
        { pid: 102, reason: 'failed: unparsable /proc/102/stat' },
      ],
    });
  });

  it('never probes or signals a pid that would address a group or init', async () => {
    const os = fakeOs({ ...ALL_LIVE, 0: 1, [-100]: 1, 1: 1 });
    const file: RunFile = {
      ...FILE,
      children: [0, -100, 1].map((pid) => ({ pid, starttime: 1, label: 'bad' })),
    };
    const report = await signalRecorded(file, 'SIGTERM', os.probe);
    expect(report.skipped).toEqual([0, -100, 1].map((pid) => ({ pid, reason: 'invalid pid' })));
    expect(os.probed).toEqual([100]);
    expect(os.kills).toEqual([[100, 'SIGTERM']]);
  });
});

describe('run registry — defaultProcProbe', () => {
  const probe = defaultProcProbe();

  it('reads this process’s starttime and process group from /proc', async () => {
    const own = await probe.starttime(process.pid);
    expect(Number.isSafeInteger(own) && (own ?? -1) >= 0).toBe(true);
    expect(await probe.starttime(process.pid)).toBe(own);
    expect(await probe.starttime(2 ** 31 - 1)).toBeNull();
    const ps = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' });
    expect(probe.ownPgid()).toBe(Number(ps.trim()));
  });

  it('signals a recorded child only while its starttime matches', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal)),
    );
    try {
      const pid = child.pid!;
      const starttime = (await probe.starttime(pid))!;
      const recorded = (st: number): RunFile => ({
        runId: RUN,
        agent: { pid, pgid: pid, starttime: st },
        children: [],
      });

      expect(await signalRecorded(recorded(starttime + 1), 'SIGTERM', probe)).toEqual({
        signalled: [],
        skipped: [{ pid, reason: expect.stringContaining('pid reused') }],
      });

      expect(await signalRecorded(recorded(starttime), 'SIGTERM', probe)).toEqual({
        signalled: [pid],
        skipped: [],
      });
      expect(await exited).toBe('SIGTERM');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
