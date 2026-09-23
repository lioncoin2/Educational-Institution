import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Events are public contracts.
 *
 * A subscriber may import nothing of another module but its `contracts/`
 * (`no-cross-module-internals`; type-only imports count). An event whose name
 * and payload type are declared in a module's domain can therefore only be
 * consumed by matching a string literal — no compiler, no review. So every
 * event type (`DomainEvent<'…'>` or `DomainEvent<typeof …>`) is declared in
 * the publishing module's `contracts/` folder, and domain code only builds
 * events from those types.
 *
 * Identity's four events predate the rule and have no subscriber outside
 * identity; they move to its contracts when they get one (ADR 0021).
 */
const SRC = join(__dirname, '..', '..', 'src');

const ALLOWED_OUTSIDE_CONTRACTS = new Set([
  // Grandfathered: identity's events, until their first outside subscriber.
  'modules/identity/domain/events.ts',
]);

/** A type alias that declares an event: DomainEvent< followed by a literal or `typeof`. */
const EVENT_DECLARATION = /DomainEvent<\s*(['"`]|typeof\s)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('events are declared in contracts', () => {
  const declaring = sourceFiles(SRC)
    .filter((path) => EVENT_DECLARATION.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path).split('\\').join('/'));

  it('finds event declarations in several modules — the check below is not vacuous', () => {
    const inContracts = declaring.filter((path) => /^modules\/[^/]+\/contracts\//.test(path));
    expect(inContracts).toEqual(
      expect.arrayContaining([
        'modules/academic/contracts/events.ts',
        'modules/live/contracts/events.ts',
        'modules/messaging/contracts/events.ts',
        'modules/notifications/contracts/events.ts',
      ]),
    );
  });

  it('declares no event type outside a module’s contracts', () => {
    const outside = declaring.filter(
      (path) => !/^modules\/[^/]+\/contracts\//.test(path) && !ALLOWED_OUTSIDE_CONTRACTS.has(path),
    );
    expect(outside).toEqual([]);
  });

  it('keeps the allow-list honest — every grandfathered file still declares events', () => {
    for (const path of ALLOWED_OUTSIDE_CONTRACTS) expect(declaring).toContain(path);
  });
});
