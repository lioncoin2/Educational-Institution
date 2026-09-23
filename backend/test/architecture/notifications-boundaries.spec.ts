import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * The shape of notifications, asserted — each property the Notifications V1
 * brief names as its own test, so a failure says which one broke:
 *
 *   - the modules whose facts become notifications (messaging, academic,
 *     assignments, live, identity, …) never import notifications: they
 *     publish events, and notifications subscribes;
 *   - notifications consumes those events and other modules' answers through
 *     their contracts only;
 *   - realtime delivers notifications through notifications' contracts and
 *     owns none of their persistence;
 *   - no push SDK (Firebase, APNs, web push) is reachable from notification
 *     logic; a push adapter can only ever live in notifications'
 *     infrastructure, and none is installed.
 */
const PUSH_SDKS =
  /^node_modules\/(@types\/)?(firebase|firebase-admin|@firebase\/[^/]+|apn|@parse\/node-apn|node-apn|web-push|node-pushnotifications)\//;
const VENDOR_OR_TRANSPORT =
  /^node_modules\/(@types\/)?(drizzle-orm|pg|ws|socket\.io|express|ioredis|livekit-server-sdk)\//;

const SRC = join(__dirname, '..', '..', 'src');

const inModule = (name: string) => (source: string) =>
  source.startsWith(`src/modules/${name}/`) && source !== `src/modules/${name}/${name}.module.ts`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('notifications boundaries', () => {
  let output: CruiseOutput;

  beforeAll(() => {
    output = cruise();
  }, 180_000);

  const reaching = (from: (source: string) => boolean, target: (path: string) => boolean) =>
    [...reachableFrom(output, from)].filter(target);

  // Derived, not listed: a module added later is checked without anyone
  // remembering to add it here. Realtime is the one module that delivers
  // notifications, through their contracts (asserted below).
  const PUBLISHERS = readdirSync(join(SRC, 'modules'))
    .filter((name) => statSync(join(SRC, 'modules', name)).isDirectory())
    .filter((name) => name !== 'notifications' && name !== 'realtime');

  it('checks every other module — the list below is complete', () => {
    expect(PUBLISHERS.length).toBeGreaterThanOrEqual(10);
    expect(PUBLISHERS).toEqual(
      expect.arrayContaining(['messaging', 'academic', 'live', 'identity']),
    );
  });

  it.each(PUBLISHERS)(
    'keeps %s free of notifications — it publishes events, notifications subscribes',
    (name) => {
      expect(
        reaching(inModule(name), (path) => path.startsWith('src/modules/notifications/')),
      ).toEqual([]);
    },
  );

  it('is imported only by the composition root, and by realtime through its contracts', () => {
    const importers = edgesFrom(
      output,
      (source) => !source.startsWith('src/modules/notifications/'),
    ).filter((edge) => edge.resolved.startsWith('src/modules/notifications/'));
    const unexpected = importers.filter(
      (edge) =>
        edge.source !== 'src/app.module.ts' &&
        !(
          edge.source === 'src/modules/realtime/realtime.module.ts' &&
          edge.resolved === 'src/modules/notifications/notifications.module.ts'
        ) &&
        !(
          edge.source.startsWith('src/modules/realtime/') &&
          edge.resolved.startsWith('src/modules/notifications/contracts/')
        ),
    );
    expect(unexpected.map((edge) => `${edge.source} -> ${edge.resolved}`)).toEqual([]);
  });

  it('knows messaging and identity only through their contracts', () => {
    const intrusions = edgesFrom(output, inModule('notifications'))
      .filter(
        (edge) =>
          /^src\/modules\/(?!notifications\/)[^/]+\//.test(edge.resolved) &&
          !/^src\/modules\/[^/]+\/contracts\//.test(edge.resolved) &&
          !/^src\/modules\/[^/]+\/[^/]+\.module\.ts$/.test(edge.resolved),
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
  });

  it('consumes messaging’s event contract — the translator really is subscribed to it', () => {
    const translatorEdges = edgesFrom(
      output,
      (source) =>
        source === 'src/modules/notifications/application/messaging-notification.translator.ts',
    ).map((edge) => edge.resolved);
    expect(
      translatorEdges.some((path) => path.startsWith('src/modules/messaging/contracts/')),
    ).toBe(true);
  });

  it('keeps the notification domain and application free of push SDKs and every other vendor', () => {
    const logic = (source: string) =>
      /^src\/modules\/notifications\/(domain|application|contracts)\//.test(source);
    expect(
      reaching(logic, (path) => PUSH_SDKS.test(path) || VENDOR_OR_TRANSPORT.test(path)),
    ).toEqual([]);
    // And the domain reaches no npm package at all.
    expect(
      reaching(
        (source) => source.startsWith('src/modules/notifications/domain/'),
        (path) => path.startsWith('node_modules/'),
      ),
    ).toEqual([]);
  });

  it('lets no module anywhere reach a push SDK — none is installed, and only the adapter may', () => {
    expect(
      edgesFrom(output, () => true)
        .filter((edge) => PUSH_SDKS.test(edge.resolved))
        .map((edge) => `${edge.source} -> ${edge.resolved}`),
    ).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(installed.filter((name) => PUSH_SDKS.test(`node_modules/${name}/`))).toEqual([]);
    // The rule that keeps it that way is part of the build.
    const rules = readFileSync(join(SRC, '..', '.dependency-cruiser.cjs'), 'utf8');
    expect(rules).toContain("name: 'push-sdks-only-in-the-notifications-adapter'");
  });

  it('keeps every push provider adapter in notifications’ infrastructure', () => {
    const adapters = sourceFiles(SRC)
      .filter((file) => /implements\s+PushProvider\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(join(SRC, '..'), file));
    expect(adapters.length).toBeGreaterThan(0);
    expect(
      adapters.filter((file) => !file.startsWith('src/modules/notifications/infrastructure/')),
    ).toEqual([]);
  });

  it('keeps notification persistence out of realtime — it stores nothing', () => {
    expect(
      reaching(
        inModule('realtime'),
        (path) =>
          /^node_modules\/(drizzle-orm|pg)\//.test(path) ||
          path.startsWith('src/platform/database/') ||
          path.startsWith('src/modules/notifications/infrastructure/'),
      ),
    ).toEqual([]);
  });

  it('lets only notifications’ own adapters touch its tables', () => {
    const importers = edgesFrom(
      output,
      (source) => !source.startsWith('src/modules/notifications/infrastructure/'),
    )
      .filter((edge) => edge.resolved === 'src/modules/notifications/infrastructure/schema.ts')
      .map((edge) => edge.source);
    expect(importers).toEqual([]);
  });
});
