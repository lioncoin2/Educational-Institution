import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * p84-dispatch.sh — the generator's SSH forced command — run under `sh` the
 * way sshd runs it, with the request in SSH_ORIGINAL_COMMAND and temp dirs for
 * P84_ROOT/P84_RUNS. Allowed requests are checked as P84_DRY_RUN command
 * lines; `fetch` and `install` also run for real. `npm` is a stub on PATH, so
 * no test installs packages or touches the network.
 */
const SCRIPT = join(__dirname, '..', 'fleet', 'bootstrap', 'p84-dispatch.sh');
const RUN = '0123456789abcdef';
const SHA = 'a'.repeat(64);
/** git without any user or system config. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

let tmp: string;
let root: string;
let runs: string;
let tmpDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'p84-dispatch-'));
  root = join(tmp, 'root');
  runs = join(tmp, 'runs');
  tmpDir = join(tmp, 'tmp');
  for (const dir of [root, runs, tmpDir]) mkdirSync(dir);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Runs the dispatcher; `env` entries override the defaults, `undefined` removes one. */
function dispatch(
  request: string | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
  input: Buffer | string = '',
) {
  const merged: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: tmp,
    TMPDIR: tmpDir,
    ...GIT_ENV,
    P84_ROOT: root,
    P84_RUNS: runs,
    P84_DRY_RUN: '1',
    SSH_ORIGINAL_COMMAND: request,
    ...env,
  };
  const defined = Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined);
  const result = spawnSync('sh', [SCRIPT], { env: Object.fromEntries(defined), input });
  return {
    status: result.status,
    stdout: result.stdout,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

function git(cwd: string, ...args: string[]): string {
  const env = { PATH: process.env.PATH, ...GIT_ENV };
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

interface Bundle {
  readonly bytes: Buffer;
  readonly sha: string;
  readonly commit: string;
}

/** A one-commit repo with backend/package.json, as a git bundle with its SHA-256 and commit. */
function makeBundle(dir: string, name: string): Bundle {
  const src = join(dir, name);
  mkdirSync(join(src, 'backend'), { recursive: true });
  writeFileSync(join(src, 'backend', 'package.json'), `{"name":"${name}"}\n`);
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'add', '-A');
  const identity = ['-c', 'user.name=p84', '-c', 'user.email=p84@example.invalid'];
  git(src, ...identity, '-c', 'commit.gpgsign=false', 'commit', '-qm', name);
  const path = join(dir, `${name}.bundle`);
  git(src, 'bundle', 'create', '-q', path, 'HEAD', 'main');
  const bytes = readFileSync(path);
  const sha = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha, commit: git(src, 'rev-parse', 'HEAD') };
}

/** A PATH whose `npm` only logs its cwd and arguments (and exits with `code`). */
function stubNpm(code = 0): { path: string; log: string } {
  const bin = join(tmp, 'bin');
  const log = join(tmp, 'npm.log');
  mkdirSync(bin, { recursive: true });
  const body = `#!/bin/sh\nprintf '%s %s\\n' "$(pwd)" "$*" >>'${log}'\nexit ${code}\n`;
  writeFileSync(join(bin, 'npm'), body, { mode: 0o755 });
  return { path: `${bin}:${process.env.PATH ?? ''}`, log };
}

