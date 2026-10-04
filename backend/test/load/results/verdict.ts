/**
 * P8.4 — rung classification (verdict table "Rung verdict", design §13). Pure:
 * it maps the rules that fired (by id — every number lives in observe/rules.ts),
 * the validity checks, the gate outcome and the cleanup into GREEN / YELLOW /
 * RED / UNKNOWN with a primary failure class. Safety is separate: a RED rule
 * always aborted the run; classification decides what that abort MEANS.
 *
 * First match wins: UNKNOWN (any validity failure — generator, TURN, sampler,
 * clock, duplicate identity, ticket leak, ramp-induced) → RED (a SUT rule, or a
 * media rule while every generator signal was GREEN, a gate failure on SUT or
 * media evidence, or unverified cleanup) → YELLOW → GREEN.
 */
import {
  ACCEPTABLE_YELLOW_MIN_HOLD_S,
  type RuleScope,
  RULES,
  type ValidityId,
} from '../observe/rules';
import { type AbortReason, type FailureClass } from '../observe/sample';
import { type RungResult } from './schema';

export interface FiredEvidence {
  readonly ruleId: string;
  readonly at: number;
}

export interface VerdictInputs {
  readonly validity: Readonly<
    Record<ValidityId, { readonly ok: boolean; readonly detail: string }>
  >;
  /** RED rules (all scopes), in firing order. */
  readonly fired: readonly FiredEvidence[];
  /** Rule ids observed YELLOW at any point (including over-RED-but-not-sustained). */
  readonly yellow: readonly string[];
  /** Rule ids that were above their RED level but not sustained (never acceptable). */
  readonly overRedNotSustained: readonly string[];
  readonly gateMet: boolean;
  readonly holdCompleted: boolean;
  /** Why the gate failed, when it did and no rule explains it (e.g. a listener never subscribed). */
  readonly gateFailure: string | null;
  readonly cleanupVerified: boolean;
  readonly hostRecovered: boolean | null;
  readonly safetyAbort: AbortReason | null;
  /** Inputs for "acceptable YELLOW" eligibility (verdict table, Capacity statement). */
  readonly acceptable: {
    readonly holdSeconds: number;
    readonly counterIncrementsInSecondHalf: boolean;
    readonly gaugesWithinNoise: boolean | null;
  };
}

const VALIDITY_CLASS: Readonly<Record<ValidityId, FailureClass | null>> = {
  'V-gen': 'A',
  'V-clock': 'A',
  'V-turn': 'F',
  'V-sampler': 'F',
  'V-dup': 'F',
  'V-ticket': 'F',
  'V-ramp': null,
};

const RULE = new Map(RULES.map((r) => [r.id, r]));

/** Banded rules carry their scope; rows judged elsewhere (e.g. post-rung M-unbound) by ID prefix. */
function scopeOf(ruleId: string): RuleScope | null {
  const scope = RULE.get(ruleId)?.scope;
  if (scope) return scope;
  if (ruleId.startsWith('S-')) return 'sut';
  if (ruleId.startsWith('M-')) return 'media';
  if (ruleId.startsWith('G-')) return 'generator';
  return null;
}

/** A rule's failure class: its hint, or B/E for a container restart by which container restarted. */
/**
 * A rule's failure class: its hint (S-restart: B for LiveKit, else E). Only when
 * validity held (`validityHeld`) may a media rule without a hint fall back to B:
 * the host and every generator were GREEN, so the SFU is what remains (§13).
 */
function classOf(
  ruleId: string,
  restartedLivekit: boolean,
  validityHeld: boolean,
): FailureClass | null {
  if (ruleId === 'S-restart') return restartedLivekit ? 'B' : 'E';
  const hint = RULE.get(ruleId)?.classHint ?? null;
  if (hint) return hint;
  return validityHeld && scopeOf(ruleId) === 'media' ? 'B' : null;
}

export function classify(i: VerdictInputs, restartedLivekit = false): RungResult['verdict'] {
  const reasons: string[] = [];
  const failedValidity = (Object.keys(i.validity) as ValidityId[]).filter((v) => !i.validity[v].ok);
  const validityHeld = failedValidity.length === 0;
  const firedClasses = i.fired
    .map((f) => classOf(f.ruleId, restartedLivekit, validityHeld))
    .filter((c): c is FailureClass => c !== null);
  const unique = (xs: readonly FailureClass[]): FailureClass[] => [...new Set(xs)];

  if (failedValidity.length > 0) {
    for (const v of failedValidity) reasons.push(`${v}: ${i.validity[v].detail}`);
    if (i.safetyAbort)
      reasons.push(`safety abort ${i.safetyAbort.rule} (recorded, not a SUT verdict)`);
    if (i.gateFailure) reasons.push(`gate not met: ${i.gateFailure}`);
    if (!i.cleanupVerified) reasons.push('cleanup not verified');
    // The abort that actually happened names the class; otherwise the first failed check's.
    const primary =
      (i.safetyAbort?.validity ? i.safetyAbort.classHint : null) ??
      failedValidity.map((v) => VALIDITY_CLASS[v]).find((c) => c !== null) ??
      null;
    return {
      class: 'UNKNOWN',
      pass: false,
      acceptableYellow: null,
      failureClass: primary,
      contributing: unique(firedClasses).filter((c) => c !== primary),
      reasons,
    };
  }

  const red = i.fired.filter((f) => scopeOf(f.ruleId) !== 'generator');
  if (red.length > 0 || !i.gateMet || !i.holdCompleted || !i.cleanupVerified) {
    for (const f of red) reasons.push(`rule ${f.ruleId} fired`);
    if (!i.gateMet) reasons.push(`gate not met${i.gateFailure ? `: ${i.gateFailure}` : ''}`);
    if (i.gateMet && !i.holdCompleted) reasons.push('hold not completed');
    if (!i.cleanupVerified) reasons.push('cleanup not verified');
    const ordered = [...red].sort((a, b) => a.at - b.at);
    // A gate/hold failure no rule explains, with every host and generator signal
    // GREEN (validity held), is the SFU's (design §13, class B).
    const primary =
      ordered.map((f) => classOf(f.ruleId, restartedLivekit, true)).find((c) => c !== null) ??
      (i.gateFailure || !i.holdCompleted ? 'B' : null);
    return {
      class: 'RED',
      pass: false,
      acceptableYellow: null,
      failureClass: primary,
      contributing: unique(firedClasses).filter((c) => c !== primary),
      reasons,
    };
  }

  const yellow = [...new Set(i.yellow)];
  if (yellow.length > 0 || i.hostRecovered === false) {
    for (const y of yellow) reasons.push(`YELLOW ${y}`);
    if (i.hostRecovered === false) reasons.push('host recovery missed (P-rec-miss)');
    const eligible =
      i.overRedNotSustained.length === 0 &&
      i.acceptable.holdSeconds >= ACCEPTABLE_YELLOW_MIN_HOLD_S &&
      !i.acceptable.counterIncrementsInSecondHalf &&
      i.acceptable.gaugesWithinNoise === true;
    return {
      class: 'YELLOW',
      pass: true,
      acceptableYellow: eligible,
      failureClass: null,
      contributing: [],
      reasons,
    };
  }

  return {
    class: 'GREEN',
    pass: true,
    acceptableYellow: null,
    failureClass: null,
    contributing: [],
    reasons,
  };
}
