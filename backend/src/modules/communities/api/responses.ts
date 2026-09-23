import type { CommunityCapability, CommunityParticipationAct } from '../contracts/capabilities';
import type { InvitationState, MembershipStanding } from '../contracts/vocabulary';
import type {
  AddMembersView,
  CommunityView,
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
  readonly createdAt: string;
  readonly me: {
    readonly standing: MembershipStanding | null;
    readonly joinedAt: string | null;
    readonly capabilities: readonly CommunityCapability[];
    readonly participation: readonly CommunityParticipationAct[];
  };
}

export function toCommunityResponse(view: CommunityView): CommunityResponse {
  return {
    id: view.id,
    title: view.title,
    status: view.status,
    lifecycleVersion: view.lifecycleVersion,
    memberCount: view.memberCount,
    createdAt: view.createdAt.toISOString(),
    me: {
      standing: view.me.standing,
      joinedAt: view.me.joinedAt?.toISOString() ?? null,
      capabilities: view.me.capabilities,
      participation: view.me.participation,
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

export function toPageResponse<T, R>(
  page: PageView<T>,
  map: (item: T) => R,
): { readonly items: readonly R[]; readonly nextCursor: string | null } {
  return { items: page.items.map(map), nextCursor: page.nextCursor };
}
