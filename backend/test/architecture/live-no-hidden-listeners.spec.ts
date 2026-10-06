import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The production Live source: every `.ts` under `src/modules/live` that is not a spec. */
const LIVE_SRC = join(__dirname, '..', '..', 'src', 'modules', 'live');

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

/** `hidden` set true in an object literal — the one construction Q59 forbids. */
const HIDDEN_TRUE = /\bhidden\s*:\s*true\b/;

const relative = (file: string): string => file.slice(file.indexOf('src/'));

/**
 * Q59 / ADR 0027 — no hidden live listeners. The authoritative capability
 * builder pins `hidden: false` for every standing (`domain/standing.ts`), and
 * `capabilityDrift` treats an observed `hidden` as a breach the reconciler
 * ejects. This guard keeps any production Live file from ever introducing a
 * `hidden: true` literal — the one construction that would mint an invisible
 * participant and so admit someone to a session without appearing in the
 * roster. It reads the real source, not a fixture.
 */
describe('Q59 — production Live code never sets hidden:true (ADR 0027)', () => {
  const files = productionFiles(LIVE_SRC);
  const sources = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it('is non-vacuous: it scans the real capability source, and its matcher works', () => {
    // It actually reached the files where `hidden` is declared and pinned false.
    expect(files.map(relative)).toEqual(
      expect.arrayContaining([
        'src/modules/live/domain/rtc-provider.ts',
        'src/modules/live/domain/standing.ts',
      ]),
    );
    const standing = sources.find((source) => source.file.endsWith('domain/standing.ts'));
    expect(standing?.text).toMatch(/\bhidden\s*:\s*false\b/);

    // The matcher catches an introduction, and does not fire on the pinned false —
    // so a clean result below is real, not a broken regex matching nothing.
    expect(HIDDEN_TRUE.test('    hidden: true,')).toBe(true);
    expect(HIDDEN_TRUE.test('    hidden: false,')).toBe(false);
  });

  it('never sets hidden:true anywhere in production Live code', () => {
    const offenders = sources
      .filter((source) => HIDDEN_TRUE.test(source.text))
      .map((source) => relative(source.file));
    expect(offenders).toEqual([]);
  });
});
