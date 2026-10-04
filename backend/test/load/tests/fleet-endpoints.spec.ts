import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import {
  AGENT_MAIN,
  type LocalEndpoint,
  type SshEndpoint,
  agentSpawnSpec,
  sshCommandSpec,
} from '../fleet/endpoints';
import { ENV_ALLOWLIST, type SpawnSpec } from '../mp/process-manager';

const RUN = '0123abcd4567ef89';
const VERBS = ['agent', 'fetch', 'stop'] as const;

const SSH: SshEndpoint = {
  kind: 'ssh',
  host: 'gen-1.example.net',
  user: 'p84',
  keyPath: '/keys/p84_generator_ed25519',
  knownHostsPath: '/keys/p84_known_hosts',
};

const LOCAL: LocalEndpoint = {
  kind: 'local',
  workerModule: '/harness/mp/fake-worker.ts',
  runsDir: '/scratch/p84-runs',
};

/** A parent environment holding the allowlisted variables AND things that must never reach a child. */
const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/operator',
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  LIVEKIT_API_KEY: 'APIfakekey000',
  LIVEKIT_API_SECRET: 'fake-secret-must-not-leak',
  DATABASE_URL: 'postgres://user:fake-db-password@db/app',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.fake.sock',
  NODE_OPTIONS: '--require /tmp/evil.js',
  P84_RUNS: '/elsewhere',
};
const SECRETS = [
  'APIfakekey000',
  'fake-secret-must-not-leak',
  'fake-db-password',
  '/tmp/ssh-agent.fake.sock',
  '/tmp/evil.js',
];

/** The `-o Name=value` options of an ssh argv, as a map. */
function sshOptions(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a !== '-o') return;
    const [name, ...rest] = (args[i + 1] ?? '').split('=');
    out[name] = rest.join('=');
  });
  return out;
}

const allSpecs = (env: NodeJS.ProcessEnv): Array<[string, SpawnSpec]> => [
  ...VERBS.map((v): [string, SpawnSpec] => [`ssh ${v}`, sshCommandSpec(SSH, v, RUN, env)]),
  ['agent over ssh', agentSpawnSpec(SSH, RUN, env)],
  ['local agent', agentSpawnSpec(LOCAL, RUN, env)],
];

describe('fleet/endpoints — sshCommandSpec', () => {
  it.each(VERBS)('`%s`: the exact ssh argv, ending in <verb> <runId>', (verb) => {
    expect(sshCommandSpec(SSH, verb, RUN, PARENT_ENV).args).toEqual([
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UserKnownHostsFile=/keys/p84_known_hosts',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=3',
      '-i',
      '/keys/p84_generator_ed25519',
      'p84@gen-1.example.net',
      verb,
      RUN,
    ]);
  });

  it('pins the host key, runs in batch mode, uses only the given key and forwards nothing', () => {
    const { args } = sshCommandSpec(SSH, 'agent', RUN, PARENT_ENV);
    expect(sshOptions(args)).toEqual({
      BatchMode: 'yes',
      StrictHostKeyChecking: 'yes',
      UserKnownHostsFile: '/keys/p84_known_hosts',
      IdentitiesOnly: 'yes',
      ForwardAgent: 'no',
      ServerAliveInterval: '5',
      ServerAliveCountMax: '3',
    });
    expect(args).toContain('-T');
    expect(args[args.indexOf('-i') + 1]).toBe('/keys/p84_generator_ed25519');
    for (const flag of ['-A', '-X', '-Y', '-L', '-R', '-D', '-W', '-J', '-t', '-tt', '-N', '-f'])
      expect(args).not.toContain(flag);
  });

  it('the destination is user@host, immediately followed by exactly the verb and the runId', () => {
    const e: SshEndpoint = {
      kind: 'ssh',
      host: '198.51.100.7',
      user: 'loadgen',
      keyPath: '/other/key',
      knownHostsPath: '/other/known_hosts',
    };
    for (const verb of VERBS) {
      const { args } = sshCommandSpec(e, verb, RUN, PARENT_ENV);
      expect(args.slice(-3)).toEqual(['loadgen@198.51.100.7', verb, RUN]);
      // Every token before the destination is an option or an option's value.
      const dest = args.indexOf('loadgen@198.51.100.7');
      expect(dest).toBe(args.length - 3);
      for (let i = 0; i < dest; i += 1)
        expect(args[i].startsWith('-') || ['-o', '-i'].includes(args[i - 1] ?? '')).toBe(true);
      expect(sshOptions(args).UserKnownHostsFile).toBe('/other/known_hosts');
      expect(args[args.indexOf('-i') + 1]).toBe('/other/key');
    }
  });

  it.each(VERBS)('`%s`: an exec of `ssh` labelled by verb and host', (verb) => {
    const spec = sshCommandSpec(SSH, verb, RUN, PARENT_ENV);
    expect(spec.command).toBe('ssh');
    expect(spec.mode).toBe('exec');
    expect(spec.label).toBe(`ssh-${verb}:gen-1.example.net`);
    expect(spec.execArgv).toBeUndefined();
  });

  it.each([
    '',
    '0123ABCD4567EF89',
    '0123abcd4567ef8',
    '0123abcd4567ef890',
    '0123abcd4567ef8g',
    `${RUN}\n`,
    ` ${RUN}`,
    `${RUN}; rm -rf /`,
    `${RUN} stop`,
    '../../../etc/passwd',
    '--help',
  ])('refuses the invalid runId %j for every verb', (runId) => {
    for (const verb of VERBS)
      expect(() => sshCommandSpec(SSH, verb, runId, PARENT_ENV)).toThrow(RangeError);
  });
});

