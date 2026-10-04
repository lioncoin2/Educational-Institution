/**
 * P8.4 — the GLOBAL admission pacer (design §6), owned by the controller. A
 * token bucket refilled at `ratePerSecond`; each token is one ticket (minting
 * = admission) and goes to the shard with the most remaining work that is
 * below its in-flight limit (ticket issued, no terminal event yet), ties to
 * the lowest workerId. Replaces mp/partition.ts's per-supervisor stagger.
 *
 * The bucket is evaluated only when the controller calls `grant`: the credit
 * accrued since the previous call is spendable in full, so a coarse or jittery
 * controller tick never lowers the rate, while the credit CARRIED from one
 * call to the next is capped at `burst`, so time spent idle or blocked by
 * in-flight limits never piles up into a herd. One call therefore admits at
 * most `burst + ratePerSecond × elapsed`: call it on every controller tick,
 * including ticks with nothing admissible. The bucket's clock starts at the
 * FIRST call (full, i.e. `burst`): time before the ramp — the publisher phase —
 * never accrues credit (P8.4 pre-commit real run: a 15 s phase A became a burst
 * of every listener at once). Pure: no timers, no clock reads.
 */

/** Credit is kept in milli-tokens: rate (per s) × elapsed (ms), exact for integer inputs. */
const MILLI_PER_TOKEN = 1000;

/** One listener shard's demand as the controller currently accounts it. */
export interface ShardDemand {
  readonly workerId: number;
  /** Listeners of the shard with no ticket issued yet. */
  readonly remaining: number;
  /** Tickets issued to the shard with no terminal event (connected/failed) yet. */
  readonly inFlight: number;
}

export interface GlobalRampOptions {
  readonly ratePerSecond: number;
  /** Most credit carried between calls, in admissions; default 1. */
  readonly burst?: number;
  /** Most tickets in flight per shard (design default 4). */
  readonly inFlightLimit: number;
}

export class GlobalRamp {
  private readonly ratePerSecond: number;
  private readonly capacity: number;
  private readonly inFlightLimit: number;
  private credit: number;
  /** Clock of the previous call; null until the first call starts the bucket. */
  private lastMs: number | null = null;

  constructor(opts: GlobalRampOptions) {
    const burst = opts.burst ?? 1;
    if (!Number.isFinite(opts.ratePerSecond) || opts.ratePerSecond <= 0)
      throw new RangeError(`ratePerSecond must be a finite number > 0 (got ${opts.ratePerSecond})`);
    requireInteger('burst', burst, 1);
    requireInteger('inFlightLimit', opts.inFlightLimit, 1);
    this.ratePerSecond = opts.ratePerSecond;
    this.capacity = burst * MILLI_PER_TOKEN;
    this.inFlightLimit = opts.inFlightLimit;
    this.credit = this.capacity;
  }

  /**
   * The admissions due at `nowMs`: one workerId per ticket to mint now (a shard
   * may appear several times). Never exceeds a shard's `remaining` or lifts its
   * in-flight count past the limit. Throws RangeError if the clock goes
   * backwards or the demand is malformed.
   */
  grant(nowMs: number, shards: readonly ShardDemand[]): number[] {
    const last = this.lastMs ?? nowMs;
    if (!Number.isFinite(nowMs) || nowMs < last)
      throw new RangeError(`nowMs must be finite and not before ${last} (got ${nowMs})`);
    validateDemand(shards);
    this.credit += this.ratePerSecond * (nowMs - last);
    this.lastMs = nowMs;

    const granted = shards.map(() => 0);
    const admitted: number[] = [];
    while (this.credit >= MILLI_PER_TOKEN) {
      const i = pickShard(shards, granted, this.inFlightLimit);
      if (i < 0) break;
      granted[i] += 1;
      admitted.push(shards[i].workerId);
      this.credit -= MILLI_PER_TOKEN;
    }
    this.credit = Math.min(this.credit, this.capacity);
    return admitted;
  }
}

/** Index of the admissible shard with the most work left (ties: lowest workerId), or -1. */
function pickShard(
  shards: readonly ShardDemand[],
  granted: readonly number[],
  inFlightLimit: number,
): number {
  let best = -1;
  let bestLeft = 0;
  for (let i = 0; i < shards.length; i += 1) {
    const shard = shards[i];
    const left = shard.remaining - granted[i];
    if (left <= 0 || shard.inFlight + granted[i] >= inFlightLimit) continue;
    if (
      best < 0 ||
      left > bestLeft ||
      (left === bestLeft && shard.workerId < shards[best].workerId)
    ) {
      best = i;
      bestLeft = left;
    }
  }
  return best;
}

function validateDemand(shards: readonly ShardDemand[]): void {
  const seen = new Set<number>();
  for (const shard of shards) {
    requireInteger('workerId', shard.workerId, 0);
    requireInteger('remaining', shard.remaining, 0);
    requireInteger('inFlight', shard.inFlight, 0);
    if (seen.has(shard.workerId)) throw new RangeError(`duplicate workerId ${shard.workerId}`);
    seen.add(shard.workerId);
  }
}

function requireInteger(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min)
    throw new RangeError(`${name} must be an integer >= ${min} (got ${value})`);
}
