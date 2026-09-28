import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPOSE_FILE,
  REPO_ROOT,
  exampleFile,
  mapping,
  readEnvFile,
  readYaml,
  servicesOf,
  text,
} from '../../support/deployment-files';
import {
  POLICY_FILE,
  freePorts,
  untilServing,
  type RunningServers,
  type TestServer,
} from './test-servers';

/**
 * The image the committed LiveKit service runs — by tag AND digest — read
 * from infra/compose.yaml, never written here: what this runtime starts is
 * what a deployment starts.
 */
export function pinnedImage(): string {
  const services = servicesOf(readYaml(COMPOSE_FILE), COMPOSE_FILE);
  return text(mapping(services.livekit, 'services.livekit').image, 'services.livekit.image');
}

/**
 * The suite's two servers as a deployment runs them (P7.2, brief §12 and the
 * user's item 8), for LIVEKIT_TEST_RUNTIME=docker — the same tests, against
 * the pinned image instead of the release binary:
 *
 *   policy        the committed service itself: `docker compose -f
 *                 infra/compose.yaml up livekit`, in a project of its own —
 *                 its image, command, read-only policy file, allow-listed
 *                 environment, no capabilities, no new privileges, signalling
 *                 on 127.0.0.1:7880 only, ICE on 7881/tcp and 7882/udp, and
 *                 its health check, which `--wait` waits for. The environment
 *                 file is the development example with generated secrets and
 *                 NODE_IP 127.0.0.1, written 0600 into a directory removed at
 *                 the end
 *   auto_create   `docker run` of the same image, file and hardening, plus
 *                 LIVEKIT_ROOM_AUTO_CREATE=true, on a free loopback port —
 *                 the stray variable readiness must catch
 *
 * Nothing is ever pulled (`--pull never`): the pinned digest must already be
 * on this machine, so no other image can stand in for it. Each server's log
 * is followed into a file, as the binary's is written to one. Stopping takes
 * both down — containers, network, volumes — and removes the directory.
 */
export async function startDockerTestServers(): Promise<RunningServers> {
  const image = pinnedImage();
  const directory = mkdtempSync(join(tmpdir(), 'livekit-suite-docker-'));
  const followers: ChildProcess[] = [];
  const project = `livekit-suite-${randomBytes(4).toString('hex')}`;
  const container = `${project}-auto-create`;
  const envFile = join(directory, 'compose.env');
  const compose = [
    'compose',
    '--project-name',
    project,
    '--env-file',
    envFile,
    '--file',
    join(REPO_ROOT, COMPOSE_FILE),
  ];
  const stop = async () => {
    for (const follower of followers.splice(0)) follower.kill('SIGTERM');
    quietly(['rm', '--force', container]);
    quietly([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '10']);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const policy = await startPolicy(directory, envFile, compose, followers);
    const autoCreate = await startAutoCreate(image, container, directory, followers);
    return { servers: [policy, autoCreate], stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startPolicy(
  directory: string,
  envFile: string,
  compose: readonly string[],
  followers: ChildProcess[],
): Promise<TestServer> {
  const server = credentials('policy', 7880, directory);
  const variables = new Map(readEnvFile(exampleFile('development')));
  variables.set('JWT_SECRET', randomBytes(48).toString('base64url'));
  variables.set('STORAGE_SIGNING_SECRET', randomBytes(48).toString('base64url'));
  variables.set('LIVEKIT_API_KEY', server.apiKey);
  variables.set('LIVEKIT_API_SECRET', server.apiSecret);
  variables.set('LIVEKIT_NODE_IP', '127.0.0.1');
  writeFileSync(envFile, [...variables].map(([name, value]) => `${name}=${value}\n`).join(''), {
    mode: 0o600,
  });
  execFileSync('docker', [...compose, 'up', '--detach', '--wait', '--pull', 'never', 'livekit'], {
    stdio: 'ignore',
    timeout: 120_000,
    env: MINIMAL_ENVIRONMENT,
  });
  follow(
    ['docker', ...compose, 'logs', '--follow', '--no-color', '--no-log-prefix', 'livekit'],
    server,
    followers,
  );
  await untilServing(server, () => false);
  return server;
}

/**
 * What the docker CLI is given of this process's environment: nothing a
 * stray LIVEKIT_* or LIVE_* variable could override the environment file with.
 */
export const MINIMAL_ENVIRONMENT: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
};

async function startAutoCreate(
  image: string,
  container: string,
  directory: string,
  followers: ChildProcess[],
): Promise<TestServer> {
  const [port = 0] = await freePorts('tcp', 1);
  const server = credentials('auto_create', port, directory);
  execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--pull',
      'never',
      '--publish',
      `127.0.0.1:${port}:7880/tcp`,
      '--volume',
      `${POLICY_FILE}:/etc/livekit/livekit.yaml:ro`,
      // Named only: the value comes from this call's environment, never argv.
      '--env',
      'LIVEKIT_KEYS',
      '--env',
      'NODE_IP=127.0.0.1',
      '--env',
      'LIVEKIT_ROOM_AUTO_CREATE=true',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      image,
      '--config',
      '/etc/livekit/livekit.yaml',
    ],
    {
      stdio: 'ignore',
      timeout: 60_000,
      env: { ...MINIMAL_ENVIRONMENT, LIVEKIT_KEYS: `${server.apiKey}: ${server.apiSecret}` },
    },
  );
  follow(['docker', 'logs', '--follow', container], server, followers);
  await untilServing(server, () => false);
  return server;
}

/** A server of this runtime, with a key and secret of its own, on `port` of loopback. */
function credentials(name: TestServer['name'], port: number, directory: string): TestServer {
  return {
    name,
    runtime: 'docker',
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    apiKey: `API${randomBytes(6).toString('hex')}`,
    apiSecret: randomBytes(32).toString('base64url'),
    logFile: join(directory, `${name}.log`),
  };
}

/** Follows a container's log into the server's log file, for as long as the suite runs. */
export function follow(
  command: readonly string[],
  server: TestServer,
  followers: ChildProcess[],
): void {
  const log = openSync(server.logFile, 'a');
  const [program = 'docker', ...args] = command;
  followers.push(spawn(program, args, { stdio: ['ignore', log, log], env: MINIMAL_ENVIRONMENT }));
  closeSync(log);
}

/** A cleanup step that must not stop the others. */
function quietly(args: readonly string[]): void {
  try {
    execFileSync('docker', args, { stdio: 'ignore', timeout: 60_000, env: MINIMAL_ENVIRONMENT });
  } catch {
    // Already gone, or never started.
  }
}
