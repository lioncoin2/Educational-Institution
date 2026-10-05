import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * Live is the only module that talks to the media provider, and only through
 * one adapter. The properties, each asserted on its own:
 *
 *   - only the LiveKit adapter's files import a LiveKit package — the
 *     adapter, its readiness probe and its transport rules,
 *     `live/infrastructure/livekit-*.ts` — and the adapter really does (this
 *     suite is not vacuous); with their specs, which the cruise leaves out,
 *     they are the only source files that name one at all;
 *   - no other module, and no domain, application, api or contracts file of
 *     live itself, reaches LiveKit, even transitively — nor Communities, the
 *     shared kernel or platform;
 *   - live's domain and application reach no vendor SDK or transport at all;
 *   - live's contracts carry only the shared kernel: another module importing
 *     them (to type an event) pulls in nothing of live's internals;
 *   - other modules reach live only through its contracts or its module file;
 *   - live reaches Communities only through Communities' contracts, and wires
 *     it through its module file — never its domain, store or use cases;
 *   - live reaches no module it must not know (messaging, realtime,
 *     notifications, academic, operations, attendance — those that exist),
 *     not even through their module files; its module file wires identity
 *     and Communities and nothing else;
 *   - live exports exactly its contract tokens — LIVE_AUDIENCE, LIVE_SESSIONS
 *     and LIVE_PRESENCE (live.md §13);
 *   - live/contracts/presence.ts, the principal-less presence contract, is
 *     imported only by attendance and the app wiring (§5.1);
 *   - live's tables are touched only by live's own adapters, and live reads
 *     no other module's tables.
 */
const LIVEKIT = /^node_modules\/(@types\/)?(livekit-server-sdk|@livekit\/[^/]+)\//;
const VENDOR_OR_TRANSPORT =
  /^node_modules\/(@types\/)?(livekit-server-sdk|@livekit\/[^/]+|drizzle-orm|pg|ioredis|ws|socket\.io|express)\//;
const ADAPTER = 'src/modules/live/infrastructure/livekit-rtc-provider.ts';
/** The adapter's files: the adapter, its readiness probe and its transport rules. */
const ADAPTER_FILES = [
  ADAPTER,
  'src/modules/live/infrastructure/livekit-readiness.ts',
  'src/modules/live/infrastructure/livekit-transport.ts',
];

/** The adapter's files, by name: the only ones the build lets import LiveKit. */
const ADAPTER_FILE = /^src\/modules\/live\/infrastructure\/livekit-[^/]+\.ts$/;
/** An import of a LiveKit package, as source text writes it. */
const NAMES_LIVEKIT =
  /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)['"](?:livekit-server-sdk|@livekit\/[^'"]+)['"]/;

/** Where LiveKit must never be reached from, even transitively. */
const NEVER_LIVEKIT: ReadonlyArray<readonly [string, string]> = [
  ['live’s domain', 'src/modules/live/domain/'],
  ['live’s application layer', 'src/modules/live/application/'],
  ['live’s contracts', 'src/modules/live/contracts/'],
  ['live’s api layer', 'src/modules/live/api/'],
  ['Communities', 'src/modules/communities/'],
  ['the shared kernel', 'src/shared/'],
  ['platform', 'src/platform/'],
];

const ROOT = join(__dirname, '..', '..');

/** Every TypeScript file under `dir` (relative to the backend), specs included. */
function typescriptFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

const LIVE = 'src/modules/live/';
const MODULE_FILE = 'src/modules/live/live.module.ts';
const SCHEMA = 'src/modules/live/infrastructure/schema.ts';
const MODULES_DIR = join(__dirname, '..', '..', 'src', 'modules');

/** The modules live must never reach (the hub's §7 table), of those that exist in the tree. */
const NEVER_REACHED = [
  'messaging',
  'realtime',
  'notifications',
  'academic',
  'operations',
  'attendance',
].filter((name) => {
  try {
    return statSync(join(MODULES_DIR, name)).isDirectory();
  } catch {
    return false;
  }
});

const fromLive = (source: string) => source.startsWith(LIVE);

