/**
 * P8.4 — the operator's run request, parsed STRICTLY (unknown or misspelled
 * flags are refused — the P8.3 runner silently ignored them) and gated by the
 * per-rung caps (core/safety.ts: the shared `checkScenarioSafety` with
 * `fleetLimitsFor(rung)`, plus hosts/density/calibration). Pure: no I/O.
 *
 *   fleet-run --rung <S1|S2|R1..R6> --generators <host,...> --target <wss://…>
 *             [--ice turn-free|relay] [--ramp <n/s>] [--density <n>]
 *             [--density-evidence <result.json>] [--calibration]
 *             [--ssh-key <path>] [--known-hosts <path>] [--ssh-user p84]
 *             [--env-file <path>] [--sut-address <ip>] [--out <dir>] [--allow-load]
 *             [--previous <result.json>] [--accept-yellow]
 *   fleet-run cleanup --run <runId> --target <wss://…> [--generators …] [--env-file …]
 */
import { validateScenario } from '../core/config';
import {
  VALIDATED_DENSITY,
  checkFleetRequest,
  checkScenarioSafety,
  fleetLimitsFor,
} from '../core/safety';
import { type P84Rung, getRung, rungScenario } from '../scenarios/p84-ladder';

const VALUE_FLAGS = [
  'rung',
  'generators',
  'target',
  'ice',
  'ramp',
  'density',
  'density-evidence',
  'ssh-key',
  'known-hosts',
  'ssh-user',
  'env-file',
  'sut-address',
  'out',
  'run',
  'previous',
] as const;
const BOOL_FLAGS = ['calibration', 'allow-load', 'accept-yellow', 'help'] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];
type BoolFlag = (typeof BOOL_FLAGS)[number];

export interface FleetArgs {
  readonly command: 'run' | 'cleanup';
  readonly values: ReadonlyMap<ValueFlag, string>;
  readonly flags: ReadonlySet<BoolFlag>;
  readonly errors: readonly string[];
}

export function parseFleetArgs(argv: readonly string[]): FleetArgs {
  const values = new Map<ValueFlag, string>();
  const flags = new Set<BoolFlag>();
  const errors: string[] = [];
  let command: FleetArgs['command'] = 'run';
  let i = 0;
  if (argv[0] === 'cleanup') {
    command = 'cleanup';
    i = 1;
  }
  for (; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    const name = token.startsWith('--') ? token.slice(2) : null;
    if (name !== null && (BOOL_FLAGS as readonly string[]).includes(name)) {
      flags.add(name as BoolFlag);
    } else if (name !== null && (VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) errors.push(`--${name} needs a value`);
      else values.set(name as ValueFlag, value);
      i += 1;
    } else {
      errors.push(`unknown argument ${token}`);
    }
  }
  return { command, values, flags, errors };
}

export interface FleetPlan {
  readonly rung: P84Rung | null;
  readonly generators: readonly string[];
  readonly target: string | null;
  readonly ice: 'turn-free' | 'relay';
  readonly ramp: number;
  readonly density: number;
  readonly calibration: boolean;
  readonly allowLoad: boolean;
  readonly errors: readonly string[];
}

const NUMBER = /^\d+(\.\d+)?$/;
/** A hostname or IP (no leading '-', so ssh can never read it as an option). */
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;
const USER = /^[a-z_][a-z0-9_-]*$/;

/** The validated plan; `provenDensity` comes from an attached calibration result (default VALIDATED_DENSITY). */
export function planFleetRun(a: FleetArgs, provenDensity = VALIDATED_DENSITY): FleetPlan {
  const errors = [...a.errors];
  const rung = getRung(a.values.get('rung') ?? '') ?? null;
  if (!rung) errors.push('--rung must be one of S1, S2, R1, R2, R3, R4, R5, R6');
  const generators = (a.values.get('generators') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (new Set(generators).size !== generators.length)
    errors.push('a generator host is listed twice');
  for (const h of generators)
    if (!HOST.test(h))
      errors.push(`invalid generator host ${h} (letters, digits, '.', ':', '-'; no leading '-')`);
  const sshUser = a.values.get('ssh-user');
  if (sshUser !== undefined && !USER.test(sshUser)) errors.push(`invalid --ssh-user ${sshUser}`);
  const ice = a.values.get('ice') ?? 'turn-free';
  if (ice !== 'turn-free' && ice !== 'relay') errors.push('--ice must be turn-free or relay');
  if (ice === 'relay' && rung && rung.id !== 'S1')
    errors.push('--ice relay (positive control) is allowed on S1 only');
  const rampText = a.values.get('ramp');
  const densityText = a.values.get('density');
  if (rampText !== undefined && !NUMBER.test(rampText)) errors.push('--ramp must be a number');
  if (densityText !== undefined && !/^\d+$/.test(densityText))
    errors.push('--density must be a whole number');
  const ramp = rampText !== undefined ? Number(rampText) : (rung?.rampPerSecond ?? 0);
  const density = densityText !== undefined ? Number(densityText) : VALIDATED_DENSITY;
  const calibration = a.flags.has('calibration');
  const target = a.values.get('target') ?? null;
  if (target !== null && !/^wss?:\/\//.test(target)) errors.push('--target must be a ws(s):// URL');
  if (rung) {
    errors.push(...validateScenario(rungScenario(rung, ramp)));
    errors.push(...checkScenarioSafety(rungScenario(rung, ramp), fleetLimitsFor(rung)));
    errors.push(
      ...checkFleetRequest({
        rungId: rung.id,
        hosts: Math.max(generators.length, 0),
        provisionedHosts: generators.length,
        density,
        provenDensity,
        calibration,
      }),
    );
  }
  return {
    rung,
    generators,
    target,
    ice: ice === 'relay' ? 'relay' : 'turn-free',
    ramp,
    density,
    calibration,
    allowLoad: a.flags.has('allow-load'),
    errors,
  };
}
