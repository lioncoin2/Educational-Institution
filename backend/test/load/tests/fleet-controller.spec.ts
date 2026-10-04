import { validateResult } from '../results/schema';
import { type RungResult } from '../results/schema';
import { type P84Rung } from '../scenarios/p84-ladder';
import { runLocalFleet, startHealth, stopHealth } from './support/fleet-harness';

/**
 * Integration: the REAL controller + REAL local agents + REAL worker lifecycle
 * (fake media driver), two agents — the fleet path minus rtc-node, SSH and
 * LiveKit. Lifecycle cases: publisher-first, global ramp, exact-N + media gate,
 * teardown accounting and deterministic cleanup.
 */
const RUNG: P84Rung = { id: 'S2', participants: 6, holdSeconds: 4, rampPerSecond: 20 };

/** Generator-host rules a contended CI machine can trip (only these may fail V-gen here). */
const CONTENTION = /^(G-lag|G-cpu|G-cpu-hot)(, (G-lag|G-cpu|G-cpu-hot))*$/;

/**
 * A healthy local rung is GREEN unless the TEST MACHINE itself is contended
 * (jest runs suites in parallel): then only generator-host rules (G-lag /
 * G-cpu*) may fail V-gen. Anything else is a real failure.
 */
function expectHealthyVerdict(r: RungResult): void {
  if (r.verdict.class === 'GREEN') return;
  const failed = Object.fromEntries(Object.entries(r.validity).filter(([, v]) => !v.ok));
  // Printed in full on failure, so an unexpected cause is visible, not just its id.
  expect({ class: r.verdict.class, failed }).toEqual({
    class: 'UNKNOWN',
    failed: { 'V-gen': { ok: false, detail: expect.stringMatching(CONTENTION) as string } },
  });
}

beforeAll(startHealth);
afterAll(stopHealth);

describe('fleet controller (local agents, fake driver)', () => {
  it('publisher first, global ramp, exact-N + media gate, hold, clean teardown and cleanup', async () => {
    const { result, rooms, runId, samples } = await runLocalFleet({
      rung: RUNG,
      hosts: 2,
      density: 2,
    });
    expect(validateResult({ ...result, evidence: [] })).toEqual([]);
    expect(result.watchdog.safetyAbort).toBeNull(); // prints the whole abort record if not
    // The global ramp never exceeds its configured rate, however long phase A took (a ramp
    // that accrued credit during phase A once admitted every listener in one tick).
    expect(result.timing.rampRate.actual).not.toBeNull();
    expect(result.timing.rampRate.actual).toBeLessThanOrEqual(RUNG.rampPerSecond);
    expect(result.gate).toMatchObject({
      connected: 6,
      failed: 0,
      crashes: 0,
      publisherPublished: true,
      publisherServerConfirmed: true,
      subscribed: 5,
      receiving: 5,
      gateMet: true,
      serverIdentitySetMatch: { atGate: true, atHoldEnd: true },
    });
    // One room, capped at exactly N, created and deleted by the controller only.
    expect(rooms.created).toEqual([{ room: `loadtest-p84-${runId}`, maxParticipants: 6 }]);
    expect(rooms.deleted).toEqual([`loadtest-p84-${runId}`]);
    // Disjoint identities, minted once each: 1 publisher + 5 listeners.
    const ids = [...rooms.minted.keys()];
    expect(new Set(ids).size).toBe(6);
    expect(ids.filter((id) => id.endsWith('-P0'))).toHaveLength(1);
    expect(result.transport.relayCandidates).toBe(0);
    expect(Object.keys(result.transport.selectedPairs)).toEqual(['udp/host->host:7882']);
    expect(result.media.contentProbe.probes).toBeGreaterThan(0);
    expect(result.media.contentProbe.ok).toBe(result.media.contentProbe.probes);
    expect(result.cleanup.teardown).toEqual({
      workers: 4,
      cleaned: 4,
      timedOut: 0,
      exitedUnclean: 0,
      forced: 0,
    });
    expect(result.cleanup).toMatchObject({
      cleanupRooms: 0,
      cleanupParticipants: 0,
      cleanupRows: 0,
      verified: true,
    });
    expect(Object.values(result.cleanup.generatorProcesses)).toEqual([0, 0]);
    expect(result.generator.generatorCount).toBe(2);
    expect(Object.keys(samples)).toContain('sut');
    expectHealthyVerdict(result);
  }, 120_000);

  it('aborts in phase A when the publisher cannot publish: no listener is ever minted', async () => {
    const { result, rooms } = await runLocalFleet({
      rung: RUNG,
      hosts: 1,
      density: 5,
      marker: (_id, role) => (role === 'publisher' ? 'PUBFAIL' : ''),
    });
    expect(rooms.minted.size).toBe(1);
    expect(result.gate.gateMet).toBe(false);
    expect(result.verdict.reasons.join(' ')).toContain('phase A');
    expect(result.cleanup.verified).toBe(true);
    // An abort this early may leave no judged generator evidence: then it fails
    // closed as UNKNOWN (generator limitation cannot be ruled out), never GREEN.
    expect(['RED', 'UNKNOWN']).toContain(result.verdict.class);
  }, 120_000);

  it('connected is not healthy: a listener that never subscribes fails the gate', async () => {
    const { result } = await runLocalFleet({
      rung: RUNG,
      hosts: 1,
      density: 5,
      marker: (id) => (id.endsWith('L00002') ? 'NOSUB' : ''),
      timing: { gateTailMs: 3_000 },
    });
    expect(result.gate.connected).toBe(6);
    expect(result.gate.subscribed).toBe(4);
    expect(result.gate.gateMet).toBe(false);
    expect(result.verdict.reasons.join(' ')).toContain('subscribed 4/5');
    expect(result.cleanup.verified).toBe(true);
  }, 120_000);

  it('regression: one real worker lag spike is never a sustained G-lag (no safety abort)', async () => {
    // Captured intermittent failure: a single 392 ms window was re-judged on every later sample
    // (the controller kept a running max per agent) → "G-lag > 200 (4 consecutive samples)".
    const { result } = await runLocalFleet({
      rung: RUNG,
      hosts: 1,
      density: 5,
      marker: (identity) => (identity.endsWith('-L00001') ? 'LAG' : ''),
    });
    expect(result.watchdog.safetyAbort).toBeNull();
    expect(result.gate.gateMet).toBe(true);
    expect(result.verdict.class).not.toBe('RED');
  }, 120_000);

  it('a hung disconnect is a bounded teardown timeout, distinguished from cleanup', async () => {
    const { result } = await runLocalFleet({
      rung: RUNG,
      hosts: 1,
      density: 5,
      marker: (id) => (id.endsWith('L00001') ? 'HANG' : ''),
      timing: { teardownTimeoutMs: 300 },
    });
    expect(result.gate.gateMet).toBe(true);
    expect(result.cleanup.teardown).toMatchObject({ workers: 2, timedOut: 1, forced: 0 });
    expect(result.cleanup.teardown.cleaned).toBe(1);
  }, 120_000);
});
