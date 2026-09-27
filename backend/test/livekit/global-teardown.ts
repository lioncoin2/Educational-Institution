import { RUNNING_SERVERS, type RunningServers } from './support/test-servers';

/** After the real LiveKit suite: its servers stopped, their logs removed. */
export default async function globalTeardown(): Promise<void> {
  const shared = globalThis as Record<symbol, RunningServers | undefined>;
  await shared[RUNNING_SERVERS]?.stop();
  shared[RUNNING_SERVERS] = undefined;
}