describe('fleet/endpoints — agentSpawnSpec', () => {
  it('an ssh endpoint is exactly the `agent` dispatcher command', () => {
    expect(agentSpawnSpec(SSH, RUN, PARENT_ENV)).toEqual(
      sshCommandSpec(SSH, 'agent', RUN, PARENT_ENV),
    );
  });

  it('a local endpoint runs agent-main.ts under this node with ts-node transpile-only, --local and the worker module', () => {
    const spec = agentSpawnSpec(LOCAL, RUN, PARENT_ENV);
    expect(spec.command).toBe(process.execPath);
    expect(spec.mode).toBe('exec');
    expect(spec.label).toBe('agent:local');
    expect(spec.args).toEqual([
      '-r',
      'ts-node/register/transpile-only',
      AGENT_MAIN,
      '--run',
      RUN,
      '--runs-dir',
      '/scratch/p84-runs',
      '--local',
      '--worker-module',
      '/harness/mp/fake-worker.ts',
    ]);
    expect(spec.args).not.toContain('-i');
  });

  it('AGENT_MAIN is the absolute path of fleet/agent-main.ts, and it exists', () => {
    expect(isAbsolute(AGENT_MAIN)).toBe(true);
    expect(basename(AGENT_MAIN)).toBe('agent-main.ts');
    expect(AGENT_MAIN).toBe(resolve(join(__dirname, '..', 'fleet', 'agent-main.ts')));
    expect(existsSync(AGENT_MAIN)).toBe(true);
  });

  it.each(['', '0123ABCD4567EF89', `${RUN}\n`, 'abc'])(
    'a local endpoint refuses the invalid runId %j',
    (runId) => {
      expect(() => agentSpawnSpec(LOCAL, runId, PARENT_ENV)).toThrow(RangeError);
      expect(() => agentSpawnSpec(SSH, runId, PARENT_ENV)).toThrow(RangeError);
    },
  );
});

describe('fleet/endpoints — child environment is exactly the allowlist', () => {
  it.each(allSpecs(PARENT_ENV))(
    '%s: env keys equal ENV_ALLOWLIST (set equality)',
    (_name, spec) => {
      expect(Object.keys(spec.env).sort()).toEqual([...ENV_ALLOWLIST].sort());
      expect(spec.env).toEqual({
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/home/operator',
        LANG: 'C.UTF-8',
        TZ: 'UTC',
      });
    },
  );

  it.each(allSpecs(PARENT_ENV))('%s: no credential appears anywhere in the spec', (_name, spec) => {
    const text = JSON.stringify(spec);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it.each(allSpecs({ PATH: '/bin', LIVEKIT_API_SECRET: 'fake-secret-must-not-leak' }))(
    '%s: an allowlisted variable absent from the parent is absent, not empty',
    (_name, spec) => {
      expect(spec.env).toEqual({ PATH: '/bin' });
    },
  );

  it('the child env is a copy: later parent changes do not reach it', () => {
    const parent: NodeJS.ProcessEnv = { ...PARENT_ENV };
    const specs = allSpecs(parent);
    parent.PATH = '/changed';
    parent.LIVEKIT_API_SECRET = 'changed-secret';
    for (const [, spec] of specs) {
      expect(spec.env).not.toBe(parent);
      expect(spec.env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
      expect(spec.env).not.toHaveProperty('LIVEKIT_API_SECRET');
    }
  });
});
