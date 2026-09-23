import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string; readonly severity: string };
}

export interface CruisedModule {
  readonly source: string;
  readonly dependencies: readonly {
    readonly resolved: string;
    readonly dependencyTypes: readonly string[];
  }[];
}

export interface CruiseOutput {
  readonly summary: { readonly violations: readonly Violation[]; readonly totalCruised: number };
  readonly modules: readonly CruisedModule[];
}

/**
 * The dependency graph exactly as CI's `npm run arch:graph` sees it — the
 * dependency-cruiser CLI (the package is ESM-only), with the project's rules.
 */
export function cruise(): CruiseOutput {
  const projectRoot = join(__dirname, '..', '..');
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
    // on stdout and is exactly what the assertions want.
    const execError = error as { stdout?: string };
    if (typeof execError.stdout !== 'string' || execError.stdout.length === 0) throw error;
    stdout = execError.stdout;
  }
  return JSON.parse(stdout) as CruiseOutput;
}

/** Every edge from a module matching `from`, as "source -> resolved". */
export function edgesFrom(
  output: CruiseOutput,
  from: (source: string) => boolean,
): { source: string; resolved: string; types: readonly string[] }[] {
  return output.modules
    .filter((module) => from(module.source))
    .flatMap((module) =>
      module.dependencies.map((dependency) => ({
        source: module.source,
        resolved: dependency.resolved,
        types: dependency.dependencyTypes,
      })),
    );
}

/**
 * Everything reachable from the modules matching `from`, following imports
 * transitively — but never through another module's `*.module.ts`, which is
 * composition (wiring), not use.
 */
export function reachableFrom(
  output: CruiseOutput,
  from: (source: string) => boolean,
): Set<string> {
  const bySource = new Map(output.modules.map((module) => [module.source, module]));
  const seen = new Set<string>();
  const queue = output.modules.filter((module) => from(module.source)).map((m) => m.source);
  while (queue.length > 0) {
    const source = queue.pop() as string;
    for (const dependency of bySource.get(source)?.dependencies ?? []) {
      const next = dependency.resolved;
      if (seen.has(next)) continue;
      seen.add(next);
      if (/^src\/modules\/[^/]+\/[^/]+\.module\.ts$/.test(next)) continue;
      queue.push(next);
    }
  }
  return seen;
}
