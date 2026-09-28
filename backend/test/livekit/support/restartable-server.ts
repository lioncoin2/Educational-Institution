import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MINIMAL_ENVIRONMENT, follow, pinnedImage } from './docker-servers';
import { pinnedServerBinary } from './pinned-release';
import { POLICY_FILE, freePorts, testRuntime, untilServing, type TestServer } from './test-servers';

/**
 * A policy server of a test file's own, which it can take down and bring
 * back: the pinned release as the suite's runtime runs it (the binary, or the
 * pinned image through Docker), from the committed policy file, on loopback,
 * with a key and secret of its own — the same ports, key and secret every
 * time it starts, and no room surviving a stop, as after a real crash.
 */
export interface RestartableServer {
  readonly server: TestServer;
  /** Kills it at once (SIGKILL): nothing drained, nothing said to its clients. */
  crash(): Promise<void>;
  /** Starts it again, empty, and waits until it serves. */
  start(): Promise<void>;
  /** Kills it, if running, and removes its log. */
  close(): Promise<void>;
}

export async function restartableServer(): Promise<RestartableServer> {
  const directory = mkdtempSync(join(tmpdir(), 'livekit-restartable-'));
  const [port = 0, tcpPort = 0] = await freePorts('tcp', 2);
  const [udpPort = 0] = await freePorts('udp', 1);
  const runtime = testRuntime();
  const server: TestServer = {
    name: 'restartable',
    runtime,
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    apiKey: `API${randomBytes(6).toString('hex')}`,
    apiSecret: randomBytes(32).toString('base64url'),
    logFile: join(directory, 'restartable.log'),
  };
  /** The per-host values, through LiveKit's own variables — as test-servers.ts gives them. */
  const variables = {
    LIVEKIT_KEYS: `${server.apiKey}: ${server.apiSecret}`,
    NODE_IP: '127.0.0.1',
    LIVEKIT_PORT: String(port),
    LIVEKIT_RTC_TCP_PORT: String(tcpPort),
    UDP_PORT: String(udpPort),
  };
  const running = runtime === 'docker' ? dockerRunner(server, variables) : binaryRunner(server);
  await running.start(variables);
  return {
    server,
    crash: () => running.crash(),
    start: () => running.start(variables),
    close: async () => {
      await running.crash();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

interface Runner {
  start(variables: Readonly<Record<string, string>>): Promise<void>;
  crash(): Promise<void>;
}

/** The pinned binary, verified, with `--bind 127.0.0.1`: the suite's default runtime. */
function binaryRunner(server: TestServer): Runner {
  let child: ChildProcess | null = null;
  let binary: string | null = null;
  return {
    async start(variables) {
      binary ??= await pinnedServerBinary();
      const log = openSync(server.logFile, 'a');
      const started = spawn(binary, ['--config', POLICY_FILE, '--bind', '127.0.0.1'], {
        env: variables,
        stdio: ['ignore', log, log],
      });
      closeSync(log);
      child = started;
      await untilServing(server, () => started.exitCode !== null || started.signalCode !== null);
    },
    async crash() {
      const killed = child;
      child = null;
      if (killed === null || killed.exitCode !== null || killed.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => killed.once('exit', () => resolve()));
      killed.kill('SIGKILL');
      await exited;
    },
  };
}

/**
 * The pinned image, hardened as the committed service is, its signalling and
 * ICE ports published on loopback at the same numbers inside and out — so
 * the candidates it advertises are the ones the host reaches. Each start is
 * a container of its own; `--pull never`, as for the suite's servers.
 */
function dockerRunner(server: TestServer, variables: Readonly<Record<string, string>>): Runner {
  const followers: ChildProcess[] = [];
  let container: string | null = null;
  const published = [
    `127.0.0.1:${variables.LIVEKIT_PORT}:${variables.LIVEKIT_PORT}/tcp`,
    `127.0.0.1:${variables.LIVEKIT_RTC_TCP_PORT}:${variables.LIVEKIT_RTC_TCP_PORT}/tcp`,
    `127.0.0.1:${variables.UDP_PORT}:${variables.UDP_PORT}/udp`,
  ];
  return {
    async start() {
      const name = `livekit-suite-restartable-${randomBytes(4).toString('hex')}`;
      execFileSync(
        'docker',
        [
          'run',
          '--detach',
          '--rm',
          '--name',
          name,
          '--pull',
          'never',
          ...published.flatMap((mapping) => ['--publish', mapping]),
          '--volume',
          `${POLICY_FILE}:/etc/livekit/livekit.yaml:ro`,
          // Named only: every value comes from this call's environment, never argv.
          ...Object.keys(variables).flatMap((variable) => ['--env', variable]),
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          pinnedImage(),
          '--config',
          '/etc/livekit/livekit.yaml',
        ],
        { stdio: 'ignore', timeout: 60_000, env: { ...MINIMAL_ENVIRONMENT, ...variables } },
      );
      container = name;
      follow(['docker', 'logs', '--follow', name], server, followers);
      await untilServing(server, () => false);
    },
    async crash() {
      for (const follower of followers.splice(0)) follower.kill('SIGTERM');
      const killed = container;
      container = null;
      if (killed === null) return;
      try {
        execFileSync('docker', ['kill', killed], {
          stdio: 'ignore',
          timeout: 60_000,
          env: MINIMAL_ENVIRONMENT,
        });
      } catch {
        // Already gone.
      }
    },
  };
}
