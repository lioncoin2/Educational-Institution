/**
 * The architecture index, generated from the source.
 *
 * This produces `docs/architecture/architecture-index.md`: one entry per backend
 * module (path, Nest composition surface, public `contracts/` surface, the domain
 * events it DECLARES in its contracts, and the other modules it STATICALLY
 * imports) and one per Flutter feature (path, controllers, and the lib areas and
 * sibling features it statically imports), plus the Flutter data seam (repository
 * contracts, routes, entry points) and every ADR.
 *
 * Two deliberate honesties, both required by the audit this implements:
 *
 *  - Every edge here is a STATIC IMPORT, never a runtime call. Modules collaborate
 *    at runtime mainly through the in-process event bus (docs/architecture/events.md);
 *    that graph is the declared events below, not the import graph.
 *  - Event names are read ONLY from each module's `contracts/events.ts` — the one
 *    place a subscriber may import them from. A module whose events are not (yet)
 *    in its contracts (identity's four are grandfathered) shows none here, on
 *    purpose: the index states what can be extracted reliably, nothing guessed.
 *
 * Mechanical facts only. Responsibility prose and "what it must not know" stay in
 * module-boundaries.md; this file links to them, it does not restate them.
 *
 * The backend graph is the dependency-cruiser graph CI already runs, read through
 * the same helper the boundary spec uses. The Flutter side has no cruiser, so this
 * mirrors the exact import-scan regex the app's own boundary tests use.
 *
 * Determinism is the contract: the same tree always renders the same bytes, so a
 * stale committed index fails `npm run arch:index:check` and the
 * `architecture-index` spec (and therefore `npm run verify` and CI). Regenerate
 * with `npm run arch:index`.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { cruise, type CruiseOutput } from '../support/dependency-graph';

const TOOLING_DIR = __dirname; // backend/test/tooling
const BACKEND_ROOT = join(TOOLING_DIR, '..', '..');
const REPO_ROOT = join(BACKEND_ROOT, '..');
const MODULES_DIR = join(BACKEND_ROOT, 'src', 'modules');
const APP_LIB = join(REPO_ROOT, 'app', 'lib');
const DECISIONS_DIR = join(REPO_ROOT, 'docs', 'architecture', 'decisions');

/** The committed index this generator writes and `--check` compares against. */
export const INDEX_PATH = join(REPO_ROOT, 'docs', 'architecture', 'architecture-index.md');

// --- small filesystem helpers (sorted, so the output is deterministic) --------

function subdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

function dartFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return dartFiles(path);
      return path.endsWith('.dart') ? [path] : [];
    })
    .sort();
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// --- backend extraction --------------------------------------------------------

/** The identifiers a `*.module.ts` lists in `exports:` — the module's Nest surface. */
function nestExports(moduleFile: string): string[] {
  if (!existsSync(moduleFile)) return [];
  const list = /exports:\s*\[([^\]]*)\]/.exec(read(moduleFile));
  if (!list) return [];
  return unique(
    list[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/** The names in one `{ a, type b, c as d }` clause, with `type ` and aliases stripped. */
function namesInClause(clause: string): string[] {
  return clause
    .split(',')
    .map((entry) =>
      entry
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim(),
    )
    .filter((name): name is string => Boolean(name));
}

/** Top-level `export const|function|class|interface|type|enum Name` in a leaf file. */
function declaredExports(fileText: string): string[] {
  const names: string[] = [];
  for (const match of fileText.matchAll(
    /^export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/gm,
  )) {
    names.push(match[1]);
  }
  for (const match of fileText.matchAll(/^export\s*\{([^}]*)\}\s*;?\s*$/gm)) {
    names.push(...namesInClause(match[1]));
  }
  return names;
}

/**
 * A module's public surface: the names its `contracts/index.ts` barrel exposes.
 * Named re-exports are read directly; `export * from './x'` is resolved by reading
 * the re-exported file's own top-level exports, so a barrel built from `export *`
 * (attendance) lists real names, not "*".
 */
function publicContract(contractsDir: string): string[] {
  const barrel = join(contractsDir, 'index.ts');
  if (!existsSync(barrel)) return [];
  const text = read(barrel);
  const names: string[] = [];
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'[^']+'/g)) {
    names.push(...namesInClause(match[1]));
  }
  for (const match of text.matchAll(/export\s*\*\s*from\s*'(\.[^']+)'/g)) {
    const target = join(contractsDir, `${match[1]}.ts`);
    if (existsSync(target)) names.push(...declaredExports(read(target)));
  }
  return unique(names);
}

