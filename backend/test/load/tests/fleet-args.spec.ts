import {
  SAFETY_LIMITS,
  VALIDATED_DENSITY,
  checkScenarioSafety,
  fleetLimitsFor,
} from '../core/safety';
import { type FleetPlan, parseFleetArgs, planFleetRun } from '../fleet/fleet-args';
import { GlobalRamp } from '../fleet/ramp';
import { P84_RUNGS, type P84Rung, getRung, rungScenario } from '../scenarios/p84-ladder';

const RUN = '0123abcd4567ef89';
const RUNG_IDS = P84_RUNGS.map((r) => r.id);
const NOT_S1 = RUNG_IDS.filter((id) => id !== 'S1');

const plan = (argv: readonly string[], provenDensity?: number): FleetPlan =>
  planFleetRun(parseFleetArgs(argv), provenDensity);
/** `--rung <id> --generators gen-1` plus extra argv. */
const rungArgs = (id: string, ...more: string[]): string[] => [
  '--rung',
  id,
  '--generators',
  'gen-1.example.net',
  ...more,
];
const rung = (id: string): P84Rung => getRung(id) as P84Rung;

describe('fleet/fleet-args — parseFleetArgs is strict', () => {
  it('parses every documented value and boolean flag of a run', () => {
    const a = parseFleetArgs([
      '--rung',
      'R1',
      '--generators',
      'gen-1.example.net,gen-2.example.net',
      '--target',
      'wss://livekit.example.net',
      '--ice',
      'turn-free',
      '--ramp',
      '5',
      '--density',
      '20',
      '--density-evidence',
      '/results/r1.json',
      '--calibration',
      '--ssh-key',
      '/keys/p84_ed25519',
      '--known-hosts',
      '/keys/p84_known_hosts',
      '--ssh-user',
      'p84',
      '--env-file',
      '/env/fake.env',
      '--sut-address',
      '203.0.113.5',
      '--out',
      '/results',
      '--allow-load',
    ]);
    expect(a.command).toBe('run');
    expect(a.errors).toEqual([]);
    expect(Object.fromEntries(a.values)).toEqual({
      rung: 'R1',
      generators: 'gen-1.example.net,gen-2.example.net',
      target: 'wss://livekit.example.net',
      ice: 'turn-free',
      ramp: '5',
      density: '20',
      'density-evidence': '/results/r1.json',
      'ssh-key': '/keys/p84_ed25519',
      'known-hosts': '/keys/p84_known_hosts',
      'ssh-user': 'p84',
      'env-file': '/env/fake.env',
      'sut-address': '203.0.113.5',
      out: '/results',
    });
    expect([...a.flags].sort()).toEqual(['allow-load', 'calibration']);
  });

  it.each([
    '--rungs',
    '--Rung',
    '--RUNG',
    '--generator',
    '--allow_load',
    '--allowload',
    '--allow-loads',
    '--force',
    '--dry-run',
    '--relay',
    '--listeners',
    '--duration',
    '-rung',
    '--rung=S1',
    '--',
    'R1',
  ])('refuses the unknown or misspelled argument %j', (token) => {
    const a = parseFleetArgs([...rungArgs('S1'), token]);
    expect(a.errors).toEqual([`unknown argument ${token}`]);
    expect(planFleetRun(a).errors).toContain(`unknown argument ${token}`);
  });

  it('a misspelled value flag is refused and its value is not taken by anything else', () => {
    const a = parseFleetArgs(['--rung', 'S1', '--genrators', 'gen-1.example.net']);
    expect(a.errors).toEqual([
      'unknown argument --genrators',
      'unknown argument gen-1.example.net',
    ]);
    expect(a.values.has('generators')).toBe(false);
  });

  it.each([
    [['--rung'], '--rung needs a value'],
    [['--rung', 'S1', '--generators'], '--generators needs a value'],
    [['--target', '--allow-load'], '--target needs a value'],
    [['--ramp', '--density', '10'], '--ramp needs a value'],
  ])('a value flag without a value is an error: %j', (argv, error) => {
    expect(parseFleetArgs(argv).errors).toContain(error);
  });

  it('a boolean flag takes no value: the next token is refused', () => {
    expect(parseFleetArgs([...rungArgs('S1'), '--allow-load', 'yes']).errors).toEqual([
      'unknown argument yes',
    ]);
  });

  it('a bare argv is a run with nothing set and no parse errors', () => {
    const a = parseFleetArgs([]);
    expect(a).toEqual({ command: 'run', values: new Map(), flags: new Set(), errors: [] });
  });
});

