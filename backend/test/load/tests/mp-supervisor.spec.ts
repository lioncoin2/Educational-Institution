import { join } from 'node:path';

import { type Scenario } from '../core/config';
import { type LivekitEnv } from '../livekit/tokens';
import { getScenario } from '../scenarios/catalog';
import { type SupervisorOptions, runSupervisor } from '../mp/supervisor';

/**
 * Integration tests for the REAL supervisor forking the REAL worker lifecycle
 * with a fake media driver (no rtc-node, no network): publisher-first
 * sequencing, the exact-N gate, abort, and (P8.3.8) teardown classification and
 * process accounting. Network ops are injected fakes; fake-driver behaviour is
 * chosen per participant by a marker in its ticket token.
 */
const FAKE_WORKER = join(__dirname, '..', 'mp', 'fake-worker.ts');
const ENV: LivekitEnv = { url: 'ws://x', apiUrl: 'http://x', apiKey: 'k', apiSecret: 's' };

type Marker = (p: { identity: string; role: string }) => string;

function deps(marker: Marker = () => '') {
  const deleted: string[][] = [];
  return {
    deleted,
    mintTicket: async (_e: LivekitEnv, p: { identity: string; role: string }) => ({
      url: ENV.url,
      token: `${marker(p)}-t-${p.identity}`,
    }),
    ensureRooms: async () => undefined,
    deleteRooms: async (_e: LivekitEnv, rooms: readonly string[]) => {
      deleted.push([...rooms]);
    },
  };
}

/** 1 publisher + 1 listener (MP_PUB), short hold, test-sized timeouts. */
function run(d: ReturnType<typeof deps>, over: Partial<SupervisorOptions> = {}) {
  const scenario: Scenario = { ...getScenario('MP_PUB')!, holdSeconds: 1 };
  return runSupervisor({
    scenario,
    env: ENV,
    workers: 2,
    mediaPath: 'direct',
    holdSeconds: 1,
    workerModule: FAKE_WORKER,
    phaseATimeoutMs: 15_000,
    phaseBTimeoutMs: 15_000,
    deps: { mintTicket: d.mintTicket, ensureRooms: d.ensureRooms, deleteRooms: d.deleteRooms },
    ...over,
  });
}

const listenerOnly =
  (marker: string): Marker =>
  (p) =>
    p.role === 'listener' ? marker : '';

describe('MP supervisor (two-phase, real worker lifecycle, fake driver)', () => {
  it('publishes first, ramps listeners, meets the exact gate, and every worker cleans and exits', async () => {
    const d = deps();
    const result = await run(d);
    expect(result.gateMet).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.connected).toBe(2);
    expect(result.publisherPublished).toBe(true);
    expect(result.workerCrashes).toBe(0);
    expect(result.teardown).toEqual({
      workers: result.workers,
      cleaned: result.workers,
      timedOut: 0,
      exitedUnclean: 0,
      forced: 0,
    });
    expect(d.deleted.length).toBeGreaterThan(0);
  }, 40_000);

  it('aborts in phase A when the publisher fails — listeners never start — and still cleans up', async () => {
    const d = deps((p) => (p.role === 'listener' ? '' : 'PUBFAIL'));
    const result = await run(d);
    expect(result.aborted).toBe(true);
    expect(result.gateMet).toBe(false);
    expect(result.abortReason).toContain('phase A');
    expect(result.publisherPublished).toBe(false);
    expect(result.connected).toBe(1); // listener workers were never forked
    expect(result.teardown.cleaned).toBe(result.workers);
    expect(d.deleted.length).toBeGreaterThan(0);
  }, 40_000);

  it('a worker whose teardown hangs reports a bounded timeout, distinguished from cleanup', async () => {
    const d = deps(listenerOnly('HANG'));
    const result = await run(d, { teardownTimeoutMs: 300, shutdownGraceMs: 8_000 });
    expect(result.gateMet).toBe(true); // the run itself passed …
    expect(result.teardown).toMatchObject({ timedOut: 1, forced: 0, exitedUnclean: 0 });
    expect(result.teardown.cleaned).toBe(result.workers - 1); // … but teardown is NOT all clean
    expect(d.deleted.length).toBeGreaterThan(0);
  }, 40_000);

  it('a worker still alive at the grace deadline is recorded as FORCED, not as cleaned', async () => {
    const d = deps(listenerOnly('HANG'));
    const result = await run(d, { teardownTimeoutMs: 20_000, shutdownGraceMs: 800 });
    expect(result.teardown).toMatchObject({ forced: 1, timedOut: 0 });
    expect(result.teardown.cleaned).toBe(result.workers - 1);
    expect(result.workerCrashes).toBe(0); // a forced kill at shutdown is not a crash
  }, 40_000);

  it('library helper child processes (like rtc-node lsb_release) are not worker crashes', async () => {
    const d = deps(() => 'SPAWN');
    const result = await run(d);
    expect(result.gateMet).toBe(true);
    expect(result.workerCrashes).toBe(0);
    expect(result.teardown.cleaned).toBe(result.workers); // accounting = owned processes only
  }, 40_000);
});
