import { type ChildProcess, spawn as rawSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENV_ALLOWLIST,
  type ExitRecord,
  type OwnedProcess,
  ProcessManager,
  type SpawnSpec,
  childEnv,
  settlesWithin,
} from '../mp/process-manager';

/**
 * Unit tests for the P8.4 single spawn primitive (design §1, §2, §18): the EXACT
 * child-env allowlist, exec children (stdio pipes) and fork children (IPC), and
 * the bounded shutdown that records survivors as forced before SIGKILL. Real
 * child processes (this Node binary only); no network, no docker, no ssh.
 */

const NODE = process.execPath;

/** Credentials and harness variables a parent may hold; none may reach a child. */
const PARENT_SECRETS: Readonly<Record<string, string>> = {
  LIVEKIT_API_KEY: 'APIparentkey',
  LIVEKIT_API_SECRET: 'parent-livekit-secret',
  LOADTEST_LIVEKIT_URL: 'wss://lk.example.test',
  LOADTEST_LIVEKIT_API_KEY: 'APIloadtestkey',
  LOADTEST_LIVEKIT_API_SECRET: 'loadtest-livekit-secret',
  DATABASE_URL: 'postgres://app:pw@db/app',
  REDIS_URL: 'redis://cache:6379',
  JWT_SECRET: 'j'.repeat(48),
};

/** A forked worker stand-in: reports what it was started with, exits on request. */
const IPC_CHILD = `'use strict';
process.on('message', (m) => {
  if (m.type === 'report')
    process.send({
      type: 'report',
      env: Object.keys(process.env),
      execArgv: process.execArgv,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      echo: m.echo,
    });
  if (m.type === 'exit') process.exit(m.code);
});
`;

interface Report {
  readonly type: 'report';
  readonly env: string[];
  readonly execArgv: string[];
  readonly argv: string[];
  readonly cwd: string;
  readonly echo: unknown;
}

let dir = '';
let ipcModule = '';
const managers: ProcessManager[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'p84-pm-spec-'));
  ipcModule = join(dir, 'ipc-child.js');
  writeFileSync(ipcModule, IPC_CHILD);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  // A failed assertion must never leave a child behind.
  for (const pm of managers.splice(0)) for (const p of pm.alive()) p.child.kill('SIGKILL');
});

function manager(onExit?: (p: OwnedProcess, rec: ExitRecord) => void): ProcessManager {
  const pm = new ProcessManager(onExit);
  managers.push(pm);
  return pm;
}

/** `node -e <script>` as an exec child. */
function execSpec(script: string, over: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    label: 'exec',
    mode: 'exec',
    command: NODE,
    args: ['-e', script],
    env: childEnv(process.env),
    ...over,
  };
}

/** Everything the child writes to its stdout pipe, once it closes. */
function stdoutOf(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const stdout = child.stdout!;
    stdout.setEncoding('utf8');
    stdout.on('data', (d: string) => {
      out += d;
    });
    stdout.on('end', () => resolve(out));
    stdout.on('error', reject);
  });
}

function nextMessage<T>(child: ChildProcess): Promise<T> {
  return new Promise((resolve) => child.once('message', (m) => resolve(m as T)));
}

/** True once `p` has resolved (checked synchronously after an await). */
function tracker(p: Promise<unknown>): { readonly settled: () => boolean } {
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  return { settled: () => settled };
}

