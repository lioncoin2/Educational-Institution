/**
 * P8.4 — the sampled content probe's detector (design §8). A pure Goertzel
 * filter measures how much of a decoded capture's energy sits at the
 * publisher's tone, block by block: proof that decoded audio arrives, not just packets. It
 * reports a ratio only; the pass/fail threshold is a verdict-table rule
 * (observe/rules.ts) and is never restated here.
 */

/** The tone the publisher sends (test/livekit/load/media-driver.ts). */
export const PROBE_TONE_HZ = 440;

/**
 * Goertzel power |X(hz)|² of `samples`: the squared magnitude of their
 * discrete-time Fourier transform at `hz`, in (sample units)². `hz` need not
 * fall on a DFT bin. Throws RangeError unless 0 < hz < sampleRate / 2.
 */
export function goertzelPower(samples: Int16Array, sampleRate: number, hz: number): number {
  assertInBand(sampleRate, hz);
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (const x of samples) {
    const s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Fraction (0..1) of the capture's energy that sits at `hz`.
 *
 * Normalisation: ratio = 2·P / (N·E), with P = goertzelPower, N the sample
 * count and E = Σx². By Parseval the DFT carries N·E in total, and a real tone
 * puts equal power in its bin pair ±hz, so a pure sine at `hz` spanning whole
 * cycles yields 1 and white noise ≈ 2/N. Off-bin leakage on short windows can
 * push the raw value slightly past 1, so it is clamped to [0, 1]. A capture
 * shorter than one period of `hz` cannot resolve the tone and yields 0, as do
 * empty and all-zero captures (never NaN). Throws RangeError unless
 * 0 < hz < sampleRate / 2.
 */
export function toneRatio(samples: Int16Array, sampleRate: number, hz: number): number {
  assertInBand(sampleRate, hz);
  if (samples.length < sampleRate / hz) return 0;
  let energy = 0;
  for (const x of samples) energy += x * x;
  if (energy === 0) return 0;
  const ratio = (2 * goertzelPower(samples, sampleRate, hz)) / (samples.length * energy);
  return Math.min(1, Math.max(0, ratio));
}

/** The probe's block: 100 ms = 44 periods of 440 Hz, short enough to stay phase-coherent. */
export const PROBE_BLOCK_MS = 100;

/**
 * The probe's judged value: the MEDIAN `toneRatio` over consecutive `blockMs` blocks.
 *
 * A receiver's jitter buffer legitimately stretches and shrinks playout, which shifts the tone's
 * phase; one phase-coherent window across such a shift cancels its own energy (P8.4 pre-commit
 * real run: 0.65 over the first second while the median 100 ms block was 1.00). Each block is
 * coherent on its own, and the median ignores a minority of disturbed blocks (jitter-buffer
 * warm-up, a concealment) but never a capture that is mostly silence, noise or another
 * frequency. A trailing partial block is ignored; without one whole block the value is 0.
 * Throws RangeError unless 0 < hz < sampleRate / 2.
 */
export function blockToneRatio(
  samples: Int16Array,
  sampleRate: number,
  hz: number,
  blockMs = PROBE_BLOCK_MS,
): number {
  assertInBand(sampleRate, hz);
  const size = Math.round((sampleRate * blockMs) / 1000);
  const ratios: number[] = [];
  for (let at = 0; size > 0 && at + size <= samples.length; at += size) {
    ratios.push(toneRatio(samples.subarray(at, at + size), sampleRate, hz));
  }
  if (ratios.length === 0) return 0;
  ratios.sort((a, b) => a - b);
  const mid = ratios.length >> 1;
  const upper = ratios[mid] ?? 0;
  return ratios.length % 2 === 1 ? upper : ((ratios[mid - 1] ?? 0) + upper) / 2;
}

function assertInBand(sampleRate: number, hz: number): void {
  if (!(Number.isFinite(sampleRate) && hz > 0 && hz < sampleRate / 2)) {
    throw new RangeError(`tone ${hz} Hz is outside (0, Nyquist) at ${sampleRate} Hz`);
  }
}
