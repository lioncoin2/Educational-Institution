/**
 * P8.4 — the watchdog's sustained-window evaluation (design §9): pure, stateful,
 * no I/O, no clock. Feed it one metric map per sample (observe/derive.ts) or per
 * media window; it returns each rule entry's band, the rows that just went RED
 * and the metrics that were missing. Sampling semantics are the verdict
 * table's, encoded in observe/rules.ts: an entry is RED only once its value has
 * been worse than `red` for `sustainOf(rule)` consecutive observations; worse
 * than `red` but not yet sustained is YELLOW (`overRedNotSustained`, never an
 * acceptable YELLOW). A missing value (null, absent or not finite) never gets a
 * band — not even GREEN — and leaves the entry's streak as it was; the caller
 * fails V-sampler on it. A metric the caller marks UNOBSERVED (no new
 * observation since the previous step, e.g. event-loop lag between worker
 * windows) is skipped the same way but is not missing: a stale value is never
 * re-judged, so one spike can never count as a sustained run. Each row ID fires
 * at most once.
 */
import {
  type Band,
  type BandRule,
  type ClassHint,
  type MetricId,
  type MetricValues,
  type Provenance,
  type RuleScope,
  levelOf,
  sustainOf,
} from './rules';
import { type AbortReason } from './sample';

export type { Band } from './rules';

export interface RuleObservation {
  readonly ruleId: string;
  readonly metric: MetricId;
  readonly band: Band;
  readonly value: number;
  /** Worse than `red`, but not (yet) for the rule's sustain count. */
  readonly overRedNotSustained: boolean;
  readonly at: number;
}

/** A rule entry that could not be judged: its metric was null, absent or not finite. */
export interface MissingMetric {
  readonly ruleId: string;
  readonly metric: MetricId;
  readonly at: number;
}

/** A row that went RED: everything an abort record (p84-abort/v1) needs. */
export interface FiredRule {
  readonly ruleId: string;
  readonly metric: MetricId;
  readonly at: number;
  readonly value: number;
  readonly unit: string;
  /** The values of the sustained run that fired it, oldest first. */
  readonly samples: readonly number[];
  readonly threshold: NonNullable<AbortReason['threshold']>;
  readonly classHint: ClassHint | null;
  readonly provenance: readonly Provenance[];
}

export interface WatchdogStep {
  readonly fired: readonly FiredRule[];
  readonly observations: readonly RuleObservation[];
  readonly missing: readonly MissingMetric[];
}

const RANK: Readonly<Record<Band, number>> = { green: 0, yellow: 1, red: 2 };

interface EntryState {
  readonly rule: BandRule;
  readonly need: number;
  /** The current run of values worse than `red`, newest last, at most `need` long. */
  run: number[];
}

function thresholdOf(rule: BandRule, red: number, need: number): FiredRule['threshold'] {
  const sustain =
    rule.kind === 'rate'
      ? `${need} consecutive windows`
      : need === 1
        ? 'instant'
        : `${need} consecutive samples`;
  return { op: rule.worse === 'above' ? '>' : '<', value: red, sustain };
}

const NOTHING_UNOBSERVED: ReadonlySet<MetricId> = new Set();

/** G-lag has a value only for worker windows that arrived since the previous sample. */
export const LAG_UNOBSERVED: ReadonlySet<MetricId> = new Set<MetricId>(['gLoopLagP95Ms']);

/**
 * The worst value reported since the last `take()` — each report is consumed
 * exactly once, so a sampler judging at its own cadence never re-judges a stale
 * window (one 392 ms lag spike once became "4 consecutive samples" → a
 * fabricated sustained RED). `take()` is null when nothing arrived.
 */
export class FreshWorst {
  private worst: number | null = null;

  add(value: number): void {
    this.worst = this.worst === null ? value : Math.max(this.worst, value);
  }

  take(): number | null {
    const value = this.worst;
    this.worst = null;
    return value;
  }
}

export class Watchdog {
  private readonly entries: EntryState[];
  private readonly fired = new Set<string>();
  private readonly worst = new Map<string, Band>();

  /** Watches every banded entry of `scope`; record rules are never banded. */
  constructor(rules: readonly BandRule[], scope: RuleScope) {
    this.entries = rules
      .filter((rule) => rule.scope === scope && rule.kind !== 'record')
      .map((rule) => ({ rule, need: sustainOf(rule), run: [] }));
  }

  observe(
    t: number,
    metrics: MetricValues,
    unobserved: ReadonlySet<MetricId> = NOTHING_UNOBSERVED,
  ): WatchdogStep {
    const fired: FiredRule[] = [];
    const observations: RuleObservation[] = [];
    const missing: MissingMetric[] = [];
    for (const entry of this.entries) {
      const { rule, need } = entry;
      if (unobserved.has(rule.metric)) continue; // no new observation: no band, streak kept
      const value = metrics[rule.metric];
      if (value === undefined || value === null || !Number.isFinite(value)) {
        missing.push({ ruleId: rule.id, metric: rule.metric, at: t });
        continue;
      }
      const level = levelOf(rule, value);
      entry.run = level === 'red' ? [...entry.run, value].slice(-need) : [];
      const overRed = level === 'red' && entry.run.length < need;
      const band: Band = overRed ? 'yellow' : level;
      observations.push({
        ruleId: rule.id,
        metric: rule.metric,
        band,
        value,
        overRedNotSustained: overRed,
        at: t,
      });
      const prior = this.worst.get(rule.id);
      if (prior === undefined || RANK[band] > RANK[prior]) this.worst.set(rule.id, band);
      if (band === 'red' && rule.red !== null && !this.fired.has(rule.id)) {
        this.fired.add(rule.id);
        fired.push({
          ruleId: rule.id,
          metric: rule.metric,
          at: t,
          value,
          unit: rule.unit,
          samples: [...entry.run],
          threshold: thresholdOf(rule, rule.red, need),
          classHint: rule.classHint,
          provenance: rule.provenance,
        });
      }
    }
    return { fired, observations, missing };
  }

  /** The worst band each row reached; a row never observed (only missing) is absent, not GREEN. */
  worstBands(): Record<string, Band> {
    return Object.fromEntries(this.worst);
  }
}