/** Sets parent variables for the duration of `fn`, then restores the exact prior state. */
async function withParentEnv<T>(vars: Readonly<Record<string, string>>, fn: () => Promise<T>) {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

describe('process-manager — childEnv (exact allowlist)', () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/p84',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    ...PARENT_SECRETS,
    NODE_OPTIONS: '--require /tmp/evil.js',
    LD_PRELOAD: '/tmp/evil.so',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    USER: 'root',
  };

  it('the allowlist is exactly PATH, HOME, LANG, TZ', () => {
    expect([...ENV_ALLOWLIST]).toEqual(['PATH', 'HOME', 'LANG', 'TZ']);
  });

  it('inherits ONLY the allowlisted variables (set equality of keys)', () => {
    const env = childEnv(parent);
    expect(sorted(Object.keys(env))).toEqual(sorted(['PATH', 'HOME', 'LANG', 'TZ']));
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/p84', LANG: 'C.UTF-8', TZ: 'UTC' });
  });

  it('never carries LIVEKIT_* / LOADTEST_* or any other parent secret', () => {
    const env = childEnv(parent);
    for (const name of [...Object.keys(PARENT_SECRETS), 'NODE_OPTIONS', 'LD_PRELOAD'])
      expect(env).not.toHaveProperty(name);
    const values = Object.values(env);
    for (const secret of Object.values(PARENT_SECRETS)) expect(values).not.toContain(secret);
  });

  it('keys = allowlisted-and-present ∪ extra; an absent allowlisted variable is omitted, not undefined', () => {
    const env = childEnv({ PATH: '/bin', LIVEKIT_API_SECRET: 's' }, { P84_RUN_ID: 'r1' });
    expect(sorted(Object.keys(env))).toEqual(['P84_RUN_ID', 'PATH']);
    expect(Object.prototype.hasOwnProperty.call(env, 'HOME')).toBe(false);
    expect(env).toEqual({ PATH: '/bin', P84_RUN_ID: 'r1' });
  });

  it('extra overrides an inherited value; the parent is not mutated', () => {
    const before = { ...parent };
    const env = childEnv(parent, { PATH: '/opt/node/bin', TZ: 'Europe/Berlin' });
    expect(env.PATH).toBe('/opt/node/bin');
    expect(env.TZ).toBe('Europe/Berlin');
    expect(parent).toEqual(before);
    env.HOME = 'changed';
    expect(parent.HOME).toBe('/home/p84');
  });

  it('applied to the REAL process.env, a secret set in the parent is not inherited', async () => {
    await withParentEnv(PARENT_SECRETS, async () => {
      const env = childEnv(process.env, { P84_WORKER: '1' });
      const expected = [...ENV_ALLOWLIST.filter((n) => process.env[n] !== undefined), 'P84_WORKER'];
      expect(sorted(Object.keys(env))).toEqual(sorted(expected));
    });
  });
});

describe('process-manager — spawn (exec: program with stdio pipes)', () => {
  it('stdin and stdout are pipes: NDJSON in, NDJSON out; a clean exit is recorded', async () => {
    const pm = manager();
    const p = pm.spawn(
      1,
      execSpec("process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"),
    );
    expect(p.child.stdin).not.toBeNull();
    expect(p.child.stdout).not.toBeNull();
    const out = stdoutOf(p.child);
    p.child.stdin!.end('{"type":"hello"}\n');
    expect(await out).toBe('{"TYPE":"HELLO"}\n');
    expect(await p.exited).toEqual({ code: 0, signal: null, forced: false, error: null });
  });

  it('the child sees EXACTLY the spec env — no parent credential reaches it', async () => {
    await withParentEnv(PARENT_SECRETS, async () => {
      const pm = manager();
      const env = childEnv(process.env, { P84_RUN_ID: 'r1' });
      const p = pm.spawn(
        1,
        execSpec('process.stdout.write(JSON.stringify(Object.keys(process.env)))', { env }),
      );
      const seen = JSON.parse(await stdoutOf(p.child)) as string[];
      expect(sorted(seen)).toEqual(sorted(Object.keys(env)));
      for (const name of Object.keys(PARENT_SECRETS)) expect(seen).not.toContain(name);
      expect((await p.exited).code).toBe(0);
    });
  });

  it('passes args and cwd through', async () => {
    const pm = manager();
    const p = pm.spawn(1, {
      label: 'args',
      mode: 'exec',
      command: NODE,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify([process.argv.slice(1), process.cwd()]))',
        'a',
        'b c',
      ],
      env: childEnv(process.env),
      cwd: dir,
    });
    expect(JSON.parse(await stdoutOf(p.child))).toEqual([['a', 'b c'], realpathSync(dir)]);
  });

  it('the exec child runs in its own process group, never the parent group (Linux procfs)', async () => {
    const pm = manager();
    const p = pm.spawn(
      1,
      execSpec(
        "const s = require('fs').readFileSync('/proc/self/stat', 'utf8');" +
          "const f = s.slice(s.lastIndexOf(')') + 2).split(' ');" +
          'process.stdout.write(JSON.stringify({ pid: process.pid, pgrp: Number(f[2]) }));',
      ),
    );
    const own = readFileSync('/proc/self/stat', 'utf8');
    const parentPgrp = Number(own.slice(own.lastIndexOf(')') + 2).split(' ')[2]);
    const seen = JSON.parse(await stdoutOf(p.child)) as { pid: number; pgrp: number };
    expect(seen.pid).toBe(p.child.pid);
    expect(seen.pgrp).toBe(seen.pid);
    expect(seen.pgrp).not.toBe(parentPgrp);
  });

  it('a missing executable yields an ExitRecord with error set (never started, not forced)', async () => {
    const seen: ExitRecord[] = [];
    const pm = manager((_p, rec) => seen.push(rec));
    const p = pm.spawn(1, {
      label: 'ssh',
      mode: 'exec',
      command: join(dir, 'no-such-program'),
      args: [],
      env: childEnv(process.env),
    });
    const rec = await p.exited;
    expect(rec).toEqual({
      code: null,
      signal: null,
      forced: false,
      error: expect.stringContaining('ENOENT'),
    });
    expect(seen).toEqual([rec]);
    expect(p.child.pid).toBeUndefined();
    expect(pm.alive()).toEqual([]);
    const t0 = Date.now();
    await pm.waitAllExited(1_500);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(await p.exited).toBe(rec);
  });
});