describe('p84-dispatch — allowed requests (dry run)', () => {
  const agentMain = (base: string) => `${base}/current/backend/test/load/fleet/agent-main.ts`;

  it('agent <runId> starts agent-main from the installed backend', () => {
    const r = dispatch(`agent ${RUN}`);
    expect(r).toMatchObject({ status: 0, err: '' });
    expect(r.out).toBe(
      `cd ${root}/current/backend\n` +
        `node -r ts-node/register/transpile-only ${agentMain(root)} ` +
        `--run ${RUN} --runs-dir ${runs}\n`,
    );
  });

  it('stop <runId> runs agent-main --stop with the same cwd, loader and P84_NODE', () => {
    const r = dispatch(`stop ${RUN}`, { P84_NODE: '/opt/node/bin/node' });
    expect(r).toMatchObject({ status: 0, err: '' });
    expect(r.out).toBe(
      `cd ${root}/current/backend\n` +
        `/opt/node/bin/node -r ts-node/register/transpile-only ${agentMain(root)} ` +
        `--stop ${RUN} --runs-dir ${runs}\n`,
    );
  });

  it('fetch <runId> tars only that run directory to stdout', () => {
    const r = dispatch(`fetch ${RUN}`);
    expect(r).toMatchObject({ status: 0, err: '', out: `tar -C ${runs} -cf - ${RUN}\n` });
  });

  it('defaults to /opt/p84, /var/lib/p84/runs and node', () => {
    const r = dispatch(`agent ${RUN}`, { P84_ROOT: undefined, P84_RUNS: undefined });
    expect(r.out).toBe(
      'cd /opt/p84/current/backend\n' +
        `node -r ts-node/register/transpile-only ${agentMain('/opt/p84')} ` +
        `--run ${RUN} --runs-dir /var/lib/p84/runs\n`,
    );
  });
});

describe('p84-dispatch — refused requests', () => {
  const refused: Array<[string, string | undefined]> = [
    ['no request (interactive login)', undefined],
    ['an empty request', ''],
    ['a verb alone', 'agent'],
    ['an unknown verb', `shell ${RUN}`],
    ['an upper-case verb', `AGENT ${RUN}`],
    ['an extra word', `agent ${RUN} extra`],
    ['two run ids', `stop ${RUN} ${RUN}`],
    ['a double space', `agent  ${RUN}`],
    ['a leading space', ` agent ${RUN}`],
    ['a trailing space', `agent ${RUN} `],
    ['a tab separator', `agent\t${RUN}`],
    ['a short runId', `agent ${RUN.slice(1)}`],
    ['a long runId', `agent ${RUN}0`],
    ['an upper-case runId', `fetch ${RUN.toUpperCase()}`],
    ['a non-hex runId', 'fetch 0123456789abcdeg'],
    ['a sha256 where a runId belongs', `agent ${SHA}`],
    ['a runId where a sha256 belongs', `install ${RUN}`],
    ['a short sha256', `install ${SHA.slice(1)}`],
    ['an upper-case sha256', `install ${SHA.toUpperCase()}`],
    ['command chaining', `agent ${RUN}; rm -rf /`],
    ['&& chaining', `agent ${RUN}&&id`],
    ['a pipe', `fetch ${RUN}|sh`],
    ['a redirection', `install ${SHA} >/tmp/x`],
    ['command substitution', 'agent $(id)'],
    ['backticks', 'agent `id`'],
    ['a newline', `agent ${RUN}\nid`],
    ['a carriage return', `agent ${RUN}\r`],
    ['a parent directory', 'fetch ../'],
    ['path traversal', `fetch ../${RUN}`],
    ['dot-dot', 'fetch ..'],
    ['a glob', 'fetch *'],
    ['a glob shaped like a runId', 'fetch 0123456789abcde?'],
    ['a bracket glob', 'fetch 0123456789abcde[f]'],
    ['an absolute path', 'fetch /etc/passwd'],
  ];

  it.each(refused)('refuses %s: exit 64, nothing on stdout', (_label, request) => {
    const r = dispatch(request);
    expect(r.status).toBe(64);
    expect(r.out).toBe('');
    expect(r.err).toContain('p84-dispatch: refused');
  });
});

describe('p84-dispatch — fetch', () => {
  it('streams a tar holding only the requested run', () => {
    mkdirSync(join(runs, RUN, 'media'), { recursive: true });
    writeFileSync(join(runs, RUN, 'pids.json'), '{}\n');
    writeFileSync(join(runs, RUN, 'media', 'w0.ndjson'), '{}\n');
    mkdirSync(join(runs, 'fedcba9876543210'));
    writeFileSync(join(runs, 'fedcba9876543210', 'pids.json'), '{}\n');
    const r = dispatch(`fetch ${RUN}`, { P84_DRY_RUN: undefined });
    expect(r.status).toBe(0);
    const list = spawnSync('tar', ['-tf', '-'], { input: r.stdout, encoding: 'utf8' });
    expect(list.stdout.trim().split('\n').sort()).toEqual([
      `${RUN}/`,
      `${RUN}/media/`,
      `${RUN}/media/w0.ndjson`,
      `${RUN}/pids.json`,
    ]);
  });
});

