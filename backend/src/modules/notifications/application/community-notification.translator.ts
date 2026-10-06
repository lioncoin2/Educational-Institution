import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  EVENT_SUBSCRIBER,
  type DomainEvent,
  type EventSubscriber,
  type Unsubscribe,
} from '../../../shared';
import { CommunityEvents } from '../../communities/contracts';
import type { NotificationParams } from '../contracts/targets';
import type { NotificationType } from '../contracts/vocabulary';
import { bodyKeyOf, titleKeyOf } from '../domain/catalog';
import type { NotificationRequest } from '../domain/notification';
import { NotificationDispatcher } from './notification-dispatcher';

/**
 * Communities' facts, translated into notification requests — the only code in
 * this module that knows Communities exists. Communities knows nothing of it.
 *
 *   communities.member.added            COMMUNITY_MEMBER_ADDED          the member
 *   communities.member.removed (REMOVED) COMMUNITY_MEMBER_REMOVED       the member
 *   communities.capability.granted      COMMUNITY_CAPABILITY_GRANTED    the grantee
 *   communities.capability.revoked      COMMUNITY_CAPABILITY_REVOKED    the member
 *   communities.ownership.transferred   COMMUNITY_OWNERSHIP_TRANSFERRED the new owner
 *
 * Each is a single, directed notification: the affected account is in the
 * event, so there is no fan-out and no membership read. A `member.removed`
 * whose reason is LEFT — the person's own act — is not announced; a direct
 * self-add (`addedBy === userId`) is not either, as messaging does not announce
 * your own action.
 *
 * It carries ids only: the community `target` (an id) and, for a grant or a
 * revocation, the capability code — never the community's title or any name,
 * because what a notification (and the realtime frame that delivers it) carries
 * for a community is an id, and the title is HTTP's to tell (the client renders
 * it from the target). Nothing sensitive — no email, token or account internal
 * — is ever carried.
 *
 * Idempotent by a dedupe key that names the source fact (the membership, the
 * grant, or the community + recipient + instant), so the same fact delivered
 * twice creates one notification. Chained per community, detached from the
 * publisher. A malformed payload is logged and ignored, never thrown.
 */
@Injectable()
export class CommunityNotificationTranslator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommunityNotificationTranslator.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    for (const name of [
      CommunityEvents.memberAdded,
      CommunityEvents.memberRemoved,
      CommunityEvents.capabilityGranted,
      CommunityEvents.capabilityRevoked,
      CommunityEvents.ownershipTransferred,
    ]) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Queues translation behind the community's earlier facts, and returns at once. */
  schedule(event: DomainEvent): void {
    const key = event.aggregateId;
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.translate(event))
      .catch((error: unknown) =>
        this.logger.error(
          { event: event.name, aggregateId: event.aggregateId, err: error },
          'notification translation failed',
        ),
      );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Resolves once everything scheduled so far is translated — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Translates one fact now. Awaitable, for tests and a future durable consumer. */
  async translate(event: DomainEvent): Promise<void> {
    switch (event.name) {
      case CommunityEvents.memberAdded: {
        const p = memberAddedPayload(event);
        if (p === null) return this.malformed(event);
        if (p.addedBy === p.userId) return; // a direct self-add is not announced
        return this.dispatchOne(
          event,
          p.communityId,
          'COMMUNITY_MEMBER_ADDED',
          p.userId,
          `community:member_added:${p.membershipId}`,
          {},
        );
      }
      case CommunityEvents.memberRemoved: {
        const p = memberRemovedPayload(event);
        if (p === null) return this.malformed(event);
        if (p.reason !== 'REMOVED') return; // a self-initiated LEFT is not announced
        return this.dispatchOne(
          event,
          p.communityId,
          'COMMUNITY_MEMBER_REMOVED',
          p.userId,
          `community:member_removed:${p.membershipId}`,
          {},
        );
      }
      case CommunityEvents.capabilityGranted: {
        const p = capabilityPayload(event, CommunityEvents.capabilityGranted);
        if (p === null) return this.malformed(event);
        return this.dispatchOne(
          event,
          p.communityId,
          'COMMUNITY_CAPABILITY_GRANTED',
          p.userId,
          `community:capability_granted:${p.grantId}`,
          { capability: p.capability },
        );
      }
      case CommunityEvents.capabilityRevoked: {
        const p = capabilityPayload(event, CommunityEvents.capabilityRevoked);
        if (p === null) return this.malformed(event);
        return this.dispatchOne(
          event,
          p.communityId,
          'COMMUNITY_CAPABILITY_REVOKED',
          p.userId,
          `community:capability_revoked:${p.grantId}`,
          { capability: p.capability },
        );
      }
      case CommunityEvents.ownershipTransferred: {
        const p = ownershipPayload(event);
        if (p === null) return this.malformed(event);
        return this.dispatchOne(
          event,
          p.communityId,
          'COMMUNITY_OWNERSHIP_TRANSFERRED',
          p.toUserId,
          `community:ownership_transferred:${p.communityId}:${p.toUserId}:${event.occurredAt.getTime()}`,
          {},
        );
      }
      default:
        return;
    }
  }

  /** One notification for one recipient, pointing at the community by id. */
  private async dispatchOne(
    event: DomainEvent,
    communityId: string,
    type: NotificationType,
    recipientUserId: string,
    dedupeKey: string,
    params: NotificationParams,
  ): Promise<void> {
    const request: NotificationRequest = {
      recipientUserId,
      type,
      titleKey: titleKeyOf(type),
      bodyKey: bodyKeyOf(type),
      params,
      target: { kind: 'community', communityId },
      dedupeKey,
    };
    await this.dispatcher.dispatch([request], event.correlationId);
  }

  private malformed(event: DomainEvent): void {
    this.logger.warn({ event: event.name }, 'ignoring a malformed community event');
  }
}