describe('fleet/fleet-args — the cleanup command', () => {
  it('parses `cleanup --run … --target … --generators … --env-file …`', () => {
    const a = parseFleetArgs([
      'cleanup',
      '--run',
      RUN,
      '--target',
      'wss://livekit.example.net',
      '--generators',
      'gen-1.example.net,gen-2.example.net',
      '--env-file',
      '/env/fake.env',
    ]);
    expect(a.command).toBe('cleanup');
    expect(a.errors).toEqual([]);
    expect(Object.fromEntries(a.values)).toEqual({
      run: RUN,
      target: 'wss://livekit.example.net',
      generators: 'gen-1.example.net,gen-2.example.net',
      'env-file': '/env/fake.env',
    });
    expect(a.flags.size).toBe(0);
  });

  it('is recognised only as the first token', () => {
    const a = parseFleetArgs(['--run', RUN, 'cleanup']);
    expect(a.command).toBe('run');
    expect(a.errors).toEqual(['unknown argument cleanup']);
  });

  it('refuses misspelled cleanup flags and a missing --run value', () => {
    expect(
      parseFleetArgs(['cleanup', '--runid', RUN, '--target', 'wss://x.example']).errors,
    ).toEqual(['unknown argument --runid', `unknown argument ${RUN}`]);
    expect(parseFleetArgs(['cleanup', '--generator', 'gen-1']).errors).toEqual([
      'unknown argument --generator',
      'unknown argument gen-1',
    ]);
    expect(parseFleetArgs(['cleanup', '--run']).errors).toEqual(['--run needs a value']);
  });

  it('is case-sensitive: `Cleanup` is not the cleanup command', () => {
    const a = parseFleetArgs(['Cleanup', '--run', RUN]);
    expect(a.command).toBe('run');
    expect(a.errors).toEqual(['unknown argument Cleanup']);
  });
});

describe('fleet/fleet-args — planFleetRun: rung', () => {
  it('--rung is required', () => {
    const p = plan(['--generators', 'gen-1.example.net']);
    expect(p.rung).toBeNull();
    expect(p.errors).toEqual(['--rung must be one of S1, S2, R1, R2, R3, R4, R5, R6']);
  });

  it.each(['R7', 'R0', 'S3', 's1', 'r6', 'P84_R1', 'R1 ', ''])('refuses the rung %j', (id) => {
    const p = plan(rungArgs(id));
    expect(p.rung).toBeNull();
    expect(p.errors).toContain('--rung must be one of S1, S2, R1, R2, R3, R4, R5, R6');
  });

  it.each(RUNG_IDS)('%s with one generator passes its per-rung caps with the defaults', (id) => {
    const p = plan(rungArgs(id));
    expect(p.errors).toEqual([]);
    expect(p).toEqual({
      rung: rung(id),
      generators: ['gen-1.example.net'],
      target: null,
      ice: 'turn-free',
      ramp: rung(id).rampPerSecond,
      density: VALIDATED_DENSITY,
      calibration: false,
      allowLoad: false,
      errors: [],
    });
  });

  it.each(RUNG_IDS)('%s with --target and --allow-load is a clean real-load plan', (id) => {
    const p = plan(rungArgs(id, '--target', 'wss://livekit.example.net', '--allow-load'));
    expect(p.errors).toEqual([]);
    expect(p.allowLoad).toBe(true);
    expect(p.target).toBe('wss://livekit.example.net');
  });

  it.each(['R5', 'R6'])(
    '%s passes under fleetLimitsFor, yet the global SAFETY_LIMITS (3,500/room) still refuse the same scenario',
    (id) => {
      const r = rung(id);
      expect(plan(rungArgs(id)).errors).toEqual([]);
      expect(checkScenarioSafety(rungScenario(r), fleetLimitsFor(r))).toEqual([]);
      expect(SAFETY_LIMITS.maxParticipantsPerRoom).toBe(3_500);
      expect(checkScenarioSafety(rungScenario(r))).toEqual([
        `participants/room ${r.participants} exceeds cap 3500`,
      ]);
    },
  );

  it('planning every rung leaves the global SAFETY_LIMITS untouched (no blanket raise)', () => {
    const before = { ...SAFETY_LIMITS };
    for (const id of RUNG_IDS) plan(rungArgs(id, '--allow-load'));
    expect(SAFETY_LIMITS).toEqual(before);
  });

  it('refuses a rung with no generator host', () => {
    expect(plan(['--rung', 'R1']).errors).toEqual(['at least one generator host is required']);
    expect(plan(['--rung', 'R1', '--generators', ' , ,']).errors).toEqual([
      'at least one generator host is required',
    ]);
  });

  it('splits --generators on commas, trimming blanks and dropping empty entries', () => {
    const p = plan(['--rung', 'R1', '--generators', ' gen-1 , gen-2,,gen-3 ,']);
    expect(p.generators).toEqual(['gen-1', 'gen-2', 'gen-3']);
    expect(p.errors).toEqual([]);
  });

  it('refuses the same generator host listed twice (hosts ≤ provisioned hosts)', () => {
    // Two agents on one VM would share its STUN port and its runs/<runId>
    // record, and the shard plan would count the VM as two hosts.
    const p = plan(['--rung', 'R1', '--generators', 'gen-1.example.net,gen-1.example.net']);
    expect(p.errors).not.toEqual([]);
  });
});

