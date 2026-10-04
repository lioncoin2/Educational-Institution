import { ACCEPTABLE_YELLOW_MIN_HOLD_S, VALIDITY_IDS, type ValidityId } from '../observe/rules';
import { ABORT_SCHEMA, type AbortReason, type FailureClass } from '../observe/sample';
import { classify, type FiredEvidence, type VerdictInputs } from '../results/verdict';

/**
 * results/verdict.ts classify() against the verdict table's "Rung verdict"
 * (docs/p8/p8.4-verdict-table.md) and the failure classes of design §13:
 * UNKNOWN (any V-*) → RED → YELLOW → GREEN, first match wins.
 */

/** Every validity check, in assemble.ts order (V-turn first); the named ones failed. */
function validity(failed: Partial<Record<ValidityId, string>> = {}): VerdictInputs['validity'] {
  const ids = Object.keys(VALIDITY_IDS) as ValidityId[];
  return Object.fromEntries(
    ids.map((id) => {
      const detail = failed[id];
      return [id, detail === undefined ? { ok: true, detail: 'ok' } : { ok: false, detail }];
    }),
  ) as VerdictInputs['validity'];
}

/** RED rules in firing order, 1 s apart. */
const fired = (...ruleIds: string[]): FiredEvidence[] =>
  ruleIds.map((ruleId, k) => ({ ruleId, at: 1_000 * (k + 1) }));

function abort(rule: string, classHint: FailureClass | null, isValidity: boolean): AbortReason {
  return {
    schema: ABORT_SCHEMA,
    runId: 'p84-verdict-test',
    rung: 'S2',
    at: 5_000,
    source: isValidity ? 'controller' : 'sut-watchdog',
    rule,
    observed: { value: 1, unit: '', samples: [] },
    threshold: null,
    classHint,
    validity: isValidity,
    detail: `${rule} detail`,
  };
}

/** A clean rung: validity held, gate met, full hold, cleanup verified, nothing observed. */
const CLEAN: VerdictInputs = {
  validity: validity(),
  fired: [],
  yellow: [],
  overRedNotSustained: [],
  gateMet: true,
  holdCompleted: true,
  gateFailure: null,
  cleanupVerified: true,
  hostRecovered: true,
  safetyAbort: null,
  acceptable: {
    holdSeconds: 300,
    counterIncrementsInSecondHalf: false,
    gaugesWithinNoise: true,
  },
};

const inputs = (over: Partial<VerdictInputs> = {}): VerdictInputs => ({ ...CLEAN, ...over });
const acceptable = (over: Partial<VerdictInputs['acceptable']>): VerdictInputs['acceptable'] => ({
  ...CLEAN.acceptable,
  ...over,
});

/** A rung a RED rule aborted mid-hold (gate met, hold cut short). */
const aborted = (over: Partial<VerdictInputs>): VerdictInputs =>
  inputs({ holdCompleted: false, ...over });

