import { pinnedServerBinary } from './support/pinned-release';
import {
  RUNNING_SERVERS,
  TEST_SERVERS_VARIABLE,
  startTestServers,
  type RunningServers,
} from './support/test-servers';

/**
 * Before the real LiveKit suite: the pinned server binary, verified
 * (`pinnedServerBinary`), and the suite's two servers started from it on
 * free loopback ports (`startTestServers`) — handed to the test files
 * through the environment their workers inherit. A binary that cannot be
 * had, or a server that does not start, fails the whole run here.
 */
export default async function globalSetup(): Promise<void> {
  const running = await startTestServers(await pinnedServerBinary());
  (globalThis as Record<symbol, RunningServers | undefined>)[RUNNING_SERVERS] = running;
  process.env[TEST_SERVERS_VARIABLE] = JSON.stringify(running.servers);
}