describe('fleet/fleet-args — planFleetRun: ICE mode', () => {
  it('defaults to turn-free', () => {
    expect(plan(rungArgs('R1')).ice).toBe('turn-free');
  });

  it('allows --ice relay (the positive control) on S1', () => {
    const p = plan(rungArgs('S1', '--ice', 'relay'));
    expect(p.errors).toEqual([]);
    expect(p.ice).toBe('relay');
  });

  it.each(NOT_S1)('refuses --ice relay on %s', (id) => {
    expect(plan(rungArgs(id, '--ice', 'relay')).errors).toEqual([
      '--ice relay (positive control) is allowed on S1 only',
    ]);
  });

  it.each(['turn', 'TURN-FREE', 'turnfree', 'direct', 'tcp', ''])('refuses --ice %j', (ice) => {
    const p = plan(rungArgs('S1', '--ice', ice));
    expect(p.errors).toEqual(['--ice must be turn-free or relay']);
    expect(p.ice).toBe('turn-free');
  });
});

describe('fleet/fleet-args — planFleetRun: ramp', () => {
  it.each(RUNG_IDS)('%s: the default ramp is the rung target', (id) => {
    expect(plan(rungArgs(id)).ramp).toBe(rung(id).rampPerSecond);
  });

  it.each(RUNG_IDS)('%s: a ramp above the rung target is refused', (id) => {
    const target = rung(id).rampPerSecond;
    const p = plan(rungArgs(id, '--ramp', String(target + 1)));
    expect(p.errors).toEqual([`ramp ${target + 1}/s exceeds cap ${target}/s`]);
  });

  it('a fractional ramp just above the target is refused', () => {
    expect(plan(rungArgs('R1', '--ramp', '10.5')).errors).toEqual(['ramp 10.5/s exceeds cap 10/s']);
    expect(plan(rungArgs('S1', '--ramp', '2.01')).errors).toEqual(['ramp 2.01/s exceeds cap 2/s']);
  });

  it('a ramp below 1/s is refused by the shared scenario validation', () => {
    expect(plan(rungArgs('S1', '--ramp', '0.5')).errors).toEqual(['ramp must be >= 1 per second']);
    expect(plan(rungArgs('R1', '--ramp', '0')).errors).toEqual(['ramp must be >= 1 per second']);
  });

  it('a ramp at or below the target is allowed', () => {
    for (const [id, ramp] of [
      ['R1', '10'],
      ['R1', '5'],
      ['R6', '2.5'],
      ['S1', '1'],
    ] as const) {
      const p = plan(rungArgs(id, '--ramp', ramp));
      expect(p.errors).toEqual([]);
      expect(p.ramp).toBe(Number(ramp));
    }
  });

  it.each(['fast', '-1', '1e3', '10/s', '+5', '.5', '5.', '0x10', ' 5'])(
    'refuses the non-numeric ramp %j',
    (ramp) => {
      expect(plan(rungArgs('R1', '--ramp', ramp)).errors).toContain('--ramp must be a number');
    },
  );

  it('refuses a zero ramp (it can never admit anyone; GlobalRamp rejects it)', () => {
    for (const ramp of ['0', '0.0']) {
      const p = plan(rungArgs('R1', '--ramp', ramp));
      expect(() => new GlobalRamp({ ratePerSecond: p.ramp, inFlightLimit: 4 })).toThrow(RangeError);
      expect(p.errors).not.toEqual([]);
    }
  });
});

