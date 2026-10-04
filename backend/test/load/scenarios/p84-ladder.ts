/**
 * P8.4 — the off-box capacity ladder as data (design §14). Every rung is the
 * same profile — 1 room, 1 audio publisher, N−1 visible subscribe-only
 * listeners, TURN-free direct UDP, path A — differing only in N, hold and the
 * target ramp. These are deliberately NOT in the general catalog: only the
 * fleet runner (cli/fleet-run.ts) may run them, under per-rung caps
 * (core/safety.ts `fleetLimitsFor`). Pure data + lookup.
 */
import { type Scenario } from '../core/config';

export type RungId = 'S1' | 'S2' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

export interface P84Rung {
  readonly id: RungId;
  readonly participants: number;
  readonly holdSeconds: number;
  /** Target admissions/s (configured; the measured rate is reported). */
  readonly rampPerSecond: number;
}

/** The decided ladder: holds 30/30/60/60/60/120 s; smoke steps S1/S2 first. */
export const P84_RUNGS: readonly P84Rung[] = [
  { id: 'S1', participants: 2, holdSeconds: 30, rampPerSecond: 2 },
  { id: 'S2', participants: 20, holdSeconds: 30, rampPerSecond: 10 },
  { id: 'R1', participants: 100, holdSeconds: 30, rampPerSecond: 10 },
  { id: 'R2', participants: 300, holdSeconds: 30, rampPerSecond: 10 },
  { id: 'R3', participants: 1_000, holdSeconds: 60, rampPerSecond: 10 },
  { id: 'R4', participants: 3_000, holdSeconds: 60, rampPerSecond: 10 },
  { id: 'R5', participants: 5_000, holdSeconds: 60, rampPerSecond: 10 },
  { id: 'R6', participants: 10_000, holdSeconds: 120, rampPerSecond: 10 },
];

export function getRung(id: string): P84Rung | undefined {
  return P84_RUNGS.find((r) => r.id === id);
}

/** The rung as a Scenario, so the shared safety gate (checkScenarioSafety) applies unchanged. */
export function rungScenario(rung: P84Rung, rampPerSecond = rung.rampPerSecond): Scenario {
  return {
    id: `P84_${rung.id}`,
    title: `P8.4 ${rung.id} — ${rung.participants} participants (1 pub + ${rung.participants - 1} listeners)`,
    target: 'livekit',
    rooms: 1,
    listenersPerRoom: rung.participants - 1,
    speakersPerRoom: 1,
    screenSharesPerRoom: 0,
    relay: false,
    rampPerSecond,
    holdSeconds: rung.holdSeconds,
    apiConnections: 0,
    apiRequestsPerSecond: 0,
    expectedTraffic: 'audio/red tone fan-out to visible listeners, TURN-free direct UDP, off-box',
    stopConditions: ['docs/p8/p8.4-verdict-table.md'],
    metrics: ['p84-sample/v1', 'p84-rung-result/v1'],
    notes: 'P8.4 off-box ladder rung; path A (SFU-direct, loadtest- room).',
  };
}