describe('process-manager — spawn (fork: Node module with IPC)', () => {
  it('has an IPC channel and no stdin/stdout pipes; exact env, argv, execArgv and cwd', async () => {
    await withParentEnv(PARENT_SECRETS, async () => {
      const pm = manager();
      const env = childEnv(process.env, { P84_WORKER: '3' });
      const p = pm.spawn(7, {
        label: 'worker-3',
        mode: 'fork',
        command: ipcModule,
        args: ['--worker', '3'],
        env,
        execArgv: ['--max-old-space-size=128'],
        cwd: dir,
      });
      expect(p.id).toBe(7);
      expect(p.label).toBe('worker-3');
      expect(p.child.connected).toBe(true);
      expect(p.child.stdin).toBeNull();
      expect(p.child.stdout).toBeNull();

      const reply = nextMessage<Report>(p.child);
      p.child.send({ type: 'report', echo: { n: 1, s: 'x' } });
      const r = await reply;
      // env compared as a SET: exact equality — the IPC bootstrap variables
      // (NODE_CHANNEL_*) do not linger and nothing from the parent leaks.
      expect({ ...r, env: sorted(r.env) }).toEqual({
        type: 'report',
        env: sorted(Object.keys(env)),
        execArgv: ['--max-old-space-size=128'],
        argv: ['--worker', '3'],
        cwd: realpathSync(dir),
        echo: { n: 1, s: 'x' },
      });

      p.child.send({ type: 'exit', code: 3 });
      expect(await p.exited).toEqual({ code: 3, signal: null, forced: false, error: null });
    });
  });

  it('execArgv defaults to none — the parent (jest) execArgv is not inherited', async () => {
    const pm = manager();
    const p = pm.spawn(1, {
      label: 'w',
      mode: 'fork',
      command: ipcModule,
      args: [],
      env: childEnv(process.env),
    });
    const reply = nextMessage<Report>(p.child);
    p.child.send({ type: 'report' });
    expect((await reply).execArgv).toEqual([]);
    p.child.send({ type: 'exit', code: 0 });
    expect((await p.exited).code).toBe(0);
  });
});

describe('process-manager — ownership records', () => {
  it('get/list/alive reflect owned processes; onExit gets each exit exactly once', async () => {
    const seen: Array<[number, string, ExitRecord]> = [];
    const pm = manager((p, rec) => seen.push([p.id, p.label, rec]));
    const a = pm.spawn(1, execSpec('', { label: 'a' }));
    const b = pm.spawn(2, execSpec('process.exit(4)', { label: 'b' }));
    expect(pm.get(1)).toBe(a);
    expect(pm.get(2)).toBe(b);
    expect(pm.get(3)).toBeUndefined();
    expect(pm.list()).toEqual([a, b]);
    expect(a.child.pid).toEqual(expect.any(Number));

    await pm.waitAllExited(1_500);
    expect(pm.alive()).toEqual([]);
    expect(pm.list()).toEqual([a, b]);
    expect(seen.sort((x, y) => x[0] - y[0])).toEqual([
      [1, 'a', { code: 0, signal: null, forced: false, error: null }],
      [2, 'b', { code: 4, signal: null, forced: false, error: null }],
    ]);
    expect(await a.exited).toBe(seen[0][2]);
  });

  it('a second spawn under an id it already owns throws and registers nothing', () => {
    const pm = manager();
    const first = pm.spawn(5, execSpec('setTimeout(() => {}, 5000)', { label: 'first' }));
    expect(() => pm.spawn(5, execSpec('', { label: 'second' }))).toThrow(
      'process 5 is already owned',
    );
    expect(pm.list()).toEqual([first]);
    expect(pm.get(5)?.label).toBe('first');
  });
});

