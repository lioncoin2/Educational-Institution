import {
  applyOverrides,
  customScenario,
  participantsPerRoom,
  readArgs,
  totalParticipants,
  totalPublishers,
  validateScenario,
  type Scenario,
} from '../core/config';
import { getScenario } from '../scenarios/catalog';

const base = getScenario('lk-listeners-500') as Scenario;

describe('load harness config', () => {
  it('reads typed flags into buckets', () => {
    const args = readArgs(['--rooms', '5', '--relay', '--target', 'wss://x', '--scenario', 'foo']);
    expect(args.numbers.get('rooms')).toBe(5);
    expect(args.bools.has('relay')).toBe(true);
    expect(args.strings.get('target')).toBe('wss://x');
    expect(args.strings.get('scenario')).toBe('foo');
    expect(args.bad).toEqual([]);
  });

  it('flags a numeric flag given no number, and unknown flags', () => {
    const args = readArgs(['--rooms', '--nope', 'x']);
    expect(args.bad.some((b) => b.includes('--rooms'))).toBe(true);
    expect(args.unknown).toContain('--nope');
  });

  it('applies overrides onto a catalog scenario', () => {
    const args = readArgs(['--listeners', '42', '--relay']);
    const s = applyOverrides(base, args);
    expect(s.listenersPerRoom).toBe(42);
    expect(s.relay).toBe(true);
    expect(s.rooms).toBe(base.rooms);
  });

  it('builds a custom scenario from flags with tiny defaults', () => {
    const s = customScenario(readArgs(['--kind', 'livekit', '--listeners', '3']));
    expect(s.id).toBe('custom');
    expect(s.target).toBe('livekit');
    expect(s.rooms).toBe(1);
    expect(s.listenersPerRoom).toBe(3);
  });

  it('derives totals correctly', () => {
    const s = applyOverrides(
      base,
      readArgs(['--rooms', '4', '--listeners', '10', '--speakers', '2']),
    );
    expect(participantsPerRoom(s)).toBe(12);
    expect(totalParticipants(s)).toBe(48);
    expect(totalPublishers(s)).toBe(8);
  });

  it('validates well-formedness', () => {
    const bad = applyOverrides(base, readArgs(['--rooms', '0', '--duration', '0']));
    const errs = validateScenario(bad);
    expect(errs.some((e) => e.includes('rooms'))).toBe(true);
    expect(errs.some((e) => e.includes('duration'))).toBe(true);
    expect(validateScenario(base)).toEqual([]);
  });

  it('rejects an api scenario with no api load', () => {
    const s = customScenario(readArgs(['--kind', 'api']));
    expect(validateScenario(s).some((e) => e.includes('api'))).toBe(true);
  });
});
