import { PROBE_MIN_TONE_RATIO } from '../observe/rules';
import {
  PROBE_BLOCK_MS,
  PROBE_TONE_HZ,
  blockToneRatio,
  goertzelPower,
  toneRatio,
} from '../mp/tone-probe';

const RATE = 48_000;
const AMPLITUDE = 4_000;
const ONE_SECOND = 480 * 100; // 100 publisher frames of 10 ms

function sine(hz: number, length: number, phase = 0): Int16Array {
  return Int16Array.from({ length }, (_, i) =>
    Math.round(AMPLITUDE * Math.sin((2 * Math.PI * hz * i) / RATE + phase)),
  );
}

/** Deterministic white noise, uniform in ±amplitude (mulberry32 PRNG). */
function noise(length: number, seed: number, amplitude = AMPLITUDE): Int16Array {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  return Int16Array.from({ length }, () => Math.round(amplitude * (2 * next() - 1)));
}

function mix(a: Int16Array, b: Int16Array): Int16Array {
  return Int16Array.from(a, (x, i) => x + (b[i] ?? 0));
}

describe('tone probe — Goertzel power', () => {
  it('probes the publisher tone', () => {
    expect(PROBE_TONE_HZ).toBe(440);
  });

  it('measures |X(hz)|² = (A·N/2)² for a whole-cycle sine at hz, ~0 off it', () => {
    const tone = sine(PROBE_TONE_HZ, ONE_SECOND);
    const expected = ((AMPLITUDE * ONE_SECOND) / 2) ** 2;
    expect(goertzelPower(tone, RATE, PROBE_TONE_HZ) / expected).toBeCloseTo(1, 3);
    expect(goertzelPower(tone, RATE, 1_000) / expected).toBeLessThan(1e-6);
  });

  it('is 0 for an empty capture', () => {
    expect(goertzelPower(new Int16Array(0), RATE, PROBE_TONE_HZ)).toBe(0);
  });
});

