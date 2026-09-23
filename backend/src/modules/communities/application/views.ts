import type { CommunityCapability, CommunityParticipationAct } from '../contracts/capabilities';
import type { InvitationState, MembershipStanding } from '../contracts/vocabulary';
import type { Community } from '../domain/community';
import type { CapabilityGrant } from '../domain/grant';
import { invitationState, type Invitation } from '../domain/invitation';

/**
 * What the caller may do here right now — a UI courtesy, computed on the
 * server by the same evaluator every request goes through, and never
 * trusted back. Buttons follow it; the server decides again every time.
 */
export interface MeView {
  /** Null when the caller is not a member (the oversight basis). */
  readonly standing: MembershipStanding | null;
  readonly joinedAt: Date | null;
  /** Effective now: ceiling AND standing AND lifecycle. */
  readonly capabilities: readonly CommunityCapability[];
  readonly participation: readonly CommunityParticipationAct[];
}

/**
 * A community as its routes show it. No member list, no source of anyone's
 * membership, no chat or live data (Communities knows none of them).
 */
export interface CommunityView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly lifecycleVersion: number;
  readonly memberCount: number;
  readonly createdAt: Date;
  readonly me: MeView;
}

export function communityView(community: Community, me: MeView): CommunityView {
  return {
    id: community.id,
    title: community.title,
    status: community.status,
    lifecycleVersion: community.lifecycleVersion,
    memberCount: community.memberCount,
    createdAt: community.createdAt,
    me,
  };
}

/**
 * One roster row: a display name from identity (never an email), whether the
 * ACCOUNT is active, and when this stint began. How or by whom someone
 * joined is not shown (Q22).
 */
export interface MemberView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly active: boolean;
  readonly joinedAt: Date;
}

/**
 * A link's metadata — never its token (shown once, at creation) and never
 * its hash. The state is derived at request time.
 */
export interface InvitationView {
  readonly id: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly state: InvitationState;
  readonly revokedAt: Date | null;
}

export function invitationView(invitation: Invitation, now: Date): InvitationView {
  return {
    id: invitation.id,
    createdBy: invitation.createdBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    maxUses: invitation.maxUses,
    uses: invitation.uses,
    state: invitationState(invitation, now),
    revokedAt: invitation.revokedAt,
  };
}

export interface PageView<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface AddMembersView {
  /** Accounts that became members now. */
  readonly added: readonly string[];
  /** Accounts that already were: nothing was written for them. */
  readonly unchanged: readonly string[];
}

/**
 * One ACTIVE grant, as the owner — or its holder — sees it. `dormant`: the
 * holder no longer has the capability's identity ceiling (or cannot sign
 * in), so the grant is kept but not effective (R4, Q45).
 */
export interface GrantView {
  readonly grantId: string;
  readonly userId: string;
  readonly capability: CommunityCapability;
  readonly grantedAt: Date;
  readonly grantedBy: string;
  readonly dormant: boolean;
}

export function grantView(grant: CapabilityGrant, dormant: boolean): GrantView {
  return {
    grantId: grant.id,
    userId: grant.userId,
    capability: grant.capability,
    grantedAt: grant.grantedAt,
    grantedBy: grant.grantedBy,
    dormant,
  };
}

export interface GrantCapabilitiesView {
  /** Grants given now. */
  readonly created: readonly GrantView[];
  /** Grants the member already held: nothing was written for them (R7). */
  readonly unchanged: readonly GrantView[];
}
