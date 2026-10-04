/**
 * P8 load harness — configuration model, argument parsing and well-formedness
 * validation. Pure: no I/O, no network, no process exit. The CLI (cli/run.ts)
 * turns argv into a HarnessConfig here, the safety gate (core/safety.ts) decides
 * whether it may run, and only then does anything connect.
 *
 * Nothing in this file imports a vendor SDK or the WebRTC client; it is safe to
 * load from a unit test and from the default dry-run path.
 */

/** Which plane a scenario drives. */
export type Target = 'api' | 'livekit' | 'combined';

export const TARGETS: readonly Target[] = ['api', 'livekit', 'combined'];

/** Controlled connect/disconnect/reconnect churn, applied after full ramp-up. */
export interface ChurnSpec {
  /** Fraction (0..1) of connected participants dropped then re-added each cycle. */
  readonly dropFraction: number;
  /** Seconds between the start of one drop+re-add cycle and the next. */
  readonly cycleSeconds: number;
  /** How many drop+re-add cycles to run. */
  readonly cycles: number;
}

/**
 * One deterministic scenario. Counts are per room; the derived helpers below
 * fold them into totals. A "speaker" is an audio publisher (the teacher is
 * speaker #1); a "screen share" is a video publisher.
 */
export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly target: Target;
  readonly rooms: number;
  readonly listenersPerRoom: number;
  readonly speakersPerRoom: number;
  readonly screenSharesPerRoom: number;
  readonly relay: boolean;
  /** New participants admitted per second during ramp-up. */
  readonly rampPerSecond: number;
  /** Seconds to hold at full occupancy once ramped. */
  readonly holdSeconds: number;
  /** Concurrent realtime WebSocket connections (api / combined). */
  readonly apiConnections: number;
  /** Target sustained HTTP requests/second (api / combined). */
  readonly apiRequestsPerSecond: number;
  readonly expectedTraffic: string;
  readonly stopConditions: readonly string[];
  readonly metrics: readonly string[];
  readonly notes: string;
  /** Present only for churn scenarios. */
  readonly churn?: ChurnSpec;
}

export interface HarnessConfig {
  readonly scenario: Scenario;
  /** The media/API base the run targets. null means none supplied (dry-run only). */
  readonly target: string | null;
  /** false => dry-run (default): validate, print the plan, connect to nothing. */
  readonly allowLoad: boolean;
  /** Where the metrics collector writes CSV; null disables collection. */
  readonly outCsv: string | null;
  readonly sampleIntervalMs: number;
}

export interface ParseOk {
  readonly ok: true;
  readonly config: HarnessConfig;
}
export interface ParseErr {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type ParseResult = ParseOk | ParseErr;

/** Media participants LiveKit sees in one room. */
export function participantsPerRoom(s: Scenario): number {
  return s.listenersPerRoom + s.speakersPerRoom + s.screenSharesPerRoom;
}
/** Media participants across every room. */
export function totalParticipants(s: Scenario): number {
  return participantsPerRoom(s) * s.rooms;
}
/** Publishers (audio + video) across every room — the fan-in the SFU forwards. */
export function totalPublishers(s: Scenario): number {
  return (s.speakersPerRoom + s.screenSharesPerRoom) * s.rooms;
}

const NUMERIC_FLAGS = new Set([
  'rooms',
  'listeners',
  'speakers',
  'screen',
  'ramp',
  'duration',
  'api-connections',
  'api-rps',
  'interval',
]);
const STRING_FLAGS = new Set(['scenario', 'target', 'out', 'kind']);
const BOOL_FLAGS = new Set(['relay', 'allow-load', 'list', 'help']);

export interface RawArgs {
  readonly strings: Map<string, string>;
  readonly numbers: Map<string, number>;
  readonly bools: Set<string>;
  readonly unknown: readonly string[];
  readonly bad: readonly string[];
}

/** Splits argv (already sliced past node + script) into typed buckets. Pure. */
export function readArgs(argv: readonly string[]): RawArgs {
  const strings = new Map<string, string>();
  const numbers = new Map<string, number>();
  const bools = new Set<string>();
  const unknown: string[] = [];
  const bad: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) {
      unknown.push(String(token));
      continue;
    }
    const name = token.slice(2);
    if (BOOL_FLAGS.has(name)) {
      bools.add(name);
    } else if (NUMERIC_FLAGS.has(name)) {
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith('--')) {
        bad.push(`--${name} needs a number`);
        continue;
      }
      i += 1;
      const value = Number(raw);
      if (!Number.isFinite(value)) bad.push(`--${name} needs a number`);
      else numbers.set(name, value);
    } else if (STRING_FLAGS.has(name)) {
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith('--')) {
        bad.push(`--${name} needs a value`);
        continue;
      }
      i += 1;
      strings.set(name, raw);
    } else {
      unknown.push(token);
    }
  }
  return { strings, numbers, bools, unknown, bad };
}

