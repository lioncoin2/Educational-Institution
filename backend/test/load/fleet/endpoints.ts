/**
 * P8.4 — how the controller reaches an agent (design §3), as pure spawn specs
 * for the single spawn primitive (mp/process-manager.ts):
 *
 *  - `ssh`: the SUT initiates; the generator's restricted key runs
 *    `p84-dispatch`, which allows `agent <runId>`, `fetch <runId>` and
 *    `stop <runId>` (and `install`, used at bootstrap). Host keys are pinned
 *    (StrictHostKeyChecking=yes with a dedicated known_hosts file), batch mode,
 *    no agent forwarding, keepalives so a dead link is noticed.
 *  - `local`: the same agent entry as a local child — TEST ONLY (fake driver);
 *    the fleet runner refuses real load on a local endpoint.
 */
import { join } from 'node:path';

import { type SpawnSpec, childEnv } from '../mp/process-manager';

export interface SshEndpoint {
  readonly kind: 'ssh';
  readonly host: string;
  readonly user: string;
  readonly keyPath: string;
  readonly knownHostsPath: string;
}

export interface LocalEndpoint {
  readonly kind: 'local';
  /** The worker entry the local agent forks (the fake worker in tests). */
  readonly workerModule: string;
  readonly runsDir: string;
}

export type AgentEndpoint = SshEndpoint | LocalEndpoint;

export const AGENT_MAIN = join(__dirname, 'agent-main.ts');
const TS_NODE = ['-r', 'ts-node/register/transpile-only'] as const;
const RUN_ID = /^[0-9a-f]{16}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;
const USER = /^[a-z_][a-z0-9_-]*$/;

function sshBase(e: SshEndpoint): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${e.knownHostsPath}`,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=3',
    '-i',
    e.keyPath,
    `${e.user}@${e.host}`,
  ];
}

/** A dispatcher command over SSH (`agent`, `fetch` or `stop`) for one run. */
export function sshCommandSpec(
  e: SshEndpoint,
  verb: 'agent' | 'fetch' | 'stop',
  runId: string,
  parentEnv: NodeJS.ProcessEnv,
): SpawnSpec {
  if (!RUN_ID.test(runId)) throw new RangeError(`invalid runId ${runId}`);
  if (!HOST.test(e.host) || !USER.test(e.user))
    throw new RangeError(`invalid ssh target ${e.user}@${e.host}`);
  return {
    label: `ssh-${verb}:${e.host}`,
    mode: 'exec',
    command: 'ssh',
    args: [...sshBase(e), verb, runId],
    env: childEnv(parentEnv),
  };
}

/** The spawn spec that starts one agent for `runId` on `endpoint`. */
export function agentSpawnSpec(
  endpoint: AgentEndpoint,
  runId: string,
  parentEnv: NodeJS.ProcessEnv,
): SpawnSpec {
  if (endpoint.kind === 'ssh') return sshCommandSpec(endpoint, 'agent', runId, parentEnv);
  if (!RUN_ID.test(runId)) throw new RangeError(`invalid runId ${runId}`);
  return {
    label: 'agent:local',
    mode: 'exec',
    command: process.execPath,
    args: [
      ...TS_NODE,
      AGENT_MAIN,
      '--run',
      runId,
      '--runs-dir',
      endpoint.runsDir,
      '--local',
      '--worker-module',
      endpoint.workerModule,
    ],
    env: childEnv(parentEnv),
  };
}