describe('p84-dispatch — install', () => {
  let bundles: string;
  let one: Bundle;
  let two: Bundle;

  beforeAll(() => {
    bundles = mkdtempSync(join(tmpdir(), 'p84-bundles-'));
    one = makeBundle(bundles, 'one');
    two = makeBundle(bundles, 'two');
  });

  afterAll(() => rmSync(bundles, { recursive: true, force: true }));

  it('dry run: verifies the bundle, then prints the install plan without changing anything', () => {
    const { bytes, sha } = one;
    const r = dispatch(`install ${sha}`, {}, bytes);
    expect(r.status).toBe(0);
    const version = `${root}/versions/${sha}`;
    const lines = r.out.trimEnd().split('\n');
    expect(lines[2]).toMatch(new RegExp(`^git clone --quiet ${tmpDir}/\\S+ ${version}/repo$`));
    expect([...lines.slice(0, 2), ...lines.slice(3)]).toEqual([
      `mkdir -p ${root}/versions`,
      `mkdir ${version}`,
      `cd ${version}/repo/backend`,
      'npm ci --include=dev --no-audit --no-fund',
      `ln -sfn versions/${sha}/repo ${root}/.current-${sha}`,
      `mv -T ${root}/.current-${sha} ${root}/current`,
    ]);
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('a bundle that does not match the announced sha256 is refused (exit 65)', () => {
    const r = dispatch(`install ${SHA}`, { P84_DRY_RUN: undefined }, one.bytes);
    expect(r).toMatchObject({ status: 65, out: '' });
    expect(r.err).toContain('does not match');
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('an installed version is never overwritten (exit 66)', () => {
    mkdirSync(join(root, 'versions', one.sha), { recursive: true });
    const r = dispatch(`install ${one.sha}`, { P84_DRY_RUN: undefined }, one.bytes);
    expect(r).toMatchObject({ status: 66, out: '' });
    expect(readdirSync(join(root, 'versions', one.sha))).toEqual([]);
  });

  it('clones, runs npm ci in repo/backend, switches `current`, prints the commit', () => {
    const npm = stubNpm();
    const real = { P84_DRY_RUN: undefined, PATH: npm.path };

    const first = dispatch(`install ${one.sha}`, real, one.bytes);
    expect(first).toMatchObject({ status: 0, out: `${one.commit}\n` });
    expect(readlinkSync(join(root, 'current'))).toBe(`versions/${one.sha}/repo`);
    expect(readFileSync(join(root, 'current', 'backend', 'package.json'), 'utf8')).toContain('one');
    expect(readFileSync(npm.log, 'utf8')).toBe(
      `${root}/versions/${one.sha}/repo/backend ci --include=dev --no-audit --no-fund\n`,
    );

    const second = dispatch(`install ${two.sha}`, real, two.bytes);
    expect(second).toMatchObject({ status: 0, out: `${two.commit}\n` });
    expect(readlinkSync(join(root, 'current'))).toBe(`versions/${two.sha}/repo`);
    expect(readdirSync(root).sort()).toEqual(['current', 'versions']);
    expect(readdirSync(join(root, 'versions')).sort()).toEqual([one.sha, two.sha].sort());
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('a failed npm ci removes the new version and leaves `current` alone', () => {
    const npm = stubNpm(1);
    const r = dispatch(`install ${one.sha}`, { P84_DRY_RUN: undefined, PATH: npm.path }, one.bytes);
    expect(r).toMatchObject({ status: 1, out: '' });
    expect(existsSync(join(root, 'versions', one.sha))).toBe(false);
    expect(existsSync(join(root, 'current'))).toBe(false);
    expect(readdirSync(tmpDir)).toEqual([]);
  });
});