describe('results/verdict — UNKNOWN: any validity failure wins', () => {
  it('is UNKNOWN even when SUT and media rules fired; the non-validity safety abort is only recorded', () => {
    const v = classify(
      aborted({
        validity: validity({ 'V-gen': 'G-cpu-hot' }),
        fired: fired('S-cpu-hot', 'M-stall'),
        safetyAbort: abort('S-cpu-hot', 'C', false),
      }),
    );
    expect(v).toEqual({
      class: 'UNKNOWN',
      pass: false,
      acceptableYellow: null,
      // The abort was not a validity abort, so the first failed check names the class.
      failureClass: 'A',
      contributing: ['C', 'B'],
      reasons: ['V-gen: G-cpu-hot', 'safety abort S-cpu-hot (recorded, not a SUT verdict)'],
    });
  });

  it('a validity safety abort names the primary class: V-turn → F', () => {
    const v = classify(
      inputs({
        validity: validity({ 'V-turn': 'p84-L00001: relay local candidate gathered' }),
        gateMet: false,
        holdCompleted: false,
        gateFailure: 'gate: aborted',
        safetyAbort: abort('V-turn', 'F', true),
      }),
    );
    expect(v).toEqual({
      class: 'UNKNOWN',
      pass: false,
      acceptableYellow: null,
      failureClass: 'F',
      contributing: [],
      reasons: [
        'V-turn: p84-L00001: relay local candidate gathered',
        'safety abort V-turn (recorded, not a SUT verdict)',
        'gate not met: gate: aborted',
      ],
    });
  });

  it('agent-lost → A, although V-turn (class F) is the first failed check', () => {
    const lost = aborted({
      validity: validity({ 'V-turn': 'TURN quota lines (T4)', 'V-gen': 'agent 1 lost' }),
      safetyAbort: abort('agent-lost', 'A', true),
    });
    expect(classify(lost)).toMatchObject({ class: 'UNKNOWN', failureClass: 'A', contributing: [] });
    // Control: without the abort the first failed check (V-turn) would name it.
    expect(classify({ ...lost, safetyAbort: null }).failureClass).toBe('F');
  });

  it('a generator YELLOW (V-gen failing) followed by a media stall is UNKNOWN, never RED', () => {
    const v = classify(
      aborted({
        validity: validity({ 'V-gen': 'G-lag' }),
        fired: fired('M-stall'),
        safetyAbort: abort('M-stall', 'B', false),
      }),
    );
    expect(v).toEqual({
      class: 'UNKNOWN',
      pass: false,
      acceptableYellow: null,
      failureClass: 'A',
      contributing: ['B'],
      reasons: ['V-gen: G-lag', 'safety abort M-stall (recorded, not a SUT verdict)'],
    });
  });

  it('a connect failure during the ramp with V-ramp failing is UNKNOWN (ramp-induced suspected)', () => {
    const gateFailure = 'gate: timed out (connected 9/10; 1 connect failures)';
    const ramp = inputs({
      validity: validity({ 'V-ramp': `ramp-induced suspected: ${gateFailure}` }),
      gateMet: false,
      holdCompleted: false,
      gateFailure,
    });
    expect(classify(ramp)).toEqual({
      class: 'UNKNOWN',
      pass: false,
      acceptableYellow: null,
      failureClass: null, // V-ramp carries no class
      contributing: [],
      reasons: [`V-ramp: ramp-induced suspected: ${gateFailure}`, `gate not met: ${gateFailure}`],
    });
    // Control: the same gate failure with validity held is a RED SFU verdict.
    expect(classify({ ...ramp, validity: validity() })).toMatchObject({
      class: 'RED',
      failureClass: 'B',
    });
  });

  it('outranks every RED cause: fired SUT rule, gate failure and unverified cleanup', () => {
    const v = classify(
      inputs({
        validity: validity({ 'V-dup': 'faults 1, log 1' }),
        fired: fired('S-udp'),
        gateMet: false,
        holdCompleted: false,
        gateFailure: 'gate: aborted',
        cleanupVerified: false,
      }),
    );
    expect(v).toMatchObject({
      class: 'UNKNOWN',
      pass: false,
      failureClass: 'F',
      contributing: ['D'],
    });
  });
});

describe('results/verdict — RED: validity held', () => {
  it.each<[string, FailureClass]>([
    ['S-cpu-hot', 'C'],
    ['S-udp', 'D'],
    ['S-ngx-err', 'E'],
  ])('SUT rule %s fired → RED, class %s', (ruleId, cls) => {
    const v = classify(aborted({ fired: fired(ruleId), safetyAbort: abort(ruleId, cls, false) }));
    expect(v).toEqual({
      class: 'RED',
      pass: false,
      acceptableYellow: null,
      failureClass: cls,
      contributing: [],
      reasons: [`rule ${ruleId} fired`, 'hold not completed'],
    });
  });

  it('a media rule (M-stall) with every generator signal GREEN → RED, class B', () => {
    const v = classify(
      aborted({ fired: fired('M-stall'), safetyAbort: abort('M-stall', 'B', false) }),
    );
    expect(v).toMatchObject({ class: 'RED', pass: false, failureClass: 'B', contributing: [] });
    expect(v.reasons).toContain('rule M-stall fired');
  });

  it('M-unbound judged post-rung (not a banded rule) → RED, class B', () => {
    const v = classify(inputs({ fired: [{ ruleId: 'M-unbound', at: 99_000 }] }));
    expect(v).toEqual({
      class: 'RED',
      pass: false,
      acceptableYellow: null,
      failureClass: 'B',
      contributing: [],
      reasons: ['rule M-unbound fired'],
    });
  });

  it('S-restart is B when LiveKit restarted, E for any other container (the default)', () => {
    const restart = aborted({ fired: fired('S-restart') });
    expect(classify(restart, true)).toMatchObject({ class: 'RED', failureClass: 'B' });
    expect(classify(restart, false)).toMatchObject({ class: 'RED', failureClass: 'E' });
    expect(classify(restart)).toMatchObject({ class: 'RED', failureClass: 'E' });
  });

  it.each(['M-loss-fleet', 'M-loss-listener'])(
    '%s with no drop counted at either end is path loss → class D, not B (design §13)',
    (ruleId) => {
      const v = classify(
        aborted({ fired: fired(ruleId), safetyAbort: abort(ruleId, null, false) }),
      );
      expect(v).toMatchObject({ class: 'RED', failureClass: 'D' });
    },
  );

  it('the earliest cause by time is primary; the other classes contribute', () => {
    const v = classify(
      aborted({
        fired: [
          { ruleId: 'M-stall', at: 20_000 },
          { ruleId: 'S-cpu-hot', at: 5_000 },
          { ruleId: 'S-load', at: 6_000 },
        ],
      }),
    );
    expect(v).toMatchObject({ class: 'RED', failureClass: 'C', contributing: ['B'] });
    expect(v.reasons).toEqual(
      expect.arrayContaining(['rule M-stall fired', 'rule S-cpu-hot fired', 'rule S-load fired']),
    );
  });

  it('a gate failure no fired rule explains → RED, class B', () => {
    const gateFailure = 'gate: timed out (subscribed 8/9; receiving 8/9)';
    const v = classify(inputs({ gateMet: false, holdCompleted: false, gateFailure }));
    expect(v).toEqual({
      class: 'RED',
      pass: false,
      acceptableYellow: null,
      failureClass: 'B',
      contributing: [],
      reasons: [`gate not met: ${gateFailure}`],
    });
  });

  it('a hold that did not complete, with no fired rule → RED, class B', () => {
    const v = classify(inputs({ holdCompleted: false }));
    expect(v).toMatchObject({ class: 'RED', failureClass: 'B', reasons: ['hold not completed'] });
  });

  it('unverified cleanup alone → RED', () => {
    const v = classify(inputs({ cleanupVerified: false }));
    expect(v).toEqual({
      class: 'RED',
      pass: false,
      acceptableYellow: null,
      failureClass: null,
      contributing: [],
      reasons: ['cleanup not verified'],
    });
  });

  it('outranks YELLOW observations and a host-recovery miss', () => {
    const v = classify(
      aborted({
        fired: fired('S-tx'),
        yellow: ['S-cpu-hot'],
        hostRecovered: false,
      }),
    );
    expect(v).toMatchObject({ class: 'RED', failureClass: 'D', acceptableYellow: null });
    expect(v.reasons.some((r) => r.startsWith('YELLOW') || r.includes('P-rec-miss'))).toBe(false);
  });
});

