/**
 * P8 load harness — the safety gate. These are HARD caps the harness refuses to
 * exceed no matter what scenario or flags ask for: an accidental `--listeners
 * 500000` cannot become real load. Safety is independent of well-formedness
 * (core/config.ts validates shape; this file forbids dangerous magnitudes) and
 * is never bypassable — there is no `--force`.
 *
 * The ceilings sit a little above the P8 *targets* (3,000/room, 10,000 total) so
 * the planned ladder can run, but refuse the runaway case. Rationale per limit
 * is in docs/p8.1-load-harness.md §Safety.
 */
import {
  type HarnessConfig,
  type Scenario,
  participantsPerRoom,
  totalParticipants,
  totalPublishers,
} from './config';

export interface SafetyLimits {
  readonly maxTotalParticipants: number;
  readonly maxParticipantsPerRoom: number;
  readonly maxRooms: number;
  readonly maxPublishersPerRoom: number;
  readonly maxTotalPublishers: number;
  readonly maxDurationSeconds: number;
  readonly maxRampPerSecond: number;
  readonly maxApiConnections: number;
  readonly maxApiRequestsPerSecond: number;
}

/**
 * The default ceilings. 12,000 total / 3,500 per room leave headroom above the
 * targets; 1,800 s caps any single run at 30 minutes; 200/s ramp prevents a
 * thundering-herd connect that itself looks like a reconnect storm.
 */
export const SAFETY_LIMITS: SafetyLimits = {
  maxTotalParticipants: 12_000,
  maxParticipantsPerRoom: 3_500,
  maxRooms: 200,
  maxPublishersPerRoom: 50,
  maxTotalPublishers: 2_000,
  maxDurationSeconds: 1_800,
  maxRampPerSecond: 200,
  maxApiConnections: 12_000,
  maxApiRequestsPerSecond: 5_000,
};

/** Every safety violation for a scenario, as human-readable lines. Empty = safe. */
export function checkScenarioSafety(s: Scenario, limits: SafetyLimits = SAFETY_LIMITS): string[] {
  const v: string[] = [];
  const perRoom = participantsPerRoom(s);
  const total = totalParticipants(s);
  const publishers = s.speakersPerRoom + s.screenSharesPerRoom;
  if (total > limits.maxTotalParticipants)
    v.push(`total participants ${total} exceeds cap ${limits.maxTotalParticipants}`);
  if (perRoom > limits.maxParticipantsPerRoom)
    v.push(`participants/room ${perRoom} exceeds cap ${limits.maxParticipantsPerRoom}`);
  if (s.rooms > limits.maxRooms) v.push(`rooms ${s.rooms} exceeds cap ${limits.maxRooms}`);
  if (publishers > limits.maxPublishersPerRoom)
    v.push(`publishers/room ${publishers} exceeds cap ${limits.maxPublishersPerRoom}`);
  if (totalPublishers(s) > limits.maxTotalPublishers)
    v.push(`total publishers ${totalPublishers(s)} exceeds cap ${limits.maxTotalPublishers}`);
  if (s.holdSeconds > limits.maxDurationSeconds)
    v.push(`duration ${s.holdSeconds}s exceeds cap ${limits.maxDurationSeconds}s`);
  if (s.rampPerSecond > limits.maxRampPerSecond)
    v.push(`ramp ${s.rampPerSecond}/s exceeds cap ${limits.maxRampPerSecond}/s`);
  if (s.apiConnections > limits.maxApiConnections)
    v.push(`api connections ${s.apiConnections} exceeds cap ${limits.maxApiConnections}`);
  if (s.apiRequestsPerSecond > limits.maxApiRequestsPerSecond)
    v.push(`api rps ${s.apiRequestsPerSecond} exceeds cap ${limits.maxApiRequestsPerSecond}`);
  return v;
}

