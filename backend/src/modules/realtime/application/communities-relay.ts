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
import { COMMUNITY_VIEW_CEILING } from '../../communities/contracts/capabilities';
import {
  CommunityEvents,
  type CapabilityGranted,
  type CapabilityRevoked,
  type CommunityLocked,
  type CommunityUnlocked,
  type MemberAdded,
  type MemberRemoved,
  type OwnershipTransferred,
} from '../../communities/contracts/events';
import {
  COMMUNITY_MEMBERSHIP,
  type CommunityMembership,
  type MemberState,
} from '../../communities/contracts/membership';
import {
  ACCOUNT_DIRECTORY,
  ACCOUNT_DIRECTORY_MAX_IDS,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import { ConnectionManager } from './connection-manager';
import {
  communityAccessChangedFrame,
  communityLockedFrame,
  type AccessChangeCause,
  communityMemberAddedFrame,
  communityMemberRemovedFrame,
  communityUnlockedFrame,
} from './envelopes';
import { onlineAudience } from './online-audience';

/**
 * Communities' facts, delivered to the people they concern who are connected
 * right now — as hints. A frame names ids and versions only; the client
 * re-reads the community over HTTP, which decides everything, so a frame
 * grants nothing and a lost one costs nothing but a moment.
 *
 *   member.added           the person added, while that stint is still their
 *                          current one: a community to show
 *   member.removed         the person who left or was removed, while they are
 *                          still out: a community to put away. Nobody else
 *                          is told (Q22, Q49 — PROVISIONAL)
 *   capability.granted     the holder, while a member: what they may do there
 *   capability.revoked     changed. Nothing is announced to the others (Q45)
 *   ownership.transferred  the old owner and the new one, each while a member
 *   community.locked       every ACTIVE member connected here, unless a newer
 *   community.unlocked     lock or unlock has already committed
 *
 * `community.created` and the invitation events travel nowhere: the creator
 * has the HTTP response, and a link is never on any wire.
 *
 * Every audience is resolved at delivery time from Communities' contract —
 * the person's latest stint, the community's ACTIVE members — never from the
 * event alone, from a client, or from anything kept here. It is then
 * narrowed to the accounts holding COMMUNITY_VIEW_CEILING, the ceiling the
 * same person needs to read the community over HTTP. So an event published
 * out of order, or overtaken by a later change, reaches nobody it no longer
 * concerns; and a removed member is told so, and then nothing more.
 *
 * What an event costs, on this instance: nothing when no one is connected
 * here, nor when the person it concerns is not; otherwise one statesOf and
 * one withPermission. A lock or unlock: one heads, at most 1 + ⌈A/1000⌉
 * member pages for A accounts online (`onlineAudience`), and ⌈N/1000⌉
 * withPermission for the N members found among them — whatever the size of
 * the community.
 *
 * Delivery is detached from the publisher and serialized per community, as
 * messaging's relay does it: one community's events leave in the order they
 * were published, and a Communities request never waits for its audience.
 */
@Injectable()
export class CommunitiesRealtimeRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommunitiesRealtimeRelay.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  /** The tail of each community's delivery chain. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    private readonly connections: ConnectionManager,
  ) {}

  onModuleInit(): void {
    for (const name of [
      CommunityEvents.memberAdded,
      CommunityEvents.memberRemoved,
      CommunityEvents.capabilityGranted,
      CommunityEvents.capabilityRevoked,
      CommunityEvents.ownershipTransferred,
      CommunityEvents.communityLocked,
      CommunityEvents.communityUnlocked,
    ]) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Queues delivery behind the community's earlier events, and returns at once. */
  schedule(event: DomainEvent): void {
    // Nobody is connected to this instance: nothing to deliver, nothing to ask.
    if (this.connections.count() === 0) return;
    const key = event.aggregateId;
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.relay(event))
      .catch((error: unknown) =>
        this.logger.error(
          { event: event.name, aggregateId: event.aggregateId, err: error },
          'realtime delivery failed',
        ),
      );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Resolves once everything scheduled so far has been delivered — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Delivers one event now. Awaitable, for tests and for a future durable consumer. */
  async relay(event: DomainEvent): Promise<void> {
    switch (event.name) {
      case CommunityEvents.memberAdded: {
        const payload = memberAddedPayload(event);
        if (payload === null) return this.malformed(event);
        // Only while the stint announced is the current one: an `added`
        // that a removal has overtaken tells nobody anything.
        const [userId] = await this.concerned(
          payload.communityId,
          [payload.userId],
          (state) => state?.active === true && state.membershipId === payload.membershipId,
        );
        if (userId === undefined) return;
        this.connections.sendToUser(
          userId,
          communityMemberAddedFrame({
            occurredAt: event.occurredAt,
            communityId: payload.communityId,
            userId,
            membershipVersion: payload.membershipVersion,
          }),
        );
        return;
      }
      case CommunityEvents.memberRemoved: {
        const payload = memberRemovedPayload(event);
        if (payload === null) return this.malformed(event);
        // Only while they are still out: a `removed` that a rejoin has
        // overtaken would put away a community they belong to.
        const [userId] = await this.concerned(
          payload.communityId,
          [payload.userId],
          (state) => state?.active !== true,
        );
        if (userId === undefined) return;
        this.connections.sendToUser(
          userId,
          communityMemberRemovedFrame({
            occurredAt: event.occurredAt,
            communityId: payload.communityId,
            userId,
            reason: payload.reason === 'LEFT' ? 'left' : 'removed',
            membershipVersion: payload.membershipVersion,
          }),
        );
        return;
      }
      case CommunityEvents.capabilityGranted:
      case CommunityEvents.capabilityRevoked: {
        const payload = capabilityPayload(event);
        if (payload === null) return this.malformed(event);
        return this.accessChanged(event, payload.communityId, [payload.userId], {
          kind: event.name === CommunityEvents.capabilityGranted ? 'granted' : 'revoked',
          grantId: payload.grantId,
        });
      }
      case CommunityEvents.ownershipTransferred: {
        const payload = ownershipTransferredPayload(event);
        if (payload === null) return this.malformed(event);
        return this.accessChanged(
          event,
          payload.communityId,
          [payload.fromUserId, payload.toUserId],
          { kind: 'transferred', fromUserId: payload.fromUserId, toUserId: payload.toUserId },
        );
      }
      case CommunityEvents.communityLocked:
      case CommunityEvents.communityUnlocked: {
        const payload = lifecyclePayload(event);
        if (payload === null) return this.malformed(event);
        return this.lifecycleMoved(event, payload);
      }
    }
  }

  /** `community.access.changed` to each member named — their own frame, their own id. */
  private async accessChanged(
    event: DomainEvent,
    communityId: string,
    userIds: readonly string[],
    cause: AccessChangeCause,
  ): Promise<void> {
    const members = await this.concerned(communityId, userIds, (state) => state?.active === true);
    for (const userId of members) {
      this.connections.sendToUser(
        userId,
        communityAccessChangedFrame({ occurredAt: event.occurredAt, communityId, userId, cause }),
      );
    }
  }

  private async lifecycleMoved(
    event: DomainEvent,
    payload: CommunityLocked['payload'] | CommunityUnlocked['payload'],
  ): Promise<void> {
    if (this.connections.count() === 0) return;
    const [head] = await this.membership.heads([payload.communityId]);
    // Gone, or a newer lock or unlock has committed: this one is history,
    // and whoever is connected hears the newer one instead.
    if (head === undefined || head.lifecycleVersion > payload.lifecycleVersion) return;

    const members = await onlineAudience(this.connections.onlineUserIds(), (page) =>
      this.membership.members(payload.communityId, {
        onlyUserIds: page.onlyUserIds,
        cursor: page.cursor,
        limit: page.limit,
      }),
    );
    const recipients = await this.viewers(members);
    if (recipients.length === 0) return;
    const build =
      event.name === CommunityEvents.communityLocked
        ? communityLockedFrame
        : communityUnlockedFrame;
    this.connections.sendToUsers(
      recipients,
      build({
        occurredAt: event.occurredAt,
        communityId: payload.communityId,
        lifecycleVersion: payload.lifecycleVersion,
      }),
    );
  }

  /**
   * Those of `userIds` connected here whose latest stint `still` accepts —
   * asked of Communities now — and who may view the community. Nobody of
   * them connected here: nothing is asked at all.
   */
  private async concerned(
    communityId: string,
    userIds: readonly string[],
    still: (latest: MemberState | undefined) => boolean,
  ): Promise<string[]> {
    const online = [...new Set(userIds)].filter((userId) => this.connections.isOnline(userId));
    if (online.length === 0) return [];
    const latest = new Map(
      (await this.membership.statesOf(communityId, online)).map((state) => [state.userId, state]),
    );
    return this.viewers(online.filter((userId) => still(latest.get(userId))));
  }

  /**
   * The ids, in order, whose ACTIVE accounts hold every permission of
   * COMMUNITY_VIEW_CEILING — identity's answer, asked in chunks it accepts.
   */
  private async viewers(userIds: readonly string[]): Promise<string[]> {
    let kept = [...userIds];
    for (const permission of COMMUNITY_VIEW_CEILING) {
      const allowed = new Set<string>();
      for (let from = 0; from < kept.length; from += ACCOUNT_DIRECTORY_MAX_IDS) {
        const chunk = kept.slice(from, from + ACCOUNT_DIRECTORY_MAX_IDS);
        for (const userId of await this.accounts.withPermission(chunk, permission)) {
          allowed.add(userId);
        }
      }
      kept = kept.filter((userId) => allowed.has(userId));
    }
    return kept;
  }

  private malformed(event: DomainEvent): void {
    this.logger.warn({ event: event.name }, 'ignoring a malformed community event');
  }
}

