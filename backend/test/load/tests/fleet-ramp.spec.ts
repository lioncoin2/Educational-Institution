import { GlobalRamp, type ShardDemand } from '../fleet/ramp';

interface SimShard {
  workerId: number;
  remaining: number;
  inFlight: number;
}

interface SimResult {
  /** Cumulative admissions after each tick. */
  readonly admittedAt: ReadonlyArray<{ readonly t: number; readonly admitted: number }>;
  readonly grants: readonly number[];
  readonly maxInFlight: number;
  readonly maxRemainingSpread: number;
  readonly shards: readonly SimShard[];
}

/**
 * Drives a ramp the way the controller does: at each tick, tickets older than
 * `latencyMs` reach a terminal event (in-flight −1), then the ramp grants and
 * each grant becomes a ticket in flight.
 */
function simulate(
  ramp: GlobalRamp,
  remaining: readonly number[],
  ticks: readonly number[],
  latencyMs: number,
): SimResult {
  const shards: SimShard[] = remaining.map((r, i) => ({
    workerId: i + 1,
    remaining: r,
    inFlight: 0,
  }));
  const pending: Array<{ readonly doneAt: number; readonly shard: SimShard }> = [];
  const admittedAt: Array<{ t: number; admitted: number }> = [];
  const grants: number[] = [];
  let maxInFlight = 0;
  let maxRemainingSpread = 0;
  for (const t of ticks) {
    for (const p of pending.filter((x) => x.doneAt <= t)) p.shard.inFlight -= 1;
    pending.splice(0, pending.length, ...pending.filter((x) => x.doneAt > t));
    for (const workerId of ramp.grant(t, shards)) {
      const shard = shards.find((s) => s.workerId === workerId)!;
      shard.remaining -= 1;
      shard.inFlight += 1;
      pending.push({ doneAt: t + latencyMs, shard });
      grants.push(workerId);
    }
    maxInFlight = Math.max(maxInFlight, ...shards.map((s) => s.inFlight));
    const left = shards.map((s) => s.remaining);
    maxRemainingSpread = Math.max(maxRemainingSpread, Math.max(...left) - Math.min(...left));
    admittedAt.push({ t, admitted: grants.length });
  }
  return { admittedAt, grants, maxInFlight, maxRemainingSpread, shards };
}

const every = (stepMs: number, untilMs: number): number[] =>
  Array.from({ length: Math.floor(untilMs / stepMs) + 1 }, (_, i) => i * stepMs);

const demand = (workerId: number, remaining: number, inFlight = 0): ShardDemand => ({
  workerId,
  remaining,
  inFlight,
});

describe('fleet ramp — rate', () => {
  it.each([2, 10, 25])('admits rate × elapsed (±1) at %i/s on a 100 ms tick', (rate) => {
    const ramp = new GlobalRamp({ ratePerSecond: rate, inFlightLimit: 1000 });
    const { admittedAt } = simulate(ramp, [5000, 5000, 5000], every(100, 30_000), 0);
    for (const { t, admitted } of admittedAt)
      expect(Math.abs(admitted - (rate * t) / 1000)).toBeLessThanOrEqual(1);
    expect(admittedAt.at(-1)?.admitted).toBe(rate * 30 + 1);
  });

  it('a jittery, coarse controller tick does not lower the rate', () => {
    const ticks = [0];
    for (let k = 1; ticks[ticks.length - 1] < 20_000; k += 1)
      ticks.push(ticks[ticks.length - 1] + 70 + ((k * 37) % 97)); // 70–166 ms
    const ramp = new GlobalRamp({ ratePerSecond: 10, inFlightLimit: 1000 });
    const { admittedAt } = simulate(ramp, [10_000], ticks, 0);
    for (const { t, admitted } of admittedAt)
      expect(admitted).toBe(1 + Math.floor((10 * t) / 1000));
  });

  it('starts full at the FIRST call: the first call admits up to burst', () => {
    const ramp = new GlobalRamp({ ratePerSecond: 10, inFlightLimit: 10 });
    expect(ramp.grant(5000, [demand(1, 10)])).toEqual([1]);
    expect(ramp.grant(5050, [demand(1, 9)])).toEqual([]);
    expect(ramp.grant(5100, [demand(1, 9)])).toEqual([1]);
  });

  it('regression: time before the first call (the publisher phase) accrues no credit', () => {
    // Real run: the ramp was built at prepare, phase A took ~15 s, and the first tick then
    // admitted every listener at once (measured 500/s against a configured 2/s).
    const ramp = new GlobalRamp({ ratePerSecond: 2, inFlightLimit: 10 });
    expect(ramp.grant(15_000, [demand(1, 100)])).toEqual([1]);
    expect(ramp.grant(15_050, [demand(1, 99)])).toEqual([]);
    expect(ramp.grant(15_500, [demand(1, 99)])).toEqual([1]);
  });
});

