import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT } from '../../support/deployment-files';

/** The committed server policy: the file every environment runs (infra/livekit/livekit.yaml). */
export const POLICY_FILE = join(REPO_ROOT, 'infra', 'livekit', 'livekit.yaml');

/**
 * The suite's two servers — both the pinned release, both started from the
 * committed policy file:
 *
 *   policy        as deployed: the file, and only the per-host values given
 *                 through LiveKit's own variables
 *   auto_create   the same plus LIVEKIT_ROOM_AUTO_CREATE=true — the stray
 *                 variable that turns the file's `auto_create: false` back
 *                 on (SRV pkg/config/config.go:911), for readiness to catch
 *
 * and, apart, one a test file starts, stops and starts again itself
 * (`restartable-server.ts`): a policy server of its own.
 */
export type TestServerName = 'policy' | 'auto_create' | 'restartable';

/**
 * How the suite runs its servers (LIVEKIT_TEST_RUNTIME): the pinned release
 * binary, verified — the default, and CI's — or the pinned image through
 * Docker, as the committed compose file runs it (`docker-servers.ts`).
 */
export type TestRuntime = 'binary' | 'docker';

/** The runtime this run asked for; anything but the two is a mistake, never a default. */
export function testRuntime(env: NodeJS.ProcessEnv = process.env): TestRuntime {
  const asked = env.LIVEKIT_TEST_RUNTIME?.trim() ?? '';
  if (asked === '' || asked === 'binary') return 'binary';
  if (asked === 'docker') return 'docker';
  throw new Error(
    `LIVEKIT_TEST_RUNTIME must be "binary" or "docker", not ${JSON.stringify(asked)}.`,
  );
}

export interface TestServer {
  readonly name: TestServerName;
  readonly runtime: TestRuntime;
  /** LIVEKIT_URL: where clients connect — ws: on loopback. */
  readonly url: string;
  /** The same port over http: the room API, /rtc/validate and GET /. */
  readonly httpUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  /** The server's own log, JSON lines (the policy file's `logging`). */
  readonly logFile: string;
}

/** How global-setup.ts hands the servers to the test files. */
export const TEST_SERVERS_VARIABLE = 'LIVEKIT_TEST_SERVERS';

/** Where global-setup.ts leaves the running servers for global-teardown.ts (a global both see). */
export const RUNNING_SERVERS = Symbol.for('institution.livekit-suite.servers');

/** One of the servers global-setup.ts started. */
export function testServer(name: TestServerName): TestServer {
  const raw = process.env[TEST_SERVERS_VARIABLE];
  if (raw === undefined) {
    throw new Error(
      'No LiveKit test servers are running: run this suite with npm run test:livekit.',
    );
  }
  const server = (JSON.parse(raw) as TestServer[]).find((candidate) => candidate.name === name);
  if (server === undefined) throw new Error(`No LiveKit test server is named ${name}.`);
  return server;
}

/** One line of a server's log: zap's JSON, its fields at the top level. */
export type ServerLogLine = Readonly<Record<string, unknown>>;

/** Every whole line the server has logged so far — not one it is still writing. */
export function serverLog(server: TestServer): ServerLogLine[] {
  const written = readFileSync(server.logFile, 'utf8');
  return written
    .slice(0, written.lastIndexOf('\n') + 1)
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as ServerLogLine);
}

export interface RunningServers {
  readonly servers: readonly TestServer[];
  stop(): Promise<void>;
}

/**
 * Starts both servers on free ports, each with a random key and secret of
 * its own, and waits until each answers `GET /` with "OK" — or throws,
 * having stopped whatever it started. Each server receives these variables
 * and nothing else: never this process's environment, where any stray
 * LIVEKIT_<PATH> would override the policy — the allow-list the compose
 * file gives the container, too:
 *
 *   LIVEKIT_KEYS           "<key>: <secret>" (SRV cmd/server/main.go:60-64)
 *   NODE_IP                127.0.0.1, the address it advertises (main.go:70-74)
 *   LIVEKIT_PORT           signalling and the API, for `port`; and
 *   LIVEKIT_RTC_TCP_PORT   ICE over TCP, for `rtc.tcp_port` — both generated
 *                          from the config's paths (pkg/config/config.go:901-980)
 *   UDP_PORT               the ICE UDP mux, for `rtc.udp_port` (main.go:75-79)
 *
 * plus `--bind 127.0.0.1` (main.go:43-46), so the HTTP port listens on
 * loopback only.
 */
