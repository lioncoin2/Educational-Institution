import type { DomainEvent } from '../../../shared/domain-event';

/**
 * Facts Communities publishes — after the database has them, and never for a
 * repeat that changed nothing.
 *
 * `aggregateId` is always the community's id, so one community's changes
 * form one ordered stream. Payloads carry ids, codes and versions ONLY:
 * never a title, a name, a token or its hash, an expiry or a use limit. A
 * consumer that needs more asks Communities' contracts.
 *
 * An event is a hint, never a grant: no consumer enforces a lock or a removal
 * from an event; every decision asks COMMUNITY_AUTHORIZATION. Durability
 * (ADR 0021): `member.removed` is class S, a security reaction with a
 * reconciler backstop; every other event is class R — the table is the fact.
 */
export const CommunityEvents = {
  communityCreated: 'communities.community.created',
  communityLocked: 'communities.community.locked',
  communityUnlocked: 'communities.community.unlocked',
  memberAdded: 'communities.member.added',
  memberRemoved: 'communities.member.removed',
  invitationCreated: 'communities.invitation.created',
  invitationRevoked: 'communities.invitation.revoked',
} as const;

/** Always followed by `member.added` for the owner. */
export type CommunityCreated = DomainEvent<
  typeof CommunityEvents.communityCreated,
  { readonly communityId: string; readonly createdBy: string | null }
>;

export type CommunityLocked = DomainEvent<
  typeof CommunityEvents.communityLocked,
  {
    readonly communityId: string;
    readonly lockedBy: string | null;
    readonly lifecycleVersion: number;
  }
>;

export type CommunityUnlocked = DomainEvent<
  typeof CommunityEvents.communityUnlocked,
  {
    readonly communityId: string;
    readonly unlockedBy: string | null;
    readonly lifecycleVersion: number;
  }
>;

/** Someone became a member: added by a manager, or through a link. */
export type MemberAdded = DomainEvent<
  typeof CommunityEvents.memberAdded,
  {
    readonly communityId: string;
    readonly userId: string;
    readonly membershipId: string;
    readonly source: 'ADDED' | 'INVITATION';
    readonly addedBy: string | null;
    readonly invitationId: string | null;
    readonly membershipVersion: number;
  }
>;

/**
 * A stint ended: the member left, or was removed. Implies that everything
 * resting on that stint ended in the same transaction.
 */
export type MemberRemoved = DomainEvent<
  typeof CommunityEvents.memberRemoved,
  {
    readonly communityId: string;
    readonly userId: string;
    readonly membershipId: string;
    readonly reason: 'LEFT' | 'REMOVED';
    readonly removedBy: string | null;
    readonly membershipVersion: number;
  }
>;

/** Never on any wire: a link's revocation takes effect inside redemption, not through delivery. */
export type InvitationCreated = DomainEvent<
  typeof CommunityEvents.invitationCreated,
  { readonly communityId: string; readonly invitationId: string; readonly createdBy: string | null }
>;

export type InvitationRevoked = DomainEvent<
  typeof CommunityEvents.invitationRevoked,
  { readonly communityId: string; readonly invitationId: string; readonly revokedBy: string | null }
>;

export type CommunityEvent =
  | CommunityCreated
  | CommunityLocked
  | CommunityUnlocked
  | MemberAdded
  | MemberRemoved
  | InvitationCreated
  | InvitationRevoked;
