import { readFileSync } from 'node:fs';
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
 *   - other modules reach live only through its contracts or its module file.
 */
const LIVEKIT = /^node_modules\/(@types\/)?(livekit-server-sdk|@livekit\/[^/]+)\//;
const VENDOR_OR_TRANSPORT =
  /^node_modules\/(@types\/)?(livekit-server-sdk|@livekit\/[^/]+|drizzle-orm|pg|ioredis|ws|socket\.io|express)\//;
const ADAPTER = 'src/modules/live/infrastructure/livekit-rtc-provider.ts';

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
      /^src\/modules\/live\/(domain|application|contracts|api)\//.test(source);
    expect(reaching(core, (path) => VENDOR_OR_TRANSPORT.test(path))).toEqual([]);
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

  it('keeps the rule that enforces this in the build', () => {
    const rules = readFileSync(join(__dirname, '..', '..', '.dependency-cruiser.cjs'), 'utf8');
    expect(rules).toContain("name: 'livekit-sdk-only-in-the-live-adapter'");
  });
});