export async function startTestServers(binary: string): Promise<RunningServers> {
  const directory = mkdtempSync(join(tmpdir(), 'livekit-suite-'));
  const children: ChildProcess[] = [];
  // Should this process end without the teardown — a test calling
  // process.exit, say — the servers and their logs go with it.
  const abandon = () => {
    for (const child of children) child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  };
  process.once('exit', abandon);
  const stop = async () => {
    process.removeListener('exit', abandon);
    await Promise.all(children.map(stopped));
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const servers = [
      await startOne(binary, 'policy', {}, directory, children),
      await startOne(
        binary,
        'auto_create',
        { LIVEKIT_ROOM_AUTO_CREATE: 'true' },
        directory,
        children,
      ),
    ];
    return { servers, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Starts one server — kept in `children` from its first moment — and waits until it serves. */
async function startOne(
  binary: string,
  name: TestServerName,
  overrides: Readonly<Record<string, string>>,
  directory: string,
  children: ChildProcess[],
): Promise<TestServer> {
  const [port = 0, tcpPort = 0] = await freePorts('tcp', 2);
  const [udpPort = 0] = await freePorts('udp', 1);
  const server: TestServer = {
    name,
    runtime: 'binary',
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    apiKey: `API${randomBytes(6).toString('hex')}`,
    apiSecret: randomBytes(32).toString('base64url'),
    logFile: join(directory, `${name}.log`),
  };
  const log = openSync(server.logFile, 'a');
  const child = spawn(binary, ['--config', POLICY_FILE, '--bind', '127.0.0.1'], {
    env: {
      LIVEKIT_KEYS: `${server.apiKey}: ${server.apiSecret}`,
      NODE_IP: '127.0.0.1',
      LIVEKIT_PORT: String(port),
      LIVEKIT_RTC_TCP_PORT: String(tcpPort),
      UDP_PORT: String(udpPort),
      ...overrides,
    },
    stdio: ['ignore', log, log],
  });
  children.push(child);
  closeSync(log);
  await untilServing(server, () => child.exitCode !== null || child.signalCode !== null);
  return server;
}

/**
 * Until the server answers `GET /` with 200 "OK" (SRV pkg/service/server.go:
 * 406-427). A failed start exits 0 (main.go:190-192), so any exit — as
 * `exited` reports it — fails.
 */
export async function untilServing(server: TestServer, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited()) {
      throw new Error(`The LiveKit test server "${server.name}" exited at start:\n${tail(server)}`);
    }
    try {
      const response = await fetch(`${server.httpUrl}/`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200 && (await response.text()) === 'OK') return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `The LiveKit test server "${server.name}" did not serve within 30 s:\n${tail(server)}`,
  );
}

/** The end of a server's log, for a failure's message. It never holds the secret. */
function tail(server: TestServer): string {
  return readFileSync(server.logFile, 'utf8')
    .split(server.apiSecret)
    .join('<secret>')
    .slice(-2_000);
}

/** Stops a server: SIGTERM, then SIGKILL if it has not exited within ten seconds. */
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(timer);
}

/** Ports free on every interface (ICE listens on all of them), held together, then released. */
export async function freePorts(protocol: 'tcp' | 'udp', count: number): Promise<number[]> {
  const held: Array<{ port: number; release: () => Promise<void> }> = [];
  for (let i = 0; i < count; i += 1) held.push(await (protocol === 'tcp' ? tcpPort() : udpPort()));
  await Promise.all(held.map(({ release }) => release()));
  return held.map(({ port }) => port);
}

async function tcpPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, resolve));
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port');
  return {
    port: address.port,
    release: () => new Promise((resolve) => listener.close(() => resolve())),
  };
}

async function udpPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, resolve));
  return {
    port: socket.address().port,
    release: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}