describe('fleet ramp — burst', () => {
  it('admits a burst at start, then paces at the rate', () => {
    const ramp = new GlobalRamp({ ratePerSecond: 10, burst: 5, inFlightLimit: 100 });
    expect(ramp.grant(0, [demand(1, 100)])).toHaveLength(5);
    expect(ramp.grant(100, [demand(1, 95)])).toHaveLength(1);
    expect(ramp.grant(300, [demand(1, 94)])).toHaveLength(2);
  });

  it('idle time does not pile up beyond burst + one tick of credit', () => {
    const ramp = new GlobalRamp({ ratePerSecond: 10, burst: 5, inFlightLimit: 100 });
    expect(ramp.grant(0, [demand(1, 5)])).toHaveLength(5);
    for (const t of every(100, 3000).slice(1)) expect(ramp.grant(t, [demand(1, 0)])).toEqual([]);
    expect(ramp.grant(3000, [demand(1, 100)])).toHaveLength(5);
    expect(ramp.grant(3100, [demand(1, 95)])).toHaveLength(1);
  });

  it('credit blocked by in-flight limits is capped at burst too', () => {
    const ramp = new GlobalRamp({ ratePerSecond: 10, burst: 2, inFlightLimit: 4 });
    for (const t of every(100, 2000)) expect(ramp.grant(t, [demand(1, 100, 4)])).toEqual([]);
    expect(ramp.grant(2100, [demand(1, 100, 0)])).toEqual([1, 1, 1]);
  });
});

describe('fleet ramp — shard selection and in-flight accounting', () => {
  it('gives each token to the shard with the most remaining work, ties to the lowest workerId', () => {
    const ramp = new GlobalRamp({ ratePerSecond: 1, burst: 10, inFlightLimit: 10 });
    const grants = ramp.grant(0, [demand(7, 2), demand(3, 5), demand(9, 3)]);
    expect(grants).toEqual([3, 3, 3, 9, 3, 7, 9, 3, 7, 9]);
  });

  it('never grants more than remaining or past the in-flight limit', () => {
    const ramp = new GlobalRamp({ ratePerSecond: 1, burst: 10, inFlightLimit: 4 });
    expect(ramp.grant(0, [demand(1, 2), demand(2, 100, 3), demand(3, 100, 4)])).toEqual([2, 1, 1]);
  });

  it('zero remaining work yields no grants and keeps the credit', () => {
    const ramp = new GlobalRamp({ ratePerSecond: 10, burst: 3, inFlightLimit: 4 });
    expect(ramp.grant(0, [])).toEqual([]);
    expect(ramp.grant(0, [demand(1, 0), demand(2, 0)])).toEqual([]);
    expect(ramp.grant(0, [demand(1, 0), demand(2, 2)])).toEqual([2, 2]);
  });

  it('respects the in-flight limit while spreading work evenly over a whole ramp', () => {
    const ramp = new GlobalRamp({ ratePerSecond: 25, inFlightLimit: 4 });
    const run = simulate(ramp, [100, 100, 100, 100], every(50, 60_000), 700);
    expect(run.maxInFlight).toBeLessThanOrEqual(4);
    expect(run.maxRemainingSpread).toBeLessThanOrEqual(1);
    expect(run.shards.map((s) => s.remaining)).toEqual([0, 0, 0, 0]);
    expect(run.grants).toHaveLength(400);
  });

  it('is deterministic for the same clock and demand', () => {
    const make = () => new GlobalRamp({ ratePerSecond: 7, burst: 3, inFlightLimit: 2 });
    const a = simulate(make(), [13, 9, 21], every(90, 10_000), 400);
    const b = simulate(make(), [13, 9, 21], every(90, 10_000), 400);
    expect(a.grants).toEqual(b.grants);
  });
});

describe('fleet ramp — validation', () => {
  const base = { ratePerSecond: 10, inFlightLimit: 4 };

  it('refuses invalid options', () => {
    for (const bad of [
      { ratePerSecond: 0 },
      { ratePerSecond: -1 },
      { ratePerSecond: Number.NaN },
      { ratePerSecond: Number.POSITIVE_INFINITY },
      { burst: 0 },
      { burst: 1.5 },
      { inFlightLimit: 0 },
      { inFlightLimit: 2.5 },
    ])
      expect(() => new GlobalRamp({ ...base, ...bad })).toThrow(RangeError);
  });

  it('refuses a clock that goes backwards and malformed demand', () => {
    expect(() => new GlobalRamp(base).grant(Number.NaN, [])).toThrow(RangeError); // even first
    const ramp = new GlobalRamp(base);
    ramp.grant(1000, []);
    expect(() => ramp.grant(999, [])).toThrow(RangeError);
    expect(() => ramp.grant(Number.NaN, [])).toThrow(RangeError);
    for (const bad of [
      [demand(1, 1), demand(1, 2)],
      [demand(1, -1)],
      [demand(1, 1, -1)],
      [demand(1, 1, 0.5)],
      [demand(-1, 1)],
    ])
      expect(() => ramp.grant(1000, bad)).toThrow(RangeError);
  });
});