/**
 * Builds a custom scenario from flags when --scenario is not used. Defaults are
 * deliberately tiny so a bare invocation describes almost nothing.
 */
export function customScenario(args: RawArgs): Scenario {
  const kind = args.strings.get('kind');
  const target: Target = TARGETS.includes(kind as Target) ? (kind as Target) : 'livekit';
  return {
    id: 'custom',
    title: 'Custom (built from flags)',
    target,
    rooms: args.numbers.get('rooms') ?? 1,
    listenersPerRoom: args.numbers.get('listeners') ?? 0,
    speakersPerRoom: args.numbers.get('speakers') ?? 0,
    screenSharesPerRoom: args.numbers.get('screen') ?? 0,
    relay: args.bools.has('relay'),
    rampPerSecond: args.numbers.get('ramp') ?? 10,
    holdSeconds: args.numbers.get('duration') ?? 60,
    apiConnections: args.numbers.get('api-connections') ?? 0,
    apiRequestsPerSecond: args.numbers.get('api-rps') ?? 0,
    expectedTraffic: 'custom — estimate from the bandwidth model in the P8 plan',
    stopConditions: ['all §9 safety signals'],
    metrics: ['host', 'livekit', 'api'],
    notes: 'Ad-hoc scenario; prefer a named scenario from the catalog for repeatable runs.',
  };
}

/** Applies numeric/bool overrides from flags onto a base scenario. Pure. */
export function applyOverrides(base: Scenario, args: RawArgs): Scenario {
  return {
    ...base,
    rooms: args.numbers.get('rooms') ?? base.rooms,
    listenersPerRoom: args.numbers.get('listeners') ?? base.listenersPerRoom,
    speakersPerRoom: args.numbers.get('speakers') ?? base.speakersPerRoom,
    screenSharesPerRoom: args.numbers.get('screen') ?? base.screenSharesPerRoom,
    relay: args.bools.has('relay') ? true : base.relay,
    rampPerSecond: args.numbers.get('ramp') ?? base.rampPerSecond,
    holdSeconds: args.numbers.get('duration') ?? base.holdSeconds,
    apiConnections: args.numbers.get('api-connections') ?? base.apiConnections,
    apiRequestsPerSecond: args.numbers.get('api-rps') ?? base.apiRequestsPerSecond,
  };
}

/** Well-formedness (not safety): every field present and internally sane. */
export function validateScenario(s: Scenario): string[] {
  const errs: string[] = [];
  // A pure API scenario drives no media rooms; the media planes need at least one.
  if (s.target !== 'api' && s.rooms < 1) errs.push('rooms must be >= 1');
  if (s.rooms < 0) errs.push('rooms must be >= 0');
  if (s.listenersPerRoom < 0) errs.push('listeners must be >= 0');
  if (s.speakersPerRoom < 0) errs.push('speakers must be >= 0');
  if (s.screenSharesPerRoom < 0) errs.push('screen shares must be >= 0');
  if (s.rampPerSecond < 1) errs.push('ramp must be >= 1 per second');
  if (s.holdSeconds < 1) errs.push('duration must be >= 1 second');
  if (s.target === 'livekit' && participantsPerRoom(s) < 1)
    errs.push('a livekit scenario needs at least one participant per room');
  if (s.target === 'api' && s.apiConnections < 1 && s.apiRequestsPerSecond < 1)
    errs.push('an api scenario needs api-connections or api-rps');
  if (!Number.isInteger(s.rooms) || !Number.isInteger(s.listenersPerRoom))
    errs.push('room and participant counts must be whole numbers');
  if (s.churn) {
    if (s.churn.dropFraction <= 0 || s.churn.dropFraction > 1)
      errs.push('churn dropFraction must be in (0, 1]');
    if (s.churn.cycleSeconds < 1) errs.push('churn cycleSeconds must be >= 1');
    if (s.churn.cycles < 1) errs.push('churn cycles must be >= 1');
  }
  return errs;
}
