import type { Page } from '../../../shared';
import type { AccountSummary } from '../../identity/contracts';
import type {
  CommunityCapability,
  CommunityOperation,
  CommunityParticipationAct,
} from '../contracts/capabilities';
import type { InvitationState, MembershipStanding } from '../contracts/vocabulary';
import type {
  AddMembersView,
  CommunityView,
  GrantCapabilitiesView,
  GrantView,
  InvitationView,
  MemberView,
  PageView,
} from '../application/views';

/**
 * Wire shapes: explicit and flat, instants as ISO-8601. No response ever
 * carries an email, a token hash, or how and by whom someone joined; only the
 * one response that creates a link carries its token.
 */

export interface CommunityResponse {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly lifecycleVersion: number;
  readonly memberCount: number;
  /** The academic halaqa this community is associated with, or null (Q50). */
  readonly halaqaId: string | null;
  readonly createdAt: string;
  readonly me: {
    readonly standing: MembershipStanding | null;
    readonly joinedAt: string | null;
    readonly capabilities: readonly CommunityCapability[];
    readonly participation: readonly CommunityParticipationAct[];
    readonly operations: readonly CommunityOperation[];
  };
}

export function toCommunityResponse(view: CommunityView): CommunityResponse {
  return {
    id: view.id,
    title: view.title,
    status: view.status,
    lifecycleVersion: view.lifecycleVersion,
    memberCount: view.memberCount,
    halaqaId: view.halaqaId,
    createdAt: view.createdAt.toISOString(),
    me: {
      standing: view.me.standing,
      joinedAt: view.me.joinedAt?.toISOString() ?? null,
      capabilities: view.me.capabilities,
      participation: view.me.participation,
      operations: view.me.operations,
    },
  };
}

export interface MemberResponse {
  readonly userId: string;
  readonly displayName: string | null;
  readonly active: boolean;
  readonly joinedAt: string;
}

export function toMemberResponse(view: MemberView): MemberResponse {
  return {
    userId: view.userId,
    displayName: view.displayName,
    active: view.active,
    joinedAt: view.joinedAt.toISOString(),
  };
}

export interface InvitationResponse {
  readonly id: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly state: InvitationState;
  readonly revokedAt: string | null;
}

export function toInvitationResponse(view: InvitationView): InvitationResponse {
  return {
    id: view.id,
    createdBy: view.createdBy,
    createdAt: view.createdAt.toISOString(),
    expiresAt: view.expiresAt.toISOString(),
    maxUses: view.maxUses,
    uses: view.uses,
    state: view.state,
    revokedAt: view.revokedAt?.toISOString() ?? null,
  };
}

export function toAddMembersResponse(view: AddMembersView): {
  readonly added: readonly string[];
  readonly unchanged: readonly string[];
} {
  return { added: view.added, unchanged: view.unchanged };
}

export interface GrantResponse {
  readonly grantId: string;
  readonly userId: string;
  readonly capability: CommunityCapability;
  readonly grantedAt: string;
  readonly grantedBy: string;
  readonly dormant: boolean;
}

export function toGrantResponse(view: GrantView): GrantResponse {
  return {
    grantId: view.grantId,
    userId: view.userId,
    capability: view.capability,
    grantedAt: view.grantedAt.toISOString(),
    grantedBy: view.grantedBy,
    dormant: view.dormant,
  };
}

export function toGrantCapabilitiesResponse(view: GrantCapabilitiesView): {
  readonly created: readonly GrantResponse[];
  readonly unchanged: readonly GrantResponse[];
} {
  return {
    created: view.created.map(toGrantResponse),
    unchanged: view.unchanged.map(toGrantResponse),
  };
}

export function toPageResponse<T, R>(
  page: PageView<T>,
  map: (item: T) => R,
): { readonly items: readonly R[]; readonly nextCursor: string | null } {
  return { items: page.items.map(map), nextCursor: page.nextCursor };
}

/**
 * One member-candidate: the whole of what a candidate search discloses — an id
 * to add and a name to show, never an email, a role or any security state (the
 * same minimal projection `GET /people` uses). Sourced from identity's
 * `AccountSummary`; no second identity DTO is introduced.
 */
export interface MemberCandidateResult {
  readonly userId: string;
  readonly displayName: string;
}

export function toMemberCandidatesResponse(page: Page<AccountSummary>): {
  readonly items: readonly MemberCandidateResult[];
  readonly nextCursor: string | null;
} {
  return {
    items: page.items.map((account) => ({
      userId: account.userId,
      displayName: account.displayName,
    })),
    nextCursor: page.nextCursor ?? null,
  };
}
