import {
  SCREEN_PROFILES,
  SCREEN_PROFILE_IDS,
  getScreenProfile,
  validateScreenProfile,
  type ScreenProfile,
} from '../core/screen-profiles';

describe('screen profiles (Q-P8-2)', () => {
  it('defines 360p/720p/1080p with increasing resolution and bitrate', () => {
    expect(SCREEN_PROFILE_IDS).toEqual(['SCREEN_360P', 'SCREEN_720P', 'SCREEN_1080P']);
    const p360 = SCREEN_PROFILES.SCREEN_360P;
    const p720 = SCREEN_PROFILES.SCREEN_720P;
    const p1080 = SCREEN_PROFILES.SCREEN_1080P;
    expect(p360.width).toBeLessThan(p720.width);
    expect(p720.width).toBeLessThan(p1080.width);
    expect(p360.maxBitrateKbps).toBeLessThan(p720.maxBitrateKbps);
    expect(p720.maxBitrateKbps).toBeLessThan(p1080.maxBitrateKbps);
  });

  it('every profile is internally consistent and valid', () => {
    for (const id of SCREEN_PROFILE_IDS) {
      const p = SCREEN_PROFILES[id];
      expect(validateScreenProfile(p)).toEqual([]);
      expect(p.codec).toBe('VP8');
      expect(p.fps).toBeGreaterThan(0);
      // the expected per-publisher Mbps should track the kbps ceiling
      expect(p.expectedMbpsPerPublisher).toBeCloseTo(p.maxBitrateKbps / 1000, 1);
    }
  });

  it('looks up by id and misses cleanly', () => {
    expect(getScreenProfile('SCREEN_720P')?.height).toBe(720);
    expect(getScreenProfile('nope')).toBeUndefined();
  });

  it('rejects out-of-range profiles', () => {
    const bad: ScreenProfile = {
      id: 'SCREEN_1080P',
      width: 99999,
      height: 10,
      fps: 120,
      codec: 'VP8',
      maxBitrateKbps: 999999,
      expectedMbpsPerPublisher: 1,
      contentModel: 'x',
    };
    const errs = validateScreenProfile(bad);
    expect(errs.some((e) => e.includes('width'))).toBe(true);
    expect(errs.some((e) => e.includes('height'))).toBe(true);
    expect(errs.some((e) => e.includes('fps'))).toBe(true);
    expect(errs.some((e) => e.includes('maxBitrateKbps'))).toBe(true);
  });
});