// Events cross a module boundary: their shape is checked, not assumed. Only the
// fields this translator reads are required; `addedBy`/`reason` are read where
// they may be null or an enum, and compared rather than asserted.

interface MemberAddedFields {
  communityId: string;
  userId: string;
  membershipId: string;
  addedBy: string | null;
}

interface MemberRemovedFields {
  communityId: string;
  userId: string;
  membershipId: string;
  reason: string;
}

interface CapabilityFields {
  communityId: string;
  userId: string;
  grantId: string;
  capability: string;
}

interface OwnershipFields {
  communityId: string;
  toUserId: string;
}

function recordOf(event: DomainEvent, name: string): Record<string, unknown> | null {
  const payload = event.payload;
  if (event.name !== name || payload === null || typeof payload !== 'object') return null;
  return payload as Record<string, unknown>;
}

function memberAddedPayload(event: DomainEvent): MemberAddedFields | null {
  const p = recordOf(event, CommunityEvents.memberAdded);
  if (
    p === null ||
    typeof p.communityId !== 'string' ||
    typeof p.userId !== 'string' ||
    typeof p.membershipId !== 'string'
  ) {
    return null;
  }
  return {
    communityId: p.communityId,
    userId: p.userId,
    membershipId: p.membershipId,
    addedBy: typeof p.addedBy === 'string' ? p.addedBy : null,
  };
}

function memberRemovedPayload(event: DomainEvent): MemberRemovedFields | null {
  const p = recordOf(event, CommunityEvents.memberRemoved);
  if (
    p === null ||
    typeof p.communityId !== 'string' ||
    typeof p.userId !== 'string' ||
    typeof p.membershipId !== 'string' ||
    typeof p.reason !== 'string'
  ) {
    return null;
  }
  return {
    communityId: p.communityId,
    userId: p.userId,
    membershipId: p.membershipId,
    reason: p.reason,
  };
}

function capabilityPayload(event: DomainEvent, name: string): CapabilityFields | null {
  const p = recordOf(event, name);
  if (
    p === null ||
    typeof p.communityId !== 'string' ||
    typeof p.userId !== 'string' ||
    typeof p.grantId !== 'string' ||
    typeof p.capability !== 'string'
  ) {
    return null;
  }
  return {
    communityId: p.communityId,
    userId: p.userId,
    grantId: p.grantId,
    capability: p.capability,
  };
}

function ownershipPayload(event: DomainEvent): OwnershipFields | null {
  const p = recordOf(event, CommunityEvents.ownershipTransferred);
  if (p === null || typeof p.communityId !== 'string' || typeof p.toUserId !== 'string') {
    return null;
  }
  return { communityId: p.communityId, toUserId: p.toUserId };
}