// Events cross a module boundary: their shape is checked, not assumed — and a
// payload about another community than the one its event is ordered under is
// not delivered out of that order.

type Fields<T> = Partial<Record<keyof T, unknown>>;

function fieldsOf<T extends { readonly communityId: string }>(
  event: DomainEvent,
  ...names: readonly string[]
): Fields<T> | null {
  const payload = event.payload as Fields<T> | null;
  if (!names.includes(event.name) || payload === null || typeof payload !== 'object') return null;
  return payload.communityId === event.aggregateId && isId(payload.communityId) ? payload : null;
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function memberAddedPayload(event: DomainEvent): MemberAdded['payload'] | null {
  const p = fieldsOf<MemberAdded['payload']>(event, CommunityEvents.memberAdded);
  if (p === null || !isId(p.userId) || !isId(p.membershipId) || !isVersion(p.membershipVersion)) {
    return null;
  }
  return p as MemberAdded['payload'];
}

function memberRemovedPayload(event: DomainEvent): MemberRemoved['payload'] | null {
  const p = fieldsOf<MemberRemoved['payload']>(event, CommunityEvents.memberRemoved);
  if (
    p === null ||
    !isId(p.userId) ||
    !isId(p.membershipId) ||
    !isVersion(p.membershipVersion) ||
    (p.reason !== 'LEFT' && p.reason !== 'REMOVED')
  ) {
    return null;
  }
  return p as MemberRemoved['payload'];
}

function capabilityPayload(
  event: DomainEvent,
): CapabilityGranted['payload'] | CapabilityRevoked['payload'] | null {
  const p = fieldsOf<CapabilityGranted['payload']>(
    event,
    CommunityEvents.capabilityGranted,
    CommunityEvents.capabilityRevoked,
  );
  if (p === null || !isId(p.userId) || !isId(p.grantId)) return null;
  return p as CapabilityGranted['payload'];
}

function ownershipTransferredPayload(event: DomainEvent): OwnershipTransferred['payload'] | null {
  const p = fieldsOf<OwnershipTransferred['payload']>(event, CommunityEvents.ownershipTransferred);
  if (p === null || !isId(p.fromUserId) || !isId(p.toUserId)) return null;
  return p as OwnershipTransferred['payload'];
}

function lifecyclePayload(
  event: DomainEvent,
): CommunityLocked['payload'] | CommunityUnlocked['payload'] | null {
  const p = fieldsOf<CommunityLocked['payload']>(
    event,
    CommunityEvents.communityLocked,
    CommunityEvents.communityUnlocked,
  );
  if (p === null || !isVersion(p.lifecycleVersion)) return null;
  return p as CommunityLocked['payload'];
}
