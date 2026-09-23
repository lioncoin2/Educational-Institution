import type { CommunityCapability } from '../contracts/capabilities';

/**
 * How a grant ended (§6.10). Terminal, set once:
 *
 *   revoked            the owner took it back
 *   membership_ended   its stint ended — the holder left or was removed — in
 *                      the same transaction
 *   ownership_changed  its holder became the owner, who holds every
 *                      capability implicitly
 *
 * Losing the identity ceiling is not an end: the grant stays ACTIVE and is
 * dormant until the ceiling comes back (R4).
 */
export const GRANT_END_REASONS = ['revoked', 'membership_ended', 'ownership_changed'] as const;
export type GrantEndReason = (typeof GRANT_END_REASONS)[number];

/**
 * One capability, given by the owner to one member's stint (§3.4) — its own
 * small aggregate, never inside the Community, so a grant never locks the
 * community row. `(membershipId, communityId, userId)` is the stint's own
 * triple (a composite foreign key), so a grant in one community gives nothing
 * in another, and a rejoin — a new stint — never revives one.
 *
 * ACTIVE while `endedAt` is null; ENDED is terminal and a re-grant is a new
 * row. Rows are never deleted.
 */
export interface CapabilityGrant {
  readonly id: string;
  readonly communityId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly capability: CommunityCapability;
  /** The owner who gave it — never the holder (R5). */
  readonly grantedBy: string;
  readonly grantedAt: Date;
  /** Null exactly while ACTIVE; never before `grantedAt`. */
  readonly endedAt: Date | null;
  readonly endedBy: string | null;
  readonly endReason: GrantEndReason | null;
}

export function isActiveGrant(grant: CapabilityGrant): boolean {
  return grant.endedAt === null;
}

export function newGrant(input: {
  readonly id: string;
  readonly communityId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly capability: CommunityCapability;
  readonly grantedBy: string;
  readonly at: Date;
}): CapabilityGrant {
  if (input.grantedBy === input.userId) throw new Error('a grant is never given to oneself');
  return {
    id: input.id,
    communityId: input.communityId,
    membershipId: input.membershipId,
    userId: input.userId,
    capability: input.capability,
    grantedBy: input.grantedBy,
    grantedAt: input.at,
    endedAt: null,
    endedBy: null,
    endReason: null,
  };
}

/**
 * The grant ended, once. The end is never recorded before the grant: a clock
 * that stepped back is held to `grantedAt`, as the database's `greatest(…)`
 * does. `by` is who acted — the owner, the person who left, whoever removed
 * them, or whoever made the transfer; null for a system principal.
 */
export function endGrant(
  grant: CapabilityGrant,
  ending: { readonly reason: GrantEndReason; readonly by: string | null; readonly at: Date },
): CapabilityGrant {
  if (!isActiveGrant(grant)) throw new Error(`grant ${grant.id} has already ended`);
  const at = ending.at.getTime() < grant.grantedAt.getTime() ? grant.grantedAt : ending.at;
  return { ...grant, endedAt: at, endedBy: ending.by, endReason: ending.reason };
}
