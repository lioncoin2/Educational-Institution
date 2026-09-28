import { startDockerTestServers } from './support/docker-servers';
import { pinnedServerBinary } from './support/pinned-release';
import {
  RUNNING_SERVERS,
  TEST_SERVERS_VARIABLE,
  startTestServers,
  testRuntime,
  type RunningServers,
} from './support/test-servers';

/**
 * Before the real LiveKit suite: its two servers, started on loopback —
 * from the pinned server binary, verified (`pinnedServerBinary`), by
 * default; or, with LIVEKIT_TEST_RUNTIME=docker, from the pinned image as the
 * committed compose file runs it (`startDockerTestServers`) — and handed to
 * the test files through the environment their workers inherit. A binary or
 * image that cannot be had, or a server that does not start, fails the whole
 * run here.
 */
export default async function globalSetup(): Promise<void> {
  const running =
    testRuntime() === 'docker'
      ? await startDockerTestServers()
      : await startTestServers(await pinnedServerBinary());
  (globalThis as Record<symbol, RunningServers | undefined>)[RUNNING_SERVERS] = running;
  process.env[TEST_SERVERS_VARIABLE] = JSON.stringify(running.servers);
}
