import { totalParticipants, validateScenario } from '../core/config';
import { checkScenarioSafety } from '../core/safety';
import { MP_SCENARIOS, getScenario } from '../scenarios/catalog';
import { validateMp } from '../mp/partition';
import { buildPlan, renderConfirmation } from '../cli/mp-run';

describe('MP scenarios', () => {
  it('defines MP_PUB, MP_SMOKE, MP_40, each valid, within caps, and worker-bounded', () => {
    const ids = MP_SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(['MP_PUB', 'MP_SMOKE', 'MP_40']);
    for (const s of MP_SCENARIOS) {
      expect({ id: s.id, errs: validateScenario(s) }).toEqual({ id: s.id, errs: [] });
      expect(checkScenarioSafety(s)).toEqual([]);
      expect(s.mediaPath).toBe('direct');
      expect(s.workers).toBeGreaterThanOrEqual(2);
      // every worker stays well under the ~40 single-process failure point
      expect(validateMp(totalParticipants(s), s.workers!)).toEqual([]);
    }
  });

  it('MP_PUB is exactly 2 participants with a publisher', () => {
    const s = getScenario('MP_PUB')!;
    expect(totalParticipants(s)).toBe(2);
    expect(s.speakersPerRoom).toBe(1);
  });

  it('MP_SMOKE is 20 participants over 2 workers (10/worker)', () => {
    const s = getScenario('MP_SMOKE')!;
    expect(totalParticipants(s)).toBe(20);
    expect(s.workers).toBe(2);
  });
});

describe('MP CLI (dry-run / gate)', () => {
  it('defaults to a dry-run and never names a target', () => {
    const p = buildPlan(['--scenario', 'MP_SMOKE']);
    expect(p.errors).toEqual([]);
    expect(p.allowLoad).toBe(false);
    expect(renderConfirmation(p)).toContain('DRY-RUN');
    expect(renderConfirmation(p)).toContain('EXACT GATE');
    expect(renderConfirmation(p)).toContain('MEDIA PATH         : direct');
  });

  it('shows REAL-LOAD only with allow-load + target', () => {
    const p = buildPlan([
      '--scenario',
      'MP_SMOKE',
      '--allow-load',
      '--target',
      'wss://livekit-staging.adlink4.com',
    ]);
    expect(renderConfirmation(p)).toContain('REAL-LOAD');
  });

  it('refuses an over-cap participants/worker combination', () => {
    // 20 participants with 1 worker => 20/worker is fine; force a cap breach via listeners
    const p = buildPlan(['--scenario', 'MP_SMOKE', '--listeners', '999', '--workers', '2']);
    expect(p.errors.some((e) => e.includes('participants/worker'))).toBe(true);
  });

  it('rejects an unknown scenario and a bad media-path', () => {
    expect(buildPlan(['--scenario', 'nope']).errors.some((e) => e.includes('unknown'))).toBe(true);
    expect(
      buildPlan(['--scenario', 'MP_SMOKE', '--media-path', 'sideways']).errors.some((e) =>
        e.includes('media-path'),
      ),
    ).toBe(true);
  });
});
