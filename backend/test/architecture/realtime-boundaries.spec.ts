import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * Realtime is an extension of messaging, never a part of it. The properties
 * the Realtime Messaging V1 brief names, each asserted on its own:
 *
 *   - messaging (domain, application, contracts, api, adapters) reaches no
 *     WebSocket library and nothing of the realtime module;
 *   - identity and notifications reach neither either;
 *   - realtime knows notifications only through its contracts (the events
 *     and the reader it renders a notification with) — never its storage,
 *     its tables or its use cases; realtime owns no notification state;
 *   - inside realtime, only the infrastructure adapter knows a socket library;
 *   - realtime knows messaging and identity through their contracts only;
 *   - nothing but the composition root imports realtime.
 */
const SOCKET_LIBRARIES =
  /^node_modules\/(@types\/)?(ws|socket\.io|socket\.io-client|engine\.io|@nestjs\/websockets|@nestjs\/platform-ws|@nestjs\/platform-socket\.io)\//;

const MODULES_DIR = join(__dirname, '..', '..', 'src', 'modules');

/** Every module but realtime itself, read from the source tree. */
const OTHER_MODULES = readdirSync(MODULES_DIR)
  .filter((name) => statSync(join(MODULES_DIR, name)).isDirectory())
  .filter((name) => name !== 'realtime');

const inModule = (name: string) => (source: string) =>
  source.startsWith(`src/modules/${name}/`) && source !== `src/modules/${name}/${name}.module.ts`;

describe('realtime boundaries', () => {
  let output: CruiseOutput;

  beforeAll(() => {
    output = cruise();
  }, 180_000);

  const reaching = (from: (source: string) => boolean, target: (path: string) => boolean) =>
    [...reachableFrom(output, from)].filter(target);

  it('finds the realtime adapter, and the socket library in it — this suite is not vacuous', () => {
    const adapterEdges = edgesFrom(output, (source) =>
      source.startsWith('src/modules/realtime/infrastructure/'),
    ).map((edge) => edge.resolved);
    expect(adapterEdges.some((path) => SOCKET_LIBRARIES.test(path))).toBe(true);
  });

  it('checks every other module — the list below is derived, not remembered', () => {
    expect(OTHER_MODULES.length).toBeGreaterThanOrEqual(11);
    expect(OTHER_MODULES).toEqual(
      expect.arrayContaining(['messaging', 'identity', 'notifications', 'live', 'academic']),
    );
  });

  it.each(OTHER_MODULES)(
    'keeps %s free of any WebSocket library and of the realtime module',
    (name) => {
      expect(
        reaching(
          inModule(name),
          (path) => SOCKET_LIBRARIES.test(path) || path.startsWith('src/modules/realtime/'),
        ),
      ).toEqual([]);
    },
  );

  it('keeps the messaging domain and application free of any transport at all', () => {
    const core = (source: string) =>
      /^src\/modules\/messaging\/(domain|application|contracts)\//.test(source);
    expect(
      reaching(
        core,
        (path) => SOCKET_LIBRARIES.test(path) || /^(node:)?(http|https|net)$/.test(path),
      ),
    ).toEqual([]);
  });

  it('lets realtime know notifications only through its contracts', () => {
    const intrusions = edgesFrom(output, inModule('realtime'))
      .filter(
        (edge) =>
          edge.resolved.startsWith('src/modules/notifications/') &&
          !edge.resolved.startsWith('src/modules/notifications/contracts/'),
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
    // …and through them, nothing of notifications' persistence or logic.
    expect(
      reaching(inModule('realtime'), (path) =>
        /^src\/modules\/notifications\/(domain|application|infrastructure|api)\//.test(path),
      ),
    ).toEqual([]);
  });

  it('finds realtime using the notifications contract — the check above is not vacuous', () => {
    expect(
      edgesFrom(output, inModule('realtime')).some((edge) =>
        edge.resolved.startsWith('src/modules/notifications/contracts/'),
      ),
    ).toBe(true);
  });

  it('lets only the realtime adapter know a socket library', () => {
    const outsideTheAdapter = (source: string) =>
      source.startsWith('src/modules/realtime/') &&
      !source.startsWith('src/modules/realtime/infrastructure/');
    expect(
      edgesFrom(output, outsideTheAdapter)
        .filter((edge) => SOCKET_LIBRARIES.test(edge.resolved))
        .map((edge) => `${edge.source} -> ${edge.resolved}`),
    ).toEqual([]);
    expect(
      reaching(
        (source) => /^src\/modules\/realtime\/(domain|application)\//.test(source),
        (path) =>
          SOCKET_LIBRARIES.test(path) || path.startsWith('src/modules/realtime/infrastructure/'),
      ),
    ).toEqual([]);
  });

  it('lets realtime know messaging and identity only through their contracts', () => {
    const intrusions = edgesFrom(output, inModule('realtime'))
      .filter(
        (edge) =>
          /^src\/modules\/(messaging|identity)\//.test(edge.resolved) &&
          !/^src\/modules\/(messaging|identity)\/contracts\//.test(edge.resolved) &&
          !/^src\/modules\/(messaging|identity)\/[^/]+\.module\.ts$/.test(edge.resolved),
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
  });

  it('is imported by the composition root only', () => {
    const importers = edgesFrom(output, (source) => !source.startsWith('src/modules/realtime/'))
      .filter((edge) => edge.resolved.startsWith('src/modules/realtime/'))
      .map((edge) => edge.source);
    expect([...new Set(importers)]).toEqual(['src/app.module.ts']);
  });
});
