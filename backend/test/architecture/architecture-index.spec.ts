import { existsSync, readFileSync } from 'node:fs';

import { INDEX_PATH, buildModel, generateIndex, isFresh } from '../tooling/architecture-index';

/**
 * The generated architecture index, kept honest.
 *
 * docs/architecture/architecture-index.md is generated from the source
 * (`npm run arch:index`). This spec is what keeps the committed copy from drifting:
 * it regenerates in memory and asserts the committed bytes match, so a module,
 * feature or ADR added without regenerating fails the build here — inside
 * `npm test`, and so inside `npm run verify` and CI.
 *
 * It also guards against the check being vacuous two ways: floors on what the
 * generator discovered (an empty scan would match an empty committed file and
 * prove nothing), and a direct check that `isFresh` can both pass and fail.
 */
describe('architecture index', () => {
  const model = buildModel();

  it('discovered the whole repository (so the freshness check is not vacuous)', () => {
    // Floors, not exact counts: adding a module/feature/ADR must not break this
    // test — it must break the freshness test below until the index is regenerated.
    expect(model.modules.length).toBeGreaterThanOrEqual(14);
    expect(model.features.length).toBeGreaterThanOrEqual(16);
    expect(model.adrs.length).toBeGreaterThanOrEqual(30);
    expect(model.repositories.length).toBeGreaterThanOrEqual(13);
  });

  it('extracted real mechanical facts, not empty rows', () => {
    const index = generateIndex();
    // A known module, a known Flutter contract, and an event that is actually
    // declared in a contracts/events.ts — each would vanish if an extractor broke.
    expect(index).toContain('### identity');
    expect(index).toContain('### attendance');
    expect(index).toContain('AttendanceRepository');
    expect(index).toContain('attendance.snapshot.recorded');
    // Edges must be labelled as static imports, never as runtime behaviour.
    expect(index).toContain('Static imports');
  });

  it('is committed and up to date (regenerate with `npm run arch:index`)', () => {
    expect(existsSync(INDEX_PATH)).toBe(true);
    const committed = readFileSync(INDEX_PATH, 'utf8');
    expect(isFresh(committed, generateIndex())).toBe(true);
  });

  it('has a staleness check that can actually fail (negative control)', () => {
    const index = generateIndex();
    expect(isFresh(index, index)).toBe(true);
    expect(isFresh(`${index}drift`, index)).toBe(false);
  });
});
