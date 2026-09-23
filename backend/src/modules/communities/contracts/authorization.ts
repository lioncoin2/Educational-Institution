import type { Principal, Result } from '../../../shared';
import type { Permission } from '../../identity/contracts/permissions';
import type { COMMUNITY_RESOURCE, CommunityAct } from './capabilities';

/** DI token. */
export const COMMUNITY_AUTHORIZATION = Symbol('COMMUNITY_AUTHORIZATION');

/** The most community ids one `authorizeEach` call may ask about. */
export const MAX_AUTHORIZE_BATCH = 1000;

/**
 * Why a permit was given:
 *
 *   membership  a participation act, by an ACTIVE member
 *   owner       a capability the owner holds implicitly
 *   grant       a capability the owner delegated to a member, on that member's stint
 *   oversight   institutional reach without membership (`communities.manage`)
 */
export type CommunityAuthorityBasis = 'membership' | 'owner' | 'grant' | 'oversight';

/**
 * A positive answer, naming exactly what it rests on. Whoever acts on a
 * permit copies `{act, basis, membershipId, grantId}` into its audit entry,
 * so the record shows which standing authorized the act at that instant.
 */
export interface CommunityPermit {
  readonly principalUserId: string;
  readonly communityId: string;
  readonly scope: typeof COMMUNITY_RESOURCE;
  readonly act: CommunityAct;
  readonly basis: CommunityAuthorityBasis;
  /** The principal's ACTIVE stint; null exactly when the basis is oversight. */
  readonly membership: {
    readonly membershipId: string;
    readonly joinedAt: Date;
    readonly version: number;
  } | null;
  /** Non-null exactly when the basis is a grant. */
  readonly grantId: string | null;
  /** The identity permissions required, and held, on the path taken. */
  readonly ceiling: readonly Permission[];
}

/**
 * "May this principal do this act in this community?" — the one question
 * every module asks before acting in a community for a person. Messaging,
 * Live and Attendance each ask it at their own decision point, with the
 * community id read from their OWN stored record, never from a client.
 *
 * The answer is the ceiling (identity's, in memory, before anything is read),
 * then one read, then the basis, then the lifecycle gate:
 *
 *   403 identity.permission_denied        no ceiling on any path — nothing was read
 *   404 communities.community_not_found   no such community, or no basis and not a
 *                                         member: the two answers are identical
 *   403 communities.capability_required   a member without the capability
 *   412 communities.community_locked      the lifecycle does not permit the act now
 *
 * Stateless: no cache across requests, reads on the primary. A store failure
 * rejects the promise; a caller fails closed and never answers from roles alone.
 */
export interface CommunityAuthorization {
  authorize(
    principal: Principal,
    communityId: string,
    act: CommunityAct,
  ): Promise<Result<CommunityPermit>>;

  /**
   * The same question for up to MAX_AUTHORIZE_BATCH communities at once (a
   * RangeError above), in a fixed number of statements. Every id asked about
   * has an answer; an unknown id is `not_found`.
   */
  authorizeEach(
    principal: Principal,
    communityIds: readonly string[],
    act: CommunityAct,
  ): Promise<ReadonlyMap<string, Result<CommunityPermit>>>;
}
