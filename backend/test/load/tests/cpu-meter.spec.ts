import {
  type CoreBusy,
  IDLE_CLOCK_RESOLUTION_TICKS,
  coreBusy,
  hottestBusyPct,
  idleClockExact,
  totalBusyPct,
} from '../observe/cpu-meter';
import { type CoreTicks, type HostSample } from '../observe/sample';
import { sample } from './support/result-fixtures';

const core = (id: number, ticks: Partial<CoreTicks> = {}): CoreTicks => ({
  id,
  user: 0,
  nice: 0,
  sys: 0,
  idle: 0,
  iowait: 0,
  irq: 0,
  soft: 0,
  steal: 0,
  ...ticks,
});

const at = (clockMs: number | null, cores: CoreTicks[] | null): HostSample =>
  sample({ cpuClockMs: clockMs, cores });

/** Deterministic PRNG (mulberry32) for the property checks. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe('observe/cpu-meter — exact per-core busy', () => {
  it('busy = window − Δidle − Δiowait per core, the window from the CPU clock', () => {
    const busy = coreBusy(
      at(10_000, [core(0, { idle: 500, iowait: 5 }), core(1, { idle: 800 })]),
      at(15_000, [core(0, { idle: 800, iowait: 25 }), core(1, { idle: 1_300 })]),
    );
    expect(busy).toEqual([
      { id: 0, busy: 180, window: 500 }, // 500 − 300 − 20
      { id: 1, busy: 0, window: 500 }, // fully idle
    ]);
    expect(hottestBusyPct(busy)).toBe(36);
    expect(totalBusyPct(busy)).toBe(18); // 180 ÷ 1,000
  });

  it('regression (errata E9): a pinned 100 % core reads 100 % in EVERY window', () => {
    // Measured on the SUT: tick-sampled busy 48–100 % per 500 ms window, /proc/schedstat 0–460 %,
    // the idle clock exactly 100.0 %. The busy tick fields do not enter the meter at all.
    const tickBusy = [99.8, 91.8, 96.7, 99.9, 97.7, 95.5, 99.9, 87.9, 87.8, 47.9, 95.8, 99.8];
    let user = 0;
    for (const [k, pct] of tickBusy.entries()) {
      const before = at(k * 500, [core(0, { user, idle: 7_000 })]);
      user += Math.round((pct / 100) * 50);
      const after = at((k + 1) * 500, [core(0, { user, idle: 7_000 })]);
      expect(hottestBusyPct(coreBusy(before, after))).toBe(100);
    }
  });

  it('never exceeds capacity and never goes below zero, for ANY counter movement', () => {
    const rand = prng(20261005);
    for (let n = 0; n < 2_000; n += 1) {
      const windowMs = 1 + rand() * 10_000;
      const cores = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, id) => id);
      // Δidle/Δiowait anywhere from −50 ticks (a counter stepping back) to 2× the window (skew).
      const step = () => Math.round((rand() * 2.5 - 0.5) * (windowMs / 10));
      const prev = at(
        1_000,
        cores.map((id) => core(id, { idle: 10_000, iowait: 1_000 })),
      );
      const cur = at(
        1_000 + windowMs,
        cores.map((id) => core(id, { idle: 10_000 + step(), iowait: 1_000 + step() })),
      );
      const busy = coreBusy(prev, cur) as CoreBusy[];
      for (const c of busy) {
        expect(c.busy).toBeGreaterThanOrEqual(0);
        expect(c.busy).toBeLessThanOrEqual(c.window);
      }
      for (const pct of [hottestBusyPct(busy), totalBusyPct(busy)]) {
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }
    }
  });

  it('idle floored to whole ticks reads at most IDLE_CLOCK_RESOLUTION_TICKS low, and 0 — never negative', () => {
    expect(IDLE_CLOCK_RESOLUTION_TICKS).toBe(2);
    // An idle core whose idle and iowait reads rounded up: −1 tick → 0.
    const busy = coreBusy(
      at(0, [core(0, { idle: 0, iowait: 0 })]),
      at(1_000, [core(0, { idle: 100, iowait: 1 })]),
    );
    expect(busy).toEqual([{ id: 0, busy: 0, window: 100 }]);
    expect(
      coreBusy(at(0, [core(0)]), at(1_000, [core(0, { idle: 101, iowait: 1 })]))?.[0]?.busy,
    ).toBe(0);
  });

  it('is null without both readings, a CPU clock or a positive window; matches cores by id', () => {
    const cores = [core(0, { idle: 10 })];
    expect(coreBusy(null, at(5_000, cores))).toBeNull();
    expect(coreBusy(at(0, null), at(5_000, cores))).toBeNull();
    expect(coreBusy(at(null, cores), at(5_000, cores))).toBeNull();
    expect(coreBusy(at(0, cores), at(null, cores))).toBeNull();
    expect(coreBusy(at(5_000, cores), at(5_000, cores))).toBeNull();
    expect(coreBusy(at(6_000, cores), at(5_000, cores))).toBeNull();
    expect(coreBusy(at(0, [core(0)]), at(1_000, [core(1)]))).toBeNull(); // no common core
    expect(hottestBusyPct(null)).toBeNull();
    expect(totalBusyPct(null)).toBeNull();
  });
});

describe('observe/cpu-meter — the idle clock is exact only under NO_HZ', () => {
  it('nohz=off anywhere on the command line refuses it; other nohz settings keep it', () => {
    expect(idleClockExact('BOOT_IMAGE=/vmlinuz root=/dev/sda1 ro\n')).toBe(true);
    expect(idleClockExact('nohz=off root=/dev/sda1')).toBe(false);
    expect(idleClockExact('root=/dev/sda1 nohz=off quiet')).toBe(false);
    expect(idleClockExact('root=/dev/sda1 nohz=off\n')).toBe(false);
    expect(idleClockExact('root=/dev/sda1 nohz=on')).toBe(true);
    expect(idleClockExact('root=/dev/sda1 nohz_full=2-7')).toBe(true);
    expect(idleClockExact('root=/dev/sda1 xnohz=off')).toBe(true);
    expect(idleClockExact(null)).toBe(false);
  });
});
