import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { cruise, type CruiseOutput } from '../support/dependency-graph';

const SRC = join(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Every `src/modules/<name>/<name>.module.ts`, with its text. */
function moduleFiles(): { name: string; text: string }[] {
  const modules = join(SRC, 'modules');
  return readdirSync(modules)
    .filter((name) => statSync(join(modules, name)).isDirectory())
    .map((name) => ({
      name,
      text: readFileSync(join(modules, name, `${name}.module.ts`), 'utf8'),
    }));
}

/** name -> the module specifier it is imported from, for every named import in a file. */
function importSources(text: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const specifier of match[1].split(',')) {
      const local = specifier
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (local) sources.set(local, match[2]);
    }
  }
  return sources;
}

/**
 * The architecture, asserted.
 *
 * docs/architecture/dependency-rules.md describes the boundaries; this test is
 * what makes them true. It runs inside `npm test`, so an illegal import fails
 * the build in the same breath as a broken unit test — which is the only way a
 * boundary survives contact with a deadline.
 *
 * It shells out to the dependency-cruiser CLI (the package is ESM-only, and this
 * runs precisely what CI runs).
 */
describe('module boundaries', () => {
  let output: CruiseOutput;

  beforeAll(() => {
    output = cruise();
  }, 180_000);

  it('analysed the source tree', () => {
    // Guards against a silently empty run making the assertion below vacuous.
    expect(output.summary.totalCruised).toBeGreaterThan(40);
  });

  it('reports no violation of any architectural rule', () => {
    const violations = output.summary.violations.filter(
      (violation) => violation.rule.severity === 'error',
    );

    // Naming the offending edges turns a red test into an actionable one.
    const detail = violations
      .map((violation) => `${violation.rule.name}: ${violation.from} -> ${violation.to}`)
      .join('\n');

    expect(detail).toBe('');
  });

  // The rule set already forbids this; stating it as its own test makes the
  // property the brief asked for — "no module directly imports identity
  // internals" — visible, and names the offender if it ever breaks.
  it('lets other modules reach identity only through its contracts', () => {
    const identity = 'src/modules/identity/';
    const intrusions = output.modules
      .filter((module) => !module.source.startsWith(identity))
      .flatMap((module) =>
        module.dependencies
          .filter((dependency) => dependency.resolved.startsWith(identity))
          .filter(
            (dependency) =>
              !dependency.resolved.startsWith(`${identity}contracts/`) &&
              dependency.resolved !== `${identity}identity.module.ts`,
          )
          .map((dependency) => `${module.source} -> ${dependency.resolved}`),
      )
      // Composition roots assemble the application; they are not modules.
      .filter((edge) => !/^src\/(app\.module|main|cli\/)/.test(edge));

    expect(intrusions).toEqual([]);
  });

  it("keeps identity's tables private to identity", () => {
    const readers = output.modules
      .filter((module) =>
        module.dependencies.some(
          (d) => d.resolved === 'src/modules/identity/infrastructure/schema.ts',
        ),
      )
      .map((module) => module.source)
      .filter((source) => !source.startsWith('src/modules/identity/'));
    expect(readers).toEqual([]);
  });

  // A module is used through what it exports, so its exports ARE its public
  // surface. Each must be a token declared in the module's own contracts —
  // never a use case, a repository or an adapter class, which would hand
  // another module a door around every rule above.
  it('exports only tokens declared in the module’s own contracts', () => {
    const offending: string[] = [];
    let exported = 0;
    for (const { name, text } of moduleFiles()) {
      const list = /exports:\s*\[([^\]]*)\]/.exec(text);
      if (!list) continue;
      const sources = importSources(text);
      for (const token of list[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        exported += 1;
        const source = sources.get(token);
        if (source === undefined || !/^\.\/contracts(\/|$)/.test(source)) {
          offending.push(`${name}: ${token} from ${source ?? '(not imported)'}`);
        }
      }
    }
    expect(offending).toEqual([]);
    // Not vacuous: several modules export several tokens today.
    expect(exported).toBeGreaterThanOrEqual(8);
  });

  // forwardRef is how Nest papers over a circular module import. The graph
  // must stay acyclic at the Nest level too, not just file by file.
  it('never uses forwardRef', () => {
    const users = sourceFiles(SRC)
      .filter((path) => /\bforwardRef\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(users).toEqual([]);
  });
});
