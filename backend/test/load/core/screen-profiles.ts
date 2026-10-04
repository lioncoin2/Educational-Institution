/**
 * P8.2 — screen-share source profiles (resolves Q-P8-2). The P8.1 driver
 * published a 320×180 solid frame, useless for bandwidth. These profiles pin a
 * resolution, framerate, codec and a **bitrate ceiling** (rtc-node's
 * TrackPublishOptions.videoEncoding.maxBitrate / maxFramerate), and the driver
 * feeds deterministic high-entropy motion so the encoder sustains near that
 * ceiling.
 *
 * HONESTY (what this represents): `maxBitrate` is a CEILING, not a guarantee.
 * The generated content is high-entropy pseudo-random motion that pushes the
 * encoder toward the ceiling — an UPPER BOUND on screen-share bandwidth. Real
 * desktop capture is usually low-motion (mostly static text/UI) and sits WELL
 * BELOW these numbers, with occasional spikes on scroll/video. The expected
 * bandwidth below is therefore a worst-case-per-publisher planning figure, to be
 * confirmed by measuring the achieved bitrate in the smoke test (never asserted
 * from resolution alone). Pure: no SDK, no I/O.
 */

export type ScreenProfileId = 'SCREEN_360P' | 'SCREEN_720P' | 'SCREEN_1080P';

export interface ScreenProfile {
  readonly id: ScreenProfileId;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly codec: 'VP8';
  /** Encoder bitrate ceiling (kbps) handed to rtc-node as maxBitrate. */
  readonly maxBitrateKbps: number;
  /** Approx worst-case outbound per publisher at the ceiling (Mbps). */
  readonly expectedMbpsPerPublisher: number;
  /** What the generated content models. */
  readonly contentModel: string;
}

export const SCREEN_PROFILES: Readonly<Record<ScreenProfileId, ScreenProfile>> = {
  SCREEN_360P: {
    id: 'SCREEN_360P',
    width: 640,
    height: 360,
    fps: 15,
    codec: 'VP8',
    maxBitrateKbps: 600,
    expectedMbpsPerPublisher: 0.6,
    contentModel: 'high-entropy motion → ~ceiling; a busy 360p share (upper bound)',
  },
  SCREEN_720P: {
    id: 'SCREEN_720P',
    width: 1280,
    height: 720,
    fps: 15,
    codec: 'VP8',
    maxBitrateKbps: 1500,
    expectedMbpsPerPublisher: 1.5,
    contentModel: 'high-entropy motion → ~ceiling; a busy 720p share (upper bound)',
  },
  SCREEN_1080P: {
    id: 'SCREEN_1080P',
    width: 1920,
    height: 1080,
    fps: 15,
    codec: 'VP8',
    maxBitrateKbps: 2500,
    expectedMbpsPerPublisher: 2.5,
    contentModel: 'high-entropy motion → ~ceiling; a busy 1080p share (upper bound)',
  },
};

export const SCREEN_PROFILE_IDS: readonly ScreenProfileId[] = [
  'SCREEN_360P',
  'SCREEN_720P',
  'SCREEN_1080P',
];

export function getScreenProfile(id: string): ScreenProfile | undefined {
  return (SCREEN_PROFILES as Record<string, ScreenProfile>)[id];
}

/** Well-formedness of a profile (guards hand-built or overridden profiles). */
export function validateScreenProfile(p: ScreenProfile): string[] {
  const errs: string[] = [];
  if (p.width < 16 || p.width > 3840) errs.push('width out of range (16..3840)');
  if (p.height < 16 || p.height > 2160) errs.push('height out of range (16..2160)');
  if (p.fps < 1 || p.fps > 60) errs.push('fps out of range (1..60)');
  if (p.maxBitrateKbps < 50 || p.maxBitrateKbps > 20_000)
    errs.push('maxBitrateKbps out of range (50..20000)');
  if (!Number.isInteger(p.width) || !Number.isInteger(p.height))
    errs.push('width/height must be whole numbers');
  return errs;
}