describe('fleet/fleet-args — planFleetRun: density and calibration', () => {
  it('defaults to the validated density', () => {
    expect(VALIDATED_DENSITY).toBe(10);
    expect(plan(rungArgs('R3')).density).toBe(10);
  });

  it('refuses a density above the proven density without --calibration', () => {
    expect(plan(rungArgs('R1', '--density', '11')).errors).toEqual([
      'density 11 exceeds the proven density 10 (run a calibration)',
    ]);
    expect(plan(rungArgs('R4', '--density', '30')).errors).toEqual([
      'density 30 exceeds the proven density 10 (run a calibration)',
    ]);
  });

  it('allows a density at or below the proven density', () => {
    for (const d of ['10', '5', '1'])
      expect(plan(rungArgs('R3', '--density', d)).errors).toEqual([]);
  });

  it('an attached calibration result raises the proven density, and only to its value', () => {
    expect(plan(rungArgs('R3', '--density', '20'), 20).errors).toEqual([]);
    expect(plan(rungArgs('R3', '--density', '21'), 20).errors).toEqual([
      'density 21 exceeds the proven density 20 (run a calibration)',
    ]);
  });

  it.each(['2.5', 'ten', '-3', '1e1', '10 '])('refuses the density %j', (d) => {
    expect(plan(rungArgs('R1', '--density', d)).errors).toContain(
      '--density must be a whole number',
    );
  });

  it('refuses density 0', () => {
    expect(plan(rungArgs('R1', '--density', '0')).errors).toEqual([
      'density must be a whole number >= 1',
    ]);
  });

  it.each(['S2', 'R1', 'R2'].flatMap((id) => ['10', '20', '30'].map((d) => [id, d] as const)))(
    'allows a calibration run on %s at density %s',
    (id, d) => {
      const p = plan(rungArgs(id, '--calibration', '--density', d));
      expect(p.errors).toEqual([]);
      expect(p.calibration).toBe(true);
      expect(p.density).toBe(Number(d));
    },
  );

  it.each(['S1', 'R3', 'R4', 'R5', 'R6'])('refuses a calibration run on %s', (id) => {
    expect(plan(rungArgs(id, '--calibration', '--density', '20')).errors).toEqual([
      `calibration runs only on S2/R1/R2, not ${id}`,
    ]);
  });

  it.each(['1', '5', '15', '25', '40'])('refuses calibration density %s', (d) => {
    expect(plan(rungArgs('R1', '--calibration', '--density', d)).errors).toEqual([
      'calibration density must be one of 10/20/30',
    ]);
  });

  it('calibration lifts only the proven-density bar, never the rung caps', () => {
    expect(plan(rungArgs('R2', '--calibration', '--density', '30', '--ramp', '11')).errors).toEqual(
      ['ramp 11/s exceeds cap 10/s'],
    );
  });
});

describe('fleet/fleet-args — planFleetRun: target', () => {
  it('a missing target is null (dry-run) and not an error', () => {
    const p = plan(rungArgs('R1'));
    expect(p.target).toBeNull();
    expect(p.errors).toEqual([]);
  });

  it.each(['wss://livekit.example.net', 'ws://127.0.0.1:7880'])('accepts %s', (t) => {
    expect(plan(rungArgs('R1', '--target', t)).errors).toEqual([]);
  });

  it.each(['https://livekit.example.net', 'livekit.example.net', 'wss:/x.example', 'ftp://x'])(
    'refuses the target %s',
    (t) => {
      expect(plan(rungArgs('R1', '--target', t)).errors).toEqual([
        '--target must be a ws(s):// URL',
      ]);
    },
  );
});