describe('tone probe — tone ratio', () => {
  it('a pure 440 Hz sine sits almost entirely at 440 Hz', () => {
    const ratio = toneRatio(sine(PROBE_TONE_HZ, ONE_SECOND), RATE, PROBE_TONE_HZ);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it('a 1 kHz sine carries no 440 Hz energy', () => {
    expect(toneRatio(sine(1_000, ONE_SECOND), RATE, PROBE_TONE_HZ)).toBeLessThan(0.05);
  });

  it('silence and an empty capture yield 0, never NaN', () => {
    expect(toneRatio(new Int16Array(ONE_SECOND), RATE, PROBE_TONE_HZ)).toBe(0);
    expect(toneRatio(new Int16Array(0), RATE, PROBE_TONE_HZ)).toBe(0);
  });

  it('white noise spreads its energy, leaving almost none at 440 Hz', () => {
    expect(toneRatio(noise(ONE_SECOND, 42), RATE, PROBE_TONE_HZ)).toBeLessThan(0.05);
  });

  it('the tone under equal-amplitude noise stays clearly above the noise alone', () => {
    const background = noise(ONE_SECOND, 7);
    const noisy = toneRatio(mix(sine(PROBE_TONE_HZ, ONE_SECOND), background), RATE, PROBE_TONE_HZ);
    const alone = toneRatio(background, RATE, PROBE_TONE_HZ);
    expect(noisy).toBeGreaterThan(0.5);
    expect(noisy).toBeGreaterThan(100 * alone);
  });

  it('a capture shorter than one 440 Hz period cannot resolve the tone and yields 0', () => {
    expect(toneRatio(sine(PROBE_TONE_HZ, 100), RATE, PROBE_TONE_HZ)).toBe(0);
    expect(toneRatio(Int16Array.of(AMPLITUDE), RATE, PROBE_TONE_HZ)).toBe(0);
  });

  it('one 10 ms frame resolves the tone at any phase, within [0, 1]', () => {
    for (const phase of [0, Math.PI / 4, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const ratio = toneRatio(sine(PROBE_TONE_HZ, 480, phase), RATE, PROBE_TONE_HZ);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThanOrEqual(1);
    }
  });

  it('rejects a tone outside (0, Nyquist) instead of returning NaN', () => {
    const tone = sine(PROBE_TONE_HZ, 480);
    expect(() => toneRatio(tone, RATE, 0)).toThrow(RangeError);
    expect(() => toneRatio(tone, RATE, RATE / 2)).toThrow(RangeError);
    expect(() => toneRatio(tone, 0, PROBE_TONE_HZ)).toThrow(RangeError);
    expect(() => goertzelPower(tone, Number.NaN, PROBE_TONE_HZ)).toThrow(RangeError);
  });
});

/** `segments` sine pieces of `segmentMs`, the phase jumping by π between pieces (playout shifts). */
function phaseShifted(segments: number, segmentMs: number): Int16Array {
  const length = (RATE * segmentMs) / 1000;
  const out = new Int16Array(segments * length);
  for (let s = 0; s < segments; s += 1)
    out.set(sine(PROBE_TONE_HZ, length, s * Math.PI), s * length);
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const blockOf = (ms: number): number => (RATE * ms) / 1000;

describe('tone probe — block median (the judged value)', () => {
  it('a clean 1 s tone passes with a ratio near 1', () => {
    expect(blockToneRatio(sine(PROBE_TONE_HZ, ONE_SECOND), RATE, PROBE_TONE_HZ)).toBeGreaterThan(
      0.99,
    );
  });

  it('regression: playout phase shifts sink the whole-window ratio but not the block median', () => {
    // Real run (P8.4 pre-commit): jitter-buffer phase shifts gave 0.65 over 1 s, median block 1.00.
    const shifted = phaseShifted(4, 250);
    expect(toneRatio(shifted, RATE, PROBE_TONE_HZ)).toBeLessThan(PROBE_MIN_TONE_RATIO);
    expect(blockToneRatio(shifted, RATE, PROBE_TONE_HZ)).toBeGreaterThan(0.9);
  });

  it('regression: jitter-buffer warm-up (leading silence in a minority of blocks) still passes', () => {
    const capture = concat(new Int16Array(blockOf(300)), sine(PROBE_TONE_HZ, blockOf(700)));
    expect(blockToneRatio(capture, RATE, PROBE_TONE_HZ)).toBeGreaterThan(0.9);
  });

  it('a capture that is MOSTLY silence fails (the median is not a "best block")', () => {
    const capture = concat(new Int16Array(blockOf(600)), sine(PROBE_TONE_HZ, blockOf(400)));
    expect(blockToneRatio(capture, RATE, PROBE_TONE_HZ)).toBeLessThan(PROBE_MIN_TONE_RATIO);
  });

  it('silence, noise and another frequency fail', () => {
    expect(blockToneRatio(new Int16Array(ONE_SECOND), RATE, PROBE_TONE_HZ)).toBe(0);
    expect(blockToneRatio(noise(ONE_SECOND, 42), RATE, PROBE_TONE_HZ)).toBeLessThan(0.05);
    expect(blockToneRatio(sine(1_000, ONE_SECOND), RATE, PROBE_TONE_HZ)).toBeLessThan(0.05);
  });

  it('even block counts take the mean of the two middle blocks', () => {
    const capture = concat(new Int16Array(blockOf(200)), sine(PROBE_TONE_HZ, blockOf(200)));
    const ratio = blockToneRatio(capture, RATE, PROBE_TONE_HZ);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  it('ignores a trailing partial block; without one whole block the value is 0', () => {
    const block = blockOf(PROBE_BLOCK_MS);
    expect(blockToneRatio(sine(PROBE_TONE_HZ, block - 1), RATE, PROBE_TONE_HZ)).toBe(0);
    const withTail = concat(sine(PROBE_TONE_HZ, block), new Int16Array(block - 1));
    expect(blockToneRatio(withTail, RATE, PROBE_TONE_HZ)).toBeGreaterThan(0.99);
  });

  it('rejects a tone outside (0, Nyquist)', () => {
    expect(() => blockToneRatio(sine(PROBE_TONE_HZ, ONE_SECOND), RATE, RATE / 2)).toThrow(
      RangeError,
    );
  });
});
