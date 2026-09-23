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
});