/** The event-name string literals declared in a module's `contracts/events.ts`. */
function declaredEvents(contractsDir: string): string[] {
  const events = join(contractsDir, 'events.ts');
  if (!existsSync(events)) return [];
  const names: string[] = [];
  for (const match of read(events).matchAll(/'([a-z][a-z0-9]*(?:\.[a-z0-9_]+)+)'/g)) {
    names.push(match[1]);
  }
  return unique(names);
}

export interface BackendModule {
  readonly name: string;
  readonly path: string;
  readonly nestExports: readonly string[];
  readonly contract: readonly string[];
  readonly events: readonly string[];
  readonly importsModules: readonly string[];
}

/** For every module, the other modules any of its files resolves an import into. */
function crossModuleImports(output: CruiseOutput): Map<string, Set<string>> {
  const byModule = new Map<string, Set<string>>();
  for (const module of output.modules) {
    const fromModule = /^src\/modules\/([^/]+)\//.exec(module.source);
    if (!fromModule) continue;
    const targets = byModule.get(fromModule[1]) ?? new Set<string>();
    for (const dependency of module.dependencies) {
      const toModule = /^src\/modules\/([^/]+)\//.exec(dependency.resolved);
      if (toModule && toModule[1] !== fromModule[1]) targets.add(toModule[1]);
    }
    byModule.set(fromModule[1], targets);
  }
  return byModule;
}

function backendModules(output: CruiseOutput): BackendModule[] {
  const imports = crossModuleImports(output);
  return subdirectories(MODULES_DIR).map((name) => {
    const dir = join(MODULES_DIR, name);
    return {
      name,
      path: `backend/src/modules/${name}/`,
      nestExports: nestExports(join(dir, `${name}.module.ts`)),
      contract: publicContract(join(dir, 'contracts')),
      events: declaredEvents(join(dir, 'contracts')),
      importsModules: unique([...(imports.get(name) ?? [])]),
    };
  });
}

// --- flutter extraction (mirrors app/test/**/*_boundaries_test.dart) ----------

const IMPORT_RE = /^(?:import|export)\s+['"]([^'"]+)['"]/gm;

/** Every top-level import/export URI in a Dart file — the app's own scan regex. */
function dartImports(fileText: string): string[] {
  return [...fileText.matchAll(IMPORT_RE)].map((match) => match[1]);
}

/** Resolve a Dart import URI from a lib-relative file to a lib-relative target, or null if external. */
function resolveLibTarget(fromLibPath: string, uri: string): string | null {
  if (uri.startsWith('package:quran_institution_app/')) {
    return `lib/${uri.slice('package:quran_institution_app/'.length)}`;
  }
  if (uri.startsWith('package:') || uri.startsWith('dart:')) return null;
  const resolved = join(dirname(fromLibPath), uri).replace(/\\/g, '/');
  return resolved.startsWith('lib/') ? resolved : null;
}

export interface FlutterFeature {
  readonly name: string;
  readonly path: string;
  readonly controllers: readonly string[];
  readonly importsAreas: readonly string[];
  readonly importsFeatures: readonly string[];
}

