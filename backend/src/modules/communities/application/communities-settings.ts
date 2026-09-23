import type { RateLimitPolicy } from '../../../shared';
import { COMMUNITY_RESOURCE } from '../contracts/capabilities';

/**
 * What Communities records in the audit trail: every effective change, and
 * every read made on the oversight basis — never an ordinary member's read,
 * an evaluation, a denial, a failed redemption or a repeat that changed
 * nothing (those are logs and metrics). Entries carry ids, codes and
 * versions: never a title, a name, a token or a token's hash.
 */
export const CommunityAudit = {
  communityCreated: 'communities.community.created',
  communityLocked: 'communities.community.locked',
  communityUnlocked: 'communities.community.unlocked',
  /** A manager added someone — one entry per newcomer. */
  memberAdded: 'communities.member.added',
  /** Someone joined through a link; the actor is the joiner. */
  memberJoined: 'communities.member.joined',
  memberRemoved: 'communities.member.removed',
  memberLeft: 'communities.member.left',
  invitationCreated: 'communities.invitation.created',
  invitationRevoked: 'communities.invitation.revoked',
  /** One entry per grant row the owner created (P3). */
  capabilityGranted: 'communities.capability.granted',
  /** The owner took a grant back (P3). Grants ending with a stint are in the stint's entry. */
  capabilityRevoked: 'communities.capability.revoked',
  ownershipTransferred: 'communities.ownership.transferred',
  /** PROVISIONAL (Q43): a read made without membership, on the oversight basis. */
  oversightRead: 'communities.oversight.read',
} as const;

export const COMMUNITY_AUDIT_RESOURCE = COMMUNITY_RESOURCE;

/** Page sizes: a default, and a ceiling no request can raise. */
export const CommunityPages = {
  communities: { default: 30, max: 100 },
  roster: { default: 50, max: 200 },
  invitations: { default: 50, max: 200 },
  grants: { default: 50, max: 200 },
} as const;

/**
 * The most accounts one add request may name. Technical, not policy: it
 * keeps the community row's lock short (the mirror of messaging's
 * MAX_PARTICIPANTS_PER_REQUEST). There is no limit on a community's size.
 */
export const MAX_MEMBERS_PER_ADD = 200;

/**
 * PROVISIONAL, development-safe limits (Q48, Q26). Per process until a
 * shared limiter exists; correctness never depends on them.
 */
export const CommunityRateLimits = {
  communitiesCreatedPerUser: {
    name: 'communities.create.user',
    limit: 20,
    windowSeconds: 60 * 60,
  },
  invitationsCreatedPerUser: {
    name: 'communities.invitation.user',
    limit: 30,
    windowSeconds: 60 * 60,
  },
  memberAddsPerUser: { name: 'communities.members.add.user', limit: 60, windowSeconds: 10 * 60 },
  grantsPerUser: { name: 'communities.grants.user', limit: 60, windowSeconds: 10 * 60 },
  joinsPerUser: { name: 'communities.join.user', limit: 10, windowSeconds: 10 * 60 },
  /** Generous, so a school behind one address is not throttled. */
  joinsPerIp: { name: 'communities.join.ip', limit: 300, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export function pageLimit(
  requested: number | undefined,
  limits: { readonly default: number; readonly max: number },
): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
    return limits.default;
  }
  return Math.min(requested, limits.max);
}
