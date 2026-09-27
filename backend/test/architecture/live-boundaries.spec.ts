import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * Live is the only module that talks to the media provider, and only through
 * one adapter. The properties, each asserted on its own:
 *
 *   - exactly one file imports a LiveKit package: the adapter in
 *     `live/infrastructure/` — and it really does (this suite is not vacuous);
 *   - no other module, and no domain, application, api or contracts file of
 *     live itself, reaches LiveKit, even transitively;
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
 *   - live exports exactly its two contract tokens, LIVE_AUDIENCE and
 *     LIVE_SESSIONS (live.md §13);
 *   - live's tables are touched only by live's own adapters, and live reads
 *     no other module's tables.
 */
const LIVEKIT = /^node_modules\/(@types\/)?(livekit-server-sdk|@livekit\/[^/]+)\//;
const VENDOR_OR_TRANSPORT =
  /^node_modules\/(@types\/)?(livekit-server-sdk|@livekit\/[^/]+|drizzle-orm|pg|ioredis|ws|socket\.io|express)\//;
const ADAPTER = 'src/modules/live/infrastructure/livekit-rtc-provider.ts';

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

  it('lets exactly one file import a LiveKit package', () => {
    const importers = edgesFrom(output, () => true)
      .filter((edge) => LIVEKIT.test(edge.resolved))
      .map((edge) => edge.source);
    expect([...new Set(importers)]).toEqual([ADAPTER]);
  });

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

  it('exports exactly LIVE_AUDIENCE and LIVE_SESSIONS, each from its own contract', () => {
    const text = readFileSync(join(MODULES_DIR, 'live', 'live.module.ts'), 'utf8');
    const exported = /exports:\s*\[([^\]]*)\]/.exec(text);
    expect(exported).not.toBeNull();
    const tokens = exported![1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .sort();
    expect(tokens).toEqual(['LIVE_AUDIENCE', 'LIVE_SESSIONS']);
    expect(text).toContain("import { LIVE_AUDIENCE } from './contracts/live-audience';");
    expect(text).toContain("import { LIVE_SESSIONS } from './contracts/live-sessions';");
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

  it('keeps the rule that enforces this in the build', () => {
    const rules = readFileSync(join(__dirname, '..', '..', '.dependency-cruiser.cjs'), 'utf8');
    expect(rules).toContain("name: 'livekit-sdk-only-in-the-live-adapter'");
  });
});
