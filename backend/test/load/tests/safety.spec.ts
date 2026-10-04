import { type HarnessConfig, type Scenario } from '../core/config';
import { SAFETY_LIMITS, checkScenarioSafety, decideGate } from '../core/safety';
import { getScenario } from '../scenarios/catalog';

const base = getScenario('lk-listeners-500') as Scenario;

function config(over: Partial<HarnessConfig> & { scenario?: Scenario } = {}): HarnessConfig {
  return {
    scenario: over.scenario ?? base,
    target: over.target ?? null,
    allowLoad: over.allowLoad ?? false,
    outCsv: null,
    sampleIntervalMs: 2000,
  };
}

describe('load harness safety', () => {
  it('passes a within-caps scenario', () => {
    expect(checkScenarioSafety(base)).toEqual([]);
  });

  it('refuses an over-cap participant count', () => {
    const huge: Scenario = { ...base, listenersPerRoom: 500_000 };
    const v = checkScenarioSafety(huge);
    expect(v.some((m) => m.includes('total participants'))).toBe(true);
  });

  it('refuses over-cap rooms, duration and ramp', () => {
    const s: Scenario = {
      ...base,
      rooms: SAFETY_LIMITS.maxRooms + 1,
      holdSeconds: SAFETY_LIMITS.maxDurationSeconds + 1,
      rampPerSecond: SAFETY_LIMITS.maxRampPerSecond + 1,
    };
    const v = checkScenarioSafety(s);
    expect(v.some((m) => m.includes('rooms'))).toBe(true);
    expect(v.some((m) => m.includes('duration'))).toBe(true);
    expect(v.some((m) => m.includes('ramp'))).toBe(true);
  });

  it('defaults to dry-run with no --allow-load', () => {
    const d = decideGate(config());
    expect(d.mode).toBe('dry-run');
    expect(d.willGenerateLoad).toBe(false);
  });

  it('refuses real load without a target even with --allow-load', () => {
    const d = decideGate(config({ allowLoad: true }));
    expect(d.mode).toBe('refused');
    expect(d.refusals.some((r) => r.includes('--target'))).toBe(true);
  });

  it('refuses real load when a safety cap is exceeded', () => {
    const huge: Scenario = { ...base, listenersPerRoom: 500_000 };
    const d = decideGate(config({ scenario: huge, allowLoad: true, target: 'wss://x' }));
    expect(d.mode).toBe('refused');
    expect(d.willGenerateLoad).toBe(false);
  });

  it('authorizes real load only with allow-load + target + within caps', () => {
    const d = decideGate(config({ allowLoad: true, target: 'wss://livekit-staging.adlink4.com' }));
    expect(d.mode).toBe('real-load');
    expect(d.willGenerateLoad).toBe(true);
  });
});
