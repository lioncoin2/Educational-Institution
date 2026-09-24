import { MODULE_METADATA } from '@nestjs/common/constants';

import { CommunitiesModule } from '../../src/modules/communities/communities.module';
import { MESSAGE_DELIVERY } from '../../src/modules/messaging/contracts/message-delivery';
import { MESSAGE_RECIPIENTS } from '../../src/modules/messaging/contracts/message-recipients';
import { MessagingModule } from '../../src/modules/messaging/messaging.module';
import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * The shape of messaging, asserted — the properties the Messaging V1 brief
 * names, each as its own test so a failure says which one broke:
 *
 *   - the messaging domain depends on nothing outside itself and pure contracts;
 *   - messaging never touches LiveKit or the live module;
 *   - messaging never touches a storage implementation — only files' contract;
 *   - messaging never touches a notification or push provider;
 *   - no other module reads messaging's tables, or files' storage port;
 *   - community chats (P4): messaging reaches Communities only through its
 *     public contracts, from the application layer, and the module file for
 *     wiring; Communities never reaches messaging at all; no table and no
 *     repository crosses either way; and MessagingModule still exports only
 *     its two delivery contracts — no way to write a conversation's members.
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

  it('reaches Communities only through its contracts, from the application layer — and the module file for wiring', () => {
    const edges = edgesFrom(output, isMessaging).filter((edge) =>
      edge.resolved.startsWith('src/modules/communities/'),
    );
    // Non-vacuous: messaging does depend on Communities now.
    expect(edges.length).toBeGreaterThan(0);
    const intrusions = edges
      .filter(
        (edge) =>
          !(
            (edge.resolved.startsWith('src/modules/communities/contracts/') &&
              edge.source.startsWith('src/modules/messaging/application/')) ||
            (edge.resolved === 'src/modules/communities/communities.module.ts' &&
              edge.source === 'src/modules/messaging/messaging.module.ts')
          ),
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
    // Never Communities' tables, repositories or read models, transitively either.
    expect(
      [...reachableFrom(output, isMessagingCode)].filter((target) =>
        /^src\/modules\/communities\/(domain|application|infrastructure|api)\//u.test(target),
      ),
    ).toEqual([]);
  });

  it('is never reached by Communities — the edge points one way, so no cycle can close', () => {
    const intrusions = edgesFrom(output, (source) => source.startsWith('src/modules/communities/'))
      .filter((edge) => edge.resolved.startsWith('src/modules/messaging/'))
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
    expect(
      (output.summary.violations ?? []).filter(
        (violation) => violation.rule.name === 'no-circular',
      ),
    ).toEqual([]);
  });

  it('wires Communities in without a cycle, and exports nothing that writes membership', () => {
    const messagingImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      MessagingModule,
    ) as unknown[];
    const communitiesImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      CommunitiesModule,
    ) as unknown[];
    expect(messagingImports).toContain(CommunitiesModule);
    expect(communitiesImports).not.toContain(MessagingModule);
    expect((communitiesImports as { name?: string }[]).map((imported) => imported.name)).toEqual([
      'IdentityModule',
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, MessagingModule)).toEqual([
      MESSAGE_RECIPIENTS,
      MESSAGE_DELIVERY,
    ]);
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
