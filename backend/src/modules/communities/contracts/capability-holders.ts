import type { CommunityCapability } from './capabilities';

/** DI token. */
export const COMMUNITY_CAPABILITY_HOLDERS = Symbol('COMMUNITY_CAPABILITY_HOLDERS');

/** The most holders one page may ask for. */
export const MAX_HOLDER_PAGE = 1000;

/**
 * Who, in one community, may exercise one capability by standing: the owner
 * (who holds every capability implicitly) and every member holding an ACTIVE
 * grant of it — each only while identity still gives them the capability's
 * ceiling, so a dormant holder (§6.10) is not listed. Never an overseer:
 * oversight is reach, not standing.
 *
 * For trusted in-process consumers with no principal (Live's moderators, a
 * future notification audience). It answers who holds a capability, never
 * whether the lifecycle allows the act now: a consumer acting for a person
 * asks COMMUNITY_AUTHORIZATION.
 */
export interface CommunityCapabilityHolders {
  /**
   * One page, in user-id order. A page may be short — even empty — after
   * dormant holders are filtered out: keep asking while `nextCursor` is not
   * null. An unknown community has no holders. A limit outside
   * 1..MAX_HOLDER_PAGE, or a cursor this contract did not issue, is a
   * RangeError.
   */
  list(
    communityId: string,
    capability: CommunityCapability,
    page: { readonly cursor?: string | null; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
}