function flutterFeatures(): FlutterFeature[] {
  const featuresDir = join(APP_LIB, 'features');
  return subdirectories(featuresDir).map((name) => {
    const dir = join(featuresDir, name);
    const stateDir = join(dir, 'state');
    const controllers = existsSync(stateDir)
      ? readdirSync(stateDir)
          .filter((entry) => entry.endsWith('_controller.dart'))
          .sort()
      : [];
    const areas = new Set<string>();
    const features = new Set<string>();
    for (const file of dartFiles(dir)) {
      const fromLib = `lib/${relative(APP_LIB, file).replace(/\\/g, '/')}`;
      for (const uri of dartImports(read(file))) {
        const target = resolveLibTarget(fromLib, uri);
        if (!target) continue;
        const segments = target.split('/'); // ['lib', area, ...]
        const area = segments[1];
        if (area === 'features') {
          if (segments[2] && segments[2] !== name) features.add(segments[2]);
        } else if (area) {
          areas.add(area);
        }
      }
    }
    return {
      name,
      path: `app/lib/features/${name}/`,
      controllers,
      importsAreas: [...areas].sort(),
      importsFeatures: [...features].sort(),
    };
  });
}

function repositoryContracts(): string[] {
  const file = join(APP_LIB, 'data', 'repositories', 'repositories.dart');
  if (!existsSync(file)) return [];
  return unique(
    [...read(file).matchAll(/abstract\s+interface\s+class\s+([A-Za-z0-9_]+)\s*\{/g)].map(
      (match) => match[1],
    ),
  );
}

export interface FlutterRoute {
  readonly name: string;
  readonly path: string;
}

function routes(): { constants: FlutterRoute[]; builders: string[] } {
  const file = join(APP_LIB, 'app', 'routes.dart');
  if (!existsSync(file)) return { constants: [], builders: [] };
  const text = read(file);
  const constants = [...text.matchAll(/static\s+const\s+String\s+([A-Za-z0-9_]+)\s*=\s*'([^']*)'/g)]
    .map((match) => ({ name: match[1], path: match[2] }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const builders = unique(
    [...text.matchAll(/static\s+String\s+([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]),
  );
  return { constants, builders };
}

function flutterEntryPoints(): string[] {
  return [
    'app/lib/main.dart',
    'app/lib/app/app.dart',
    'app/lib/app/router.dart',
    'app/lib/providers/app_providers.dart',
  ].filter((path) => existsSync(join(REPO_ROOT, path)));
}

// --- ADRs ----------------------------------------------------------------------

export interface Adr {
  readonly file: string;
  readonly title: string;
}

function adrs(): Adr[] {
  if (!existsSync(DECISIONS_DIR)) return [];
  return readdirSync(DECISIONS_DIR)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort()
    .map((file) => {
      const first = read(join(DECISIONS_DIR, file)).split('\n', 1)[0] ?? '';
      return { file, title: first.replace(/^#\s*/, '').trim() };
    });
}

// --- model + render ------------------------------------------------------------

export interface IndexModel {
  readonly modules: readonly BackendModule[];
  readonly features: readonly FlutterFeature[];
  readonly repositories: readonly string[];
  readonly routes: {
    readonly constants: readonly FlutterRoute[];
    readonly builders: readonly string[];
  };
  readonly entryPoints: readonly string[];
  readonly adrs: readonly Adr[];
}

/** Gather every mechanical fact, so a caller can assert on counts as well as render. */
export function buildModel(): IndexModel {
  const output = cruise();
  return {
    modules: backendModules(output),
    features: flutterFeatures(),
    repositories: repositoryContracts(),
    routes: routes(),
    entryPoints: flutterEntryPoints(),
    adrs: adrs(),
  };
}

function list(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(', ') : '—';
}

function render(model: IndexModel): string {
  const lines: string[] = [];
  lines.push('<!-- GENERATED — do not edit by hand.');
  lines.push('     Regenerate: cd backend && npm run arch:index');
  lines.push('     Freshness is enforced by backend/test/architecture/architecture-index.spec.ts');
  lines.push('     (npm run verify, and CI) and by `npm run arch:index:check`.');
  lines.push('     Every edge below is a STATIC IMPORT, never a runtime call — modules');
  lines.push('     collaborate at runtime through events (docs/architecture/events.md). -->');
  lines.push('');
  lines.push('# Architecture Index');
  lines.push('');
  lines.push('A generated, code-derived map of the repository, for finding the owner of a');
  lines.push('behaviour and its files before reading code. It is mechanical fact only;');
  lines.push('responsibility and what each module must not know live in');
  lines.push('[module-boundaries.md](module-boundaries.md), the enforced edges in');
  lines.push('[dependency-rules.md](dependency-rules.md).');
  lines.push('');
  lines.push('> **Edges are static imports, not runtime calls.** Cross-module collaboration');
  lines.push("> is mostly events over the in-process bus ([events.md](events.md)); a module's");
  lines.push('> declared events below are read from its `contracts/events.ts`. Every module');
  lines.push('> also depends on `shared` and `platform`; that is not repeated per row.');
  lines.push('');

  lines.push('## Backend modules (`backend/src/modules/`)');
  lines.push('');
  for (const module of model.modules) {
    lines.push(`### ${module.name}`);
    lines.push('');
    lines.push(`- **Path:** \`${module.path}\``);
    lines.push(
      `- **Nest module:** \`${module.name}.module.ts\` — exports: ${list(module.nestExports)}`,
    );
    lines.push(`- **Public contract (\`contracts/\`):** ${list(module.contract)}`);
    lines.push(`- **Declared domain events:** ${list(module.events)}`);
    lines.push(`- **Static imports → modules:** ${list(module.importsModules)}`);
    lines.push(
      `- **Docs:** [module-boundaries.md#${module.name}](module-boundaries.md#${module.name})`,
    );
    lines.push('');
  }

  lines.push('## Flutter features (`app/lib/features/`)');
  lines.push('');
  for (const feature of model.features) {
    lines.push(`### ${feature.name}`);
    lines.push('');
    lines.push(`- **Path:** \`${feature.path}\``);
    lines.push(`- **Controllers:** ${list(feature.controllers)}`);
    lines.push(`- **Static imports → areas:** ${list(feature.importsAreas)}`);
    lines.push(`- **Static imports → features:** ${list(feature.importsFeatures)}`);
    lines.push('');
  }

  lines.push('## Flutter data seam (`app/lib/data/`, `app/lib/app/`)');
  lines.push('');
  lines.push(
    `- **Repository contracts (\`data/repositories/repositories.dart\`):** ${list(model.repositories)}`,
  );
  lines.push(
    `- **Routes (\`app/routes.dart\`):** ${
      model.routes.constants.length > 0
        ? model.routes.constants.map((route) => `\`${route.name}\` → \`${route.path}\``).join(', ')
        : '—'
    }`,
  );
  lines.push(`- **Route builders:** ${list(model.routes.builders)}`);
  lines.push(`- **Entry points:** ${list(model.entryPoints)}`);
  lines.push('');

  lines.push('## Architecture Decision Records (`docs/architecture/decisions/`)');
  lines.push('');
  for (const adr of model.adrs) {
    lines.push(`- [${adr.title}](decisions/${adr.file})`);
  }
  lines.push('');

  return `${lines.join('\n')}`;
}

/** The index for the current tree. Deterministic: same tree → same bytes. */
export function generateIndex(): string {
  return render(buildModel());
}

/** The comparison `--check` and the spec use; stated so a test can prove it can fail. */
export function isFresh(committed: string, generated: string): boolean {
  return committed === generated;
}

if (require.main === module) {
  // The target defaults to the committed index; ARCH_INDEX_PATH overrides it so
  // `--check` can be exercised against a throwaway fixture without touching the
  // real file.
  const target = process.env.ARCH_INDEX_PATH ?? INDEX_PATH;
  const generated = generateIndex();
  if (process.argv.includes('--write')) {
    writeFileSync(target, generated);
    process.stdout.write(`architecture index written: ${relative(REPO_ROOT, target)}\n`);
  } else {
    const committed = existsSync(target) ? read(target) : '';
    if (isFresh(committed, generated)) {
      process.stdout.write('architecture index is up to date\n');
    } else {
      process.stderr.write('architecture index is STALE — regenerate with `npm run arch:index`\n');
      process.exit(1);
    }
  }
}
