import type { Community } from '../domain/community';
import type { CapabilityGrant } from '../domain/grant';
import type { Invitation } from '../domain/invitation';
import type { Stint } from '../domain/membership';
import type {
  CommunityGrantRow,
  CommunityInvitationRow,
  CommunityMemberRow,
  CommunityRow,
} from './schema';

/** Rows to entities and back, field by field — no spreading, so no column leaks. */

export function toCommunity(row: CommunityRow): Community {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    lifecycleVersion: row.lifecycleVersion,
    membershipVersion: Number(row.membershipVersion),
    memberCount: row.memberCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    statusChangedAt: row.statusChangedAt,
    statusChangedBy: row.statusChangedBy,
    updatedAt: row.updatedAt,
  };
}

export function communityRow(community: Community): CommunityRow {
  return {
    id: community.id,
    title: community.title,
    status: community.status,
    lifecycleVersion: community.lifecycleVersion,
    membershipVersion: community.membershipVersion,
    memberCount: community.memberCount,
    createdBy: community.createdBy,
    createdAt: community.createdAt,
    statusChangedAt: community.statusChangedAt,
    statusChangedBy: community.statusChangedBy,
    updatedAt: community.updatedAt,
  };
}

export function toStint(row: CommunityMemberRow): Stint {
  return {
    id: row.id,
    communityId: row.communityId,
    userId: row.userId,
    status: row.status,
    standing: row.standing,
    source: row.source,
    addedBy: row.addedBy,
    invitationId: row.invitationId,
    joinedAt: row.joinedAt,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
    version: Number(row.version),
  };
}

export function stintRow(stint: Stint): CommunityMemberRow {
  return {
    id: stint.id,
    communityId: stint.communityId,
    userId: stint.userId,
    status: stint.status,
    standing: stint.standing,
    source: stint.source,
    addedBy: stint.addedBy,
    invitationId: stint.invitationId,
    joinedAt: stint.joinedAt,
    endedAt: stint.endedAt,
    endedBy: stint.endedBy,
    version: stint.version,
  };
}

export function toInvitation(row: CommunityInvitationRow): Invitation {
  return {
    id: row.id,
    communityId: row.communityId,
    tokenHash: row.tokenHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    uses: row.uses,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}

export function invitationRow(invitation: Invitation): CommunityInvitationRow {
  return {
    id: invitation.id,
    communityId: invitation.communityId,
    tokenHash: invitation.tokenHash,
    createdBy: invitation.createdBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    maxUses: invitation.maxUses,
    uses: invitation.uses,
    revokedAt: invitation.revokedAt,
    revokedBy: invitation.revokedBy,
  };
}

export function toGrant(row: CommunityGrantRow): CapabilityGrant {
  return {
    id: row.id,
    communityId: row.communityId,
    membershipId: row.membershipId,
    userId: row.userId,
    capability: row.capability,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    endedAt: row.endedAt,
    endedBy: row.endedBy,
    endReason: row.endReason,
  };
}

export function grantRow(grant: CapabilityGrant): CommunityGrantRow {
  return {
    id: grant.id,
    communityId: grant.communityId,
    membershipId: grant.membershipId,
    userId: grant.userId,
    capability: grant.capability,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    endedAt: grant.endedAt,
    endedBy: grant.endedBy,
    endReason: grant.endReason,
  };
}