/**
 * P8.4 per-rung caps (decision D-8, design §14 — no blanket raise). The global
 * SAFETY_LIMITS above stay as they are for every other scenario; a fleet rung
 * is gated by the SAME function (`checkScenarioSafety`) with a profile whose
 * ceilings ARE that rung: exactly its N in one room, one publisher, its hold,
 * its ramp, no API load.
 */
export function fleetLimitsFor(rung: {
  readonly participants: number;
  readonly holdSeconds: number;
  readonly rampPerSecond: number;
}): SafetyLimits {
  return {
    maxTotalParticipants: rung.participants,
    maxParticipantsPerRoom: rung.participants,
    maxRooms: 1,
    maxPublishersPerRoom: 1,
    maxTotalPublishers: 1,
    maxDurationSeconds: rung.holdSeconds,
    maxRampPerSecond: rung.rampPerSecond,
    maxApiConnections: 0,
    maxApiRequestsPerSecond: 0,
  };
}

/** Participants per worker process validated so far (P8.3: 10). Higher needs calibration evidence. */
export const VALIDATED_DENSITY = 10;
/** Densities a calibration run may use, and the rungs it may run on (decision D-9). */
export const CALIBRATION_DENSITIES: readonly number[] = [10, 20, 30];
export const CALIBRATION_RUNGS: readonly string[] = ['S2', 'R1', 'R2'];

export interface FleetRequest {
  readonly rungId: string;
  readonly hosts: number;
  readonly provisionedHosts: number;
  readonly density: number;
  /** Highest density proven GREEN by an attached calibration result (default VALIDATED_DENSITY). */
  readonly provenDensity: number;
  readonly calibration: boolean;
}

/** The fleet-specific part of the per-rung gate (hosts, density, calibration scope). */
export function checkFleetRequest(r: FleetRequest): string[] {
  const v: string[] = [];
  if (!Number.isInteger(r.hosts) || r.hosts < 1) v.push('at least one generator host is required');
  if (r.hosts > r.provisionedHosts)
    v.push(`hosts ${r.hosts} exceeds provisioned generators ${r.provisionedHosts}`);
  if (!Number.isInteger(r.density) || r.density < 1) v.push('density must be a whole number >= 1');
  if (r.calibration) {
    if (!CALIBRATION_RUNGS.includes(r.rungId))
      v.push(`calibration runs only on ${CALIBRATION_RUNGS.join('/')}, not ${r.rungId}`);
    if (!CALIBRATION_DENSITIES.includes(r.density))
      v.push(`calibration density must be one of ${CALIBRATION_DENSITIES.join('/')}`);
  } else if (r.density > r.provenDensity) {
    v.push(
      `density ${r.density} exceeds the proven density ${r.provenDensity} (run a calibration)`,
    );
  }
  return v;
}

export interface GateDecision {
  /** true => actually connect/generate; false => dry-run only. */
  readonly willGenerateLoad: boolean;
  /** Reasons a real run is refused (empty when willGenerateLoad, or in a clean dry-run). */
  readonly refusals: readonly string[];
  /** Human note describing what will happen. */
  readonly mode: 'dry-run' | 'real-load' | 'refused';
}

/**
 * The single decision point. A real run requires ALL of:
 *   - `--allow-load`,
 *   - a `--target`,
 *   - zero safety violations.
 * Anything missing downgrades to a dry-run; a safety violation with
 * `--allow-load` set is a hard refusal (so the operator sees why, rather than a
 * silent downgrade). A plain dry-run is always allowed.
 */
export function decideGate(
  config: HarnessConfig,
  limits: SafetyLimits = SAFETY_LIMITS,
): GateDecision {
  const safety = checkScenarioSafety(config.scenario, limits);
  if (!config.allowLoad) {
    return { willGenerateLoad: false, refusals: [], mode: 'dry-run' };
  }
  const refusals: string[] = [...safety];
  if (config.target === null) refusals.push('real load needs an explicit --target');
  if (refusals.length > 0) return { willGenerateLoad: false, refusals, mode: 'refused' };
  return { willGenerateLoad: true, refusals: [], mode: 'real-load' };
}
