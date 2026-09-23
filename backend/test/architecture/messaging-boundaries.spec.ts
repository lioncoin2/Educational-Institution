import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * The shape of messaging, asserted — the properties the Messaging V1 brief
 * names, each as its own test so a failure says which one broke:
 *
 *   - the messaging domain depends on nothing outside itself and pure contracts;
 *   - messaging never touches LiveKit or the live module;
 *   - messaging never touches a storage implementation — only files' contract;
 *   - messaging never touches a notification or push provider;
 *   - no other module reads messaging's tables, or files' storage port.
 */
const PUSH_OR_STORAGE_SDKS =
  /^node_modules\/(livekit-server-sdk|@aws-sdk|aws-sdk|minio|@google-cloud|firebase-admin|apn|@parse\/node-apn|node-apn|web-push|node-pushnotifications|ws|socket\.io)\//;

const isMessaging = (source: string) => source.startsWith('src/modules/messaging/');
const isMessagingCode = (source: string) =>
  isMessaging(source) && source !== 'src/modules/messaging/messaging.module.ts';

describe('messaging boundaries', () => {
  let output: CruiseOutput;

  beforeAll(() => {
    output = cruise();
  }, 180_000);

  it('keeps the messaging domain pure: itself, pure contracts and the shared kernel only', () => {
    const reachable = [
      ...reachableFrom(output, (source) => source.startsWith('src/modules/messaging/domain/')),
    ];
    const outside = reachable.filter(
      (target) =>
        !target.startsWith('src/modules/messaging/domain/') &&
        !target.startsWith('src/modules/messaging/contracts/') &&
        target !== 'src/modules/files/contracts/file-kind.ts' &&
        !target.startsWith('src/shared/'),
    );
    expect(outside).toEqual([]);
    // Non-vacuous: the domain really was walked.
    expect(reachable).toContain('src/modules/messaging/domain/participant.ts');
  });

  it('never reaches LiveKit, the live module, or any realtime transport', () => {
    const reachable = [...reachableFrom(output, isMessagingCode)];
    expect(
      reachable.filter(
        (target) => target.startsWith('src/modules/live/') || PUSH_OR_STORAGE_SDKS.test(target),
      ),
    ).toEqual([]);
  });

  it('reaches files only through its contract — never a storage implementation', () => {
    const intrusions = edgesFrom(output, isMessagingCode)
      .filter(
        (edge) =>
          (edge.resolved.startsWith('src/modules/files/') &&
            !edge.resolved.startsWith('src/modules/files/contracts/')) ||
          // No filesystem, no object-store SDK: bytes are the files module's business.
          (edge.types.includes('core') && /^(node:)?fs(\/|$)/.test(edge.resolved)),
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
  });

  it('never imports notifications or a push provider — it publishes events', () => {
    const reachable = [...reachableFrom(output, isMessagingCode)];
    expect(reachable.filter((target) => target.startsWith('src/modules/notifications/'))).toEqual(
      [],
    );
  });

  it("keeps messaging's tables private to messaging", () => {
    const readers = edgesFrom(output, (source) => !isMessaging(source))
      .filter((edge) => edge.resolved.startsWith('src/modules/messaging/infrastructure/'))
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(readers).toEqual([]);
  });

  it("keeps files' tables and its raw storage port private to files", () => {
    const intrusions = edgesFrom(output, (source) => !source.startsWith('src/modules/files/'))
      .filter(
        (edge) =>
          edge.resolved === 'src/modules/files/infrastructure/schema.ts' ||
          edge.resolved === 'src/modules/files/domain/storage-provider.ts',
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
  });

  it('lets notifications know messaging only through its contracts', () => {
    const intrusions = edgesFrom(output, (source) =>
      source.startsWith('src/modules/notifications/'),
    )
      .filter(
        (edge) =>
          edge.resolved.startsWith('src/modules/messaging/') &&
          !edge.resolved.startsWith('src/modules/messaging/contracts/') &&
          edge.resolved !== 'src/modules/messaging/messaging.module.ts',
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
  });
});