describe('process-manager — waitAllExited (bounded shutdown)', () => {
  it('resolves at once when nothing is owned', async () => {
    const t0 = Date.now();
    await manager().waitAllExited(5_000);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('an exiting child is awaited to its exit EVENT and is not forced', async () => {
    const pm = manager();
    const p = pm.spawn(1, execSpec('setTimeout(() => process.exit(0), 150)'));
    const t = tracker(p.exited);
    const t0 = Date.now();
    await pm.waitAllExited(1_800);
    expect(t.settled()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_800);
    expect(await p.exited).toEqual({ code: 0, signal: null, forced: false, error: null });
  });

  it('a child that ignores shutdown is recorded FORCED, then SIGKILLed and awaited', async () => {
    const seen: ExitRecord[] = [];
    const pm = manager((_p, rec) => seen.push(rec));
    const p = pm.spawn(1, execSpec('setInterval(() => {}, 1000)'));
    const t = tracker(p.exited);
    await pm.waitAllExited(150);
    expect(t.settled()).toBe(true); // the forced exit is awaited, not just signalled
    const rec = { code: null, signal: 'SIGKILL', forced: true, error: null };
    expect(await p.exited).toEqual(rec);
    expect(seen).toEqual([rec]); // onExit already sees forced: recorded before the kill
    expect(pm.alive()).toEqual([]);
  });

  it('forces only the survivors: a child that already exited keeps forced = false', async () => {
    const pm = manager();
    const quick = pm.spawn(1, execSpec('', { label: 'quick' }));
    const hang = pm.spawn(2, execSpec('setInterval(() => {}, 1000)', { label: 'hang' }));
    await quick.exited;
    await pm.waitAllExited(150);
    expect(await quick.exited).toEqual({ code: 0, signal: null, forced: false, error: null });
    expect(await hang.exited).toEqual({ code: null, signal: 'SIGKILL', forced: true, error: null });
  });

  it('never signals a process it did not spawn', async () => {
    const bystander = rawSpawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: childEnv(process.env),
    });
    try {
      const pm = manager();
      const owned = pm.spawn(1, execSpec('setInterval(() => {}, 1000)'));
      await pm.waitAllExited(150);
      expect((await owned.exited).forced).toBe(true);
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
      expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
    } finally {
      const gone = new Promise((resolve) => bystander.once('exit', resolve));
      bystander.kill('SIGKILL');
      await gone;
    }
  });
});

describe('process-manager — settlesWithin', () => {
  afterEach(() => jest.useRealTimers());

  it('true when the promise settles in time, and leaves no timer behind', async () => {
    jest.useFakeTimers();
    expect(await settlesWithin(Promise.resolve(1), 10_000)).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('false at the deadline for a promise that never settles, and leaves no timer behind', async () => {
    jest.useFakeTimers();
    const result = settlesWithin(new Promise<never>(() => undefined), 50);
    const t = tracker(result);
    await jest.advanceTimersByTimeAsync(49);
    expect(t.settled()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a rejected promise has settled too: resolves true and leaves no timer (JSDoc contract)', async () => {
    jest.useFakeTimers();
    const outcome = await settlesWithin(Promise.reject(new Error('boom')), 10_000).then(
      (v) => ({ resolved: v }),
      (e: unknown) => ({ rejected: e instanceof Error ? e.message : String(e) }),
    );
    expect(jest.getTimerCount()).toBe(0);
    expect(outcome).toEqual({ resolved: true });
  });
});
