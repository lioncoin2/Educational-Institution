import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string; readonly severity: string };
}

interface CruiseOutput {
  readonly summary: {
    readonly violations: readonly Violation[];
    readonly totalCruised: number;
  };
  readonly modules: readonly {
    readonly source: string;
    readonly dependencies: readonly { readonly resolved: string }[];
  }[];
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
  const projectRoot = join(__dirname, '..', '..');
  let output: CruiseOutput;

  beforeAll(() => {
    const binary = join(projectRoot, 'node_modules', '.bin', 'depcruise');
    let stdout: string;
    try {
      stdout = execFileSync(
        binary,
        ['src', '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
        { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (error) {
      // depcruise exits non-zero when it finds violations; the report is still
      // on stdout and is exactly what we want to assert against.
      const execError = error as { stdout?: string };
      if (typeof execError.stdout !== 'string' || execError.stdout.length === 0) throw error;
      stdout = execError.stdout;
    }
    output = JSON.parse(stdout) as CruiseOutput;
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
});
