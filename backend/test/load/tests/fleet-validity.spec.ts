import { type P84Rung } from '../scenarios/p84-ladder';
import { runLocalFleet, startHealth, stopHealth } from './support/fleet-harness';

/**
 * Integration: validity and integrity paths of the REAL controller with REAL
 * local agents (fake media driver). Each must end UNKNOWN — evidence that
 * cannot support a SUT capacity statement is never scored as SUT RED — with a
 * clean teardown and verified cleanup.
 */
const RUNG: P84Rung = { id: 'S2', participants: 4, holdSeconds: 2, rampPerSecond: 20 };

beforeAll(startHealth);
afterAll(stopHealth);

describe('fleet validity (local agents, fake driver)', () => {
  it('a relay candidate in TURN-free mode aborts live (V-turn), never a SUT verdict', async () => {
    const { result } = await runLocalFleet({
      rung: RUNG,
      hosts: 1,
      density: 3,
      marker: (id) => (id.endsWith('L00001') ? 'RELAY' : ''),
    });
    expect(result.watchdog.safetyAbort?.rule).toBe('V-turn');
    expect(result.validity['V-turn'].ok).toBe(false);
    expect(result.verdict).toMatchObject({ class: 'UNKNOWN', failureClass: 'F' });
    expect(result.cleanup.verified).toBe(true);
  }, 120_000);

  it('a duplicate-identity eviction invalidates the rung (V-dup)', async () => {
    const { result } = await runLocalFleet({
      rung: { ...RUNG, holdSeconds: 3 },
      hosts: 1,
      density: 3,
      marker: (id) => (id.endsWith('L00000') ? 'DUP' : ''),
    });
    expect(result.validity['V-dup'].ok).toBe(false);
    expect(result.verdict.class).toBe('UNKNOWN');
  }, 120_000);

  it('an identity on the SFU that nobody minted is a harness-integrity abort', async () => {
    const { result } = await runLocalFleet({ rung: RUNG, hosts: 1, density: 3, foreign: true });
    expect(result.watchdog.safetyAbort?.rule).toBe('server-identity');
    expect(result.validity['V-sampler'].ok).toBe(false);
    expect(result.verdict).toMatchObject({ class: 'UNKNOWN', failureClass: 'F' });
  }, 120_000);

  it('the forced-relay positive control runs end to end but is never a capacity claim', async () => {
    const { result } = await runLocalFleet({
      rung: { ...RUNG, participants: 2 },
      hosts: 1,
      density: 1,
      ice: 'relay',
    });
    expect(result.profile.iceMode).toBe('relay');
    expect(result.gate.gateMet).toBe(true);
    expect(result.transport.relayCandidates).toBe(2);
    expect(result.validity['V-turn']).toEqual({
      ok: false,
      detail: expect.stringContaining('positive control') as string,
    });
    expect(result.verdict.class).toBe('UNKNOWN');
  }, 120_000);
});