describe('results/verdict — YELLOW and acceptable YELLOW', () => {
  it('only YELLOW observations → YELLOW, pass, each signal named once; acceptable at a 60 s hold', () => {
    const v = classify(
      inputs({
        yellow: ['S-cpu-hot', 'M-reconn', 'S-cpu-hot'],
        acceptable: acceptable({ holdSeconds: ACCEPTABLE_YELLOW_MIN_HOLD_S }),
      }),
    );
    expect(v).toEqual({
      class: 'YELLOW',
      pass: true,
      acceptableYellow: true,
      failureClass: null,
      contributing: [],
      reasons: ['YELLOW S-cpu-hot', 'YELLOW M-reconn'],
    });
  });

  it.each<[string, Partial<VerdictInputs>]>([
    ['an over-RED-not-sustained rule exists', { overRedNotSustained: ['S-cpu-hot'] }],
    [
      'the hold is shorter than 60 s',
      { acceptable: acceptable({ holdSeconds: ACCEPTABLE_YELLOW_MIN_HOLD_S - 1 }) },
    ],
    [
      'counters rose in the second half of the hold',
      { acceptable: acceptable({ counterIncrementsInSecondHalf: true }) },
    ],
    ['gauge noise is unknown (null)', { acceptable: acceptable({ gaugesWithinNoise: null }) }],
    ['gauges exceeded the noise band', { acceptable: acceptable({ gaugesWithinNoise: false }) }],
  ])('YELLOW but not acceptable when %s', (_why, over) => {
    const v = classify(inputs({ yellow: ['S-cpu-hot'], ...over }));
    expect(v).toMatchObject({ class: 'YELLOW', pass: true, acceptableYellow: false });
  });

  it('a host-recovery miss alone (hostRecovered=false) caps the verdict at YELLOW', () => {
    const v = classify(inputs({ hostRecovered: false }));
    expect(v).toMatchObject({
      class: 'YELLOW',
      pass: true,
      failureClass: null,
      contributing: [],
      reasons: ['host recovery missed (P-rec-miss)'],
    });
  });
});

describe('results/verdict — GREEN', () => {
  it('GREEN otherwise: validity held, gate met, full hold, cleanup verified, nothing observed', () => {
    expect(classify(CLEAN)).toEqual({
      class: 'GREEN',
      pass: true,
      acceptableYellow: null,
      failureClass: null,
      contributing: [],
      reasons: [],
    });
  });

  it('the acceptable-YELLOW inputs do not affect a GREEN rung', () => {
    const v = classify(
      inputs({
        acceptable: {
          holdSeconds: 30,
          counterIncrementsInSecondHalf: true,
          gaugesWithinNoise: null,
        },
      }),
    );
    expect(v).toMatchObject({ class: 'GREEN', pass: true, acceptableYellow: null });
  });
});