describe('live boundaries', () => {
  let output: CruiseOutput;

  beforeAll(() => {
    output = cruise();
  }, 180_000);

  const reaching = (from: (source: string) => boolean, target: (path: string) => boolean) =>
    [...reachableFrom(output, from)].filter(target);

  it('finds the LiveKit adapter importing the SDK — the checks below are not vacuous', () => {
    const edges = edgesFrom(output, (source) => source === ADAPTER).map((edge) => edge.resolved);
    expect(edges.some((path) => LIVEKIT.test(path))).toBe(true);
  });

  it('lets only the LiveKit adapter’s files import a LiveKit package', () => {
    const importers = edgesFrom(output, () => true)
      .filter((edge) => LIVEKIT.test(edge.resolved))
      .map((edge) => edge.source);
    expect([...new Set(importers)].sort()).toEqual([...ADAPTER_FILES].sort());
  });

  it('finds no source file naming a LiveKit package outside live/infrastructure/livekit-*.ts — specs included', () => {
    const naming = typescriptFiles('src').filter((file) =>
      NAMES_LIVEKIT.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    // Not vacuous: the adapter's files, and the specs beside them, do.
    expect(naming).toEqual(expect.arrayContaining(ADAPTER_FILES));
    expect(naming.filter((file) => !ADAPTER_FILE.test(file))).toEqual([]);
  });

  it.each(NEVER_LIVEKIT)(
    'never lets %s reach a LiveKit package, even transitively',
    (_area, dir) => {
      const inside = (source: string) => source.startsWith(dir);
      expect(output.modules.some((module) => inside(module.source))).toBe(true);
      expect(reaching(inside, (path) => LIVEKIT.test(path))).toEqual([]);
    },
  );

  it('keeps every live layer but infrastructure free of LiveKit and every other vendor', () => {
    const core = (source: string) =>
      /^src\/modules\/live\/(domain|application|contracts)\//.test(source);
    expect(reaching(core, (path) => VENDOR_OR_TRANSPORT.test(path))).toEqual([]);
    // The api layer is the HTTP edge, so it may know the HTTP framework — and
    // nothing else: no media SDK, no database, no socket library.
    const api = (source: string) => source.startsWith('src/modules/live/api/');
    expect(
      reaching(
        api,
        (path) =>
          VENDOR_OR_TRANSPORT.test(path) && !/^node_modules\/(@types\/)?express\//.test(path),
      ),
    ).toEqual([]);
    // …and the domain reaches no npm package at all.
    expect(
      reaching(
        (source) => source.startsWith('src/modules/live/domain/'),
        (path) => path.startsWith('node_modules/'),
      ),
    ).toEqual([]);
  });

  it('keeps live’s contracts to the shared kernel', () => {
    const contracts = (source: string) => source.startsWith('src/modules/live/contracts/');
    const reached = reaching(contracts, () => true);
    expect(reached.filter((path) => !path.startsWith('src/shared/') && !contracts(path))).toEqual(
      [],
    );
    // Not vacuous: the contracts exist and are part of the graph.
    expect(output.modules.some((module) => contracts(module.source))).toBe(true);
  });

  it('is reached by other modules only through its contracts or its module file', () => {
    const intrusions = edgesFrom(output, (source) => !source.startsWith('src/modules/live/'))
      .filter(
        (edge) =>
          edge.resolved.startsWith('src/modules/live/') &&
          !edge.resolved.startsWith('src/modules/live/contracts/') &&
          edge.resolved !== 'src/modules/live/live.module.ts',
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
  });

  it('knows Communities only through its contracts, and wires it through its module file', () => {
    const intrusions = edgesFrom(output, fromLive)
      .filter((edge) => edge.resolved.startsWith('src/modules/communities/'))
      .filter(
        (edge) =>
          !edge.resolved.startsWith('src/modules/communities/contracts/') &&
          !(
            edge.source === MODULE_FILE &&
            edge.resolved === 'src/modules/communities/communities.module.ts'
          ),
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
    // …and through them, nothing of Communities' storage or logic.
    expect(
      reaching(fromLive, (path) =>
        /^src\/modules\/communities\/(domain|application|infrastructure|api)\//.test(path),
      ),
    ).toEqual([]);
  });

  it('finds live asking Communities through its contracts, and wiring its module — the check above is not vacuous', () => {
    const toCommunities = edgesFrom(output, fromLive).map((edge) => edge.resolved);
    expect(toCommunities).toEqual(
      expect.arrayContaining([
        'src/modules/communities/contracts/authorization.ts',
        'src/modules/communities/contracts/capability-holders.ts',
        'src/modules/communities/communities.module.ts',
      ]),
    );
  });

  it('checks the modules live must never reach — the list is derived from the tree', () => {
    // Attendance does not exist yet (P9, held); every other name must, so a
    // renamed or removed module cannot quietly shrink the checks below.
    expect(NEVER_REACHED).toEqual(
      expect.arrayContaining(['messaging', 'realtime', 'notifications', 'academic', 'operations']),
    );
    const sources = output.modules.map((module) => module.source);
    for (const name of NEVER_REACHED) {
      expect(sources).toContain(`src/modules/${name}/${name}.module.ts`);
    }
  });

  it.each(NEVER_REACHED)('never reaches %s — not its contracts, not its module file', (name) => {
    const target = (path: string) => path.startsWith(`src/modules/${name}/`);
    expect(
      edgesFrom(output, fromLive)
        .filter((edge) => target(edge.resolved))
        .map((edge) => `${edge.source} -> ${edge.resolved}`),
    ).toEqual([]);
    expect(reaching(fromLive, target)).toEqual([]);
  });

  it('wires identity and Communities in its module file, and no other module', () => {
    const wiring = edgesFrom(output, (source) => source === MODULE_FILE)
      .map((edge) => edge.resolved)
      .filter((path) => /^src\/modules\/[^/]+\/[^/]+\.module\.ts$/.test(path))
      .filter((path) => !path.startsWith(LIVE))
      .sort();
    expect(wiring).toEqual([
      'src/modules/communities/communities.module.ts',
      'src/modules/identity/identity.module.ts',
    ]);
  });

  it('exports exactly LIVE_AUDIENCE, LIVE_PRESENCE and LIVE_SESSIONS, each from its own contract', () => {
    const text = readFileSync(join(MODULES_DIR, 'live', 'live.module.ts'), 'utf8');
    const exported = /exports:\s*\[([^\]]*)\]/.exec(text);
    expect(exported).not.toBeNull();
    const tokens = exported![1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .sort();
    expect(tokens).toEqual(['LIVE_AUDIENCE', 'LIVE_PRESENCE', 'LIVE_SESSIONS']);
    expect(text).toContain("import { LIVE_AUDIENCE } from './contracts/live-audience';");
    expect(text).toContain("import { LIVE_PRESENCE } from './contracts/presence';");
    expect(text).toContain("import { LIVE_SESSIONS } from './contracts/live-sessions';");
  });

  it('keeps presence.ts to attendance and the app wiring — the principal-less presence contract', () => {
    const PRESENCE = 'src/modules/live/contracts/presence.ts';
    const importers = edgesFrom(output, () => true)
      .filter((edge) => edge.resolved === PRESENCE)
      .map((edge) => edge.source);
    // Only Live's own files, attendance, and the app composition root may import it (§5.1).
    const outside = importers.filter(
      (source) =>
        !source.startsWith('src/modules/live/') &&
        !source.startsWith('src/modules/attendance/') &&
        source !== 'src/app.module.ts',
    );
    expect(outside).toEqual([]);
    // Not vacuous: Live's own presence service implements the contract.
    expect(importers).toContain('src/modules/live/application/live-presence.service.ts');
  });

  it('keeps its tables to its own adapters, and reads no other module’s tables', () => {
    const importers = edgesFrom(output, (source) => source !== SCHEMA)
      .filter((edge) => edge.resolved === SCHEMA)
      .map((edge) => edge.source);
    expect(importers.filter((source) => !source.startsWith(`${LIVE}infrastructure/`))).toEqual([]);
    // Not vacuous: Live's Drizzle adapter does use its schema.
    expect(importers).toContain('src/modules/live/infrastructure/drizzle-live-repositories.ts');
    const otherSchemas = output.modules
      .map((module) => module.source)
      .filter((source) => /^src\/modules\/[^/]+\/infrastructure\/schema\.ts$/.test(source))
      .filter((source) => source !== SCHEMA);
    expect(otherSchemas.length).toBeGreaterThanOrEqual(4);
    expect(reaching(fromLive, (path) => otherSchemas.includes(path))).toEqual([]);
  });

  it('keeps the rule that enforces this in the build — exempting the adapter’s files alone', () => {
    const { forbidden } = createRequire(__filename)(join(ROOT, '.dependency-cruiser.cjs')) as {
      forbidden: ReadonlyArray<{ name: string; from: { pathNot?: string } }>;
    };
    const rule = forbidden.find(
      (candidate) => candidate.name === 'livekit-sdk-only-in-the-live-adapter',
    );
    const exempt = (source: string) => new RegExp(rule?.from.pathNot ?? '(?!)').test(source);
    expect(ADAPTER_FILES.filter((file) => !exempt(file))).toEqual([]);
    // Nothing else in the adapters' directory is, nor the module's wiring.
    expect(
      [
        'src/modules/live/infrastructure/fake-rtc-provider.ts',
        'src/modules/live/infrastructure/disabled-rtc-provider.ts',
        'src/modules/live/infrastructure/drizzle-live-repositories.ts',
        'src/modules/live/live.module.ts',
      ].filter(exempt),
    ).toEqual([]);
  });
});
