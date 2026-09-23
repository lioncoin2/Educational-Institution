import { domainEvent } from '../../../shared/domain-event';
import {
  CommunityEvents,
  type CommunityCreated,
  type CommunityLocked,
  type CommunityUnlocked,
  type InvitationCreated,
  type InvitationRevoked,
  type MemberAdded,
  type MemberRemoved,
} from '../contracts/events';
import type { Community } from './community';
import type { Invitation } from './invitation';
import type { Stint } from './membership';

/**
 * Every payload is ids, codes and versions — built field by field, never
 * spread from an entity, so a title, a name or a token hash can never ride
 * along. The aggregate is always the community.
 */

export function communityCreated(community: Community, correlationId?: string): CommunityCreated {
  return domainEvent(
    CommunityEvents.communityCreated,
    community.id,
    { communityId: community.id, createdBy: community.createdBy },
    community.createdAt,
    correlationId,
  );
}

export function communityLocked(
  community: Community,
  by: string | null,
  at: Date,
  correlationId?: string,
): CommunityLocked {
  return domainEvent(
    CommunityEvents.communityLocked,
    community.id,
    { communityId: community.id, lockedBy: by, lifecycleVersion: community.lifecycleVersion },
    at,
    correlationId,
  );
}

export function communityUnlocked(
  community: Community,
  by: string | null,
  at: Date,
  correlationId?: string,
): CommunityUnlocked {
  return domainEvent(
    CommunityEvents.communityUnlocked,
    community.id,
    { communityId: community.id, unlockedBy: by, lifecycleVersion: community.lifecycleVersion },
    at,
    correlationId,
  );
}

export function memberAdded(stint: Stint, correlationId?: string): MemberAdded {
  return domainEvent(
    CommunityEvents.memberAdded,
    stint.communityId,
    {
      communityId: stint.communityId,
      userId: stint.userId,
      membershipId: stint.id,
      source: stint.source,
      addedBy: stint.addedBy,
      invitationId: stint.invitationId,
      membershipVersion: stint.version,
    },
    stint.joinedAt,
    correlationId,
  );
}

/** For an ended stint: LEFT by the person themself, or REMOVED by someone. */
export function memberRemoved(stint: Stint, correlationId?: string): MemberRemoved {
  if (stint.status === 'ACTIVE' || stint.endedAt === null) {
    throw new Error('memberRemoved needs an ended stint');
  }
  return domainEvent(
    CommunityEvents.memberRemoved,
    stint.communityId,
    {
      communityId: stint.communityId,
      userId: stint.userId,
      membershipId: stint.id,
      reason: stint.status,
      removedBy: stint.endedBy,
      membershipVersion: stint.version,
    },
    stint.endedAt,
    correlationId,
  );
}

export function invitationCreated(
  invitation: Invitation,
  correlationId?: string,
): InvitationCreated {
  return domainEvent(
    CommunityEvents.invitationCreated,
    invitation.communityId,
    {
      communityId: invitation.communityId,
      invitationId: invitation.id,
      createdBy: invitation.createdBy,
    },
    invitation.createdAt,
    correlationId,
  );
}

export function invitationRevoked(
  invitation: Invitation,
  correlationId?: string,
): InvitationRevoked {
  if (invitation.revokedAt === null)
    throw new Error('invitationRevoked needs a revoked invitation');
  return domainEvent(
    CommunityEvents.invitationRevoked,
    invitation.communityId,
    {
      communityId: invitation.communityId,
      invitationId: invitation.id,
      revokedBy: invitation.revokedBy,
    },
    invitation.revokedAt,
    correlationId,
  );
}
