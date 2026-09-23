import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * The shape of Communities, asserted (communities.md §17) — each property as
 * its own test, so a failure says which one broke:
 *
 *   - Communities knows identity only through identity's contracts, and no
 *     other business module at all — not messaging, live, attendance,
 *     academic, realtime, notifications or files; its module file wires
 *     identity in and nothing else;
 *   - no other module reaches Communities' internals: its contracts (and the
 *     module file, for the composition root) are the way in;
 *   - Communities never reads another module's tables, and only its own
 *     adapters touch its tables;
 *   - the domain reaches only itself, its contracts, identity's permission
 *     catalogue and the shared kernel;
 *   - neither domain nor application reaches Drizzle, pg, a socket library,
 *     Express, Redis, Firebase, LiveKit or node:crypto;
 *   - the contracts reach only the shared kernel and identity's permission
 *     catalogue — never identity's barrel, which re-exports route decorators.
 */
const VENDOR_OR_TRANSPORT =
  /^node_modules\/(@types\/)?(drizzle-orm|pg|pg-[^/]+|ws|socket\.io|express|ioredis|firebase|firebase-admin|@firebase\/[^/]+|livekit-server-sdk|@livekit\/[^/]+)\//;

const COMMUNITIES = 'src/modules/communities/';
const MODULE_FILE = 'src/modules/communities/communities.module.ts';
const SCHEMA = 'src/modules/communities/infrastructure/schema.ts';
const PERMISSIONS = 'src/modules/identity/contracts/permissions.ts';
const isCommunitiesCode = (source: string) =>
  source.startsWith(COMMUNITIES) && source !== MODULE_FILE;

describe('communities boundaries', () => {
  let output: CruiseOutput;

  beforeAll(() => {
    output = cruise();
  }, 180_000);

  const reaching = (from: (source: string) => boolean, target: (path: string) => boolean) =>
    [...reachableFrom(output, from)].filter(target);

  const otherSchemas = () =>
    output.modules
      .map((module) => module.source)
      .filter((source) => /^src\/modules\/[^/]+\/infrastructure\/schema\.ts$/.test(source))
      .filter((source) => source !== SCHEMA);

  it('was analysed — its layers are all in the graph', () => {
    const sources = output.modules.map((module) => module.source);
    for (const file of [
      'src/modules/communities/domain/authority.ts',
      'src/modules/communities/domain/lifecycle.ts',
      'src/modules/communities/application/community-authorization.service.ts',
      'src/modules/communities/application/invitation.use-cases.ts',
      'src/modules/communities/infrastructure/drizzle-community-repository.ts',
      'src/modules/communities/infrastructure/in-memory-community-store.ts',
      'src/modules/communities/api/communities.controller.ts',
      'src/modules/communities/contracts/authorization.ts',
      SCHEMA,
      MODULE_FILE,
    ]) {
      expect(sources).toContain(file);
    }
    // Non-vacuous: there are other modules' schemas to stay away from.
    expect(otherSchemas().length).toBeGreaterThanOrEqual(4);
  });

  it('knows identity only through its contracts, and no other module at all', () => {
    const intrusions = edgesFrom(output, isCommunitiesCode)
      .filter((edge) => edge.resolved.startsWith('src/modules/'))
      .filter((edge) => !edge.resolved.startsWith(COMMUNITIES))
      .filter((edge) => !edge.resolved.startsWith('src/modules/identity/contracts/'))
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
    // `reachableFrom` skips module files, so the wiring is checked edge by edge.
    const wiring = edgesFrom(output, (source) => source === MODULE_FILE)
      .map((edge) => edge.resolved)
      .filter((path) => path.startsWith('src/modules/') && !path.startsWith(COMMUNITIES));
    expect(wiring).toEqual(['src/modules/identity/identity.module.ts']);
  });

  it('is reached by other modules only through its contracts', () => {
    const intrusions = edgesFrom(output, (source) => !source.startsWith(COMMUNITIES))
      .filter((edge) => edge.resolved.startsWith(COMMUNITIES))
      .filter(
        (edge) =>
          !edge.resolved.startsWith('src/modules/communities/contracts/') &&
          edge.resolved !== MODULE_FILE,
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`)
      // Composition roots assemble the application; they are not modules.
      .filter((edge) => !/^src\/(app\.module|main|cli\/)/.test(edge));
    expect(intrusions).toEqual([]);
  });

  it('never reads another module’s tables', () => {
    const others = otherSchemas();
    expect(reaching(isCommunitiesCode, (path) => others.includes(path))).toEqual([]);
    // Non-vacuous: Communities' own adapters do reach a schema — their own.
    expect(reaching(isCommunitiesCode, (path) => path === SCHEMA)).toEqual([SCHEMA]);
  });

  it('lets only its own adapters touch its tables', () => {
    const importers = edgesFrom(
      output,
      (source) => !source.startsWith('src/modules/communities/infrastructure/'),
    )
      .filter((edge) => edge.resolved === SCHEMA)
      .map((edge) => edge.source);
    expect(importers).toEqual([]);
  });

  it('keeps the domain pure: itself, its contracts, the permission catalogue and the kernel', () => {
    const reachable = [
      ...reachableFrom(output, (source) => source.startsWith(`${COMMUNITIES}domain/`)),
    ];
    const outside = reachable.filter(
      (target) =>
        !target.startsWith(`${COMMUNITIES}domain/`) &&
        !target.startsWith(`${COMMUNITIES}contracts/`) &&
        target !== PERMISSIONS &&
        !target.startsWith('src/shared/'),
    );
    expect(outside).toEqual([]);
    expect(reachable.filter((target) => target.startsWith('node_modules/'))).toEqual([]);
    expect(reachable).toContain(`${COMMUNITIES}domain/act-rules.ts`);
    expect(reachable).toContain(PERMISSIONS);
  });

  it('keeps the domain and application free of Drizzle, pg, sockets, HTTP, LiveKit and node:crypto', () => {
    const logic = (source: string) =>
      /^src\/modules\/communities\/(domain|application)\//.test(source);
    expect(reaching(logic, (path) => VENDOR_OR_TRANSPORT.test(path))).toEqual([]);
    expect(
      reaching(
        logic,
        (path) =>
          path === 'crypto' ||
          path === 'node:crypto' ||
          path.startsWith(`${COMMUNITIES}api/`) ||
          path.startsWith(`${COMMUNITIES}infrastructure/`) ||
          path.startsWith('src/platform/database/') ||
          path.startsWith('src/platform/http/'),
      ),
    ).toEqual([]);
    // Non-vacuous: the infrastructure does use node:crypto, for the token.
    expect(
      edgesFrom(output, (source) => source.startsWith(`${COMMUNITIES}infrastructure/`)).some(
        (edge) => /(^|\/)crypto$/.test(edge.resolved) || edge.resolved === 'node:crypto',
      ),
    ).toBe(true);
  });

  it('publishes a self-contained contract — the kernel and the permission catalogue only', () => {
    const contract = [
      ...reachableFrom(output, (source) => source.startsWith(`${COMMUNITIES}contracts/`)),
    ];
    expect(
      contract.filter(
        (path) =>
          !path.startsWith(`${COMMUNITIES}contracts/`) &&
          !path.startsWith('src/shared/') &&
          path !== PERMISSIONS,
      ),
    ).toEqual([]);
    expect(contract).toContain('src/shared/domain-event.ts');
    // Never identity's barrel, which re-exports route decorators.
    expect(contract).not.toContain('src/modules/identity/contracts/index.ts');
  });
});
