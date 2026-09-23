import { failure } from '../../../shared/result';
import type { Permission } from '../../identity/contracts/permissions';
import type { CommunityCapability } from '../contracts/capabilities';
import type { MembershipStanding } from '../contracts/vocabulary';
import { ruleFor, type OwnerOperation } from './act-rules';
import { COMMUNITY_NOT_FOUND, type AuthorityRead, type HeldCeilings } from './authority';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PROVISIONAL DELEGATION RULES — NOT CONFIRMED BY THE INSTITUTION (Q42, Q44, Q45)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Delegation and ownership (§6.8–§6.10), as pure functions — the analogue of
 * identity's `canGrantRole`, reimplemented because that one is identity's own.
 * Both stores and every use case call these; no rule is written twice.
 *
 *   R1  only the owner grants and revokes; no sub-delegation   decideOwnerOperation(MANAGE_GRANTS)
 *   R2  no escalation: the owner holds each capability's       ceilingOf — asked of identity in
 *       ceiling                                                 memory, before anything is read
 *   R3  the grantee is an ACTIVE member, not the owner, and     mayGrant (the membership half, under
 *       an ACTIVE account holding every ceiling permission       lock); ceilingOf (the account half,
 *                                                                 through ACCOUNT_DIRECTORY)
 *   R4  a lost ceiling makes a grant dormant, never deleted     effectiveCapabilities, and the evaluator
 *   R5  no self-grant                                            mayGrant; CHECK …_grants_not_self
 *   R6  a delegate removes M only if M is not the owner and     mayRemove, under lock
 *       M's ACTIVE grants, dormant ones included, are a
 *       subset of the remover's effective capabilities
 *   R7  granting an ACTIVE (stint, capability) again is a       the partial unique index, ON CONFLICT
 *       no-op returning the existing grant                      DO NOTHING (in memory: the same check)
 *
 * Answering Q42, Q44 or Q45 edits this file and its test; no consumer changes.
 */

export const NOT_COMMUNITY_OWNER = failure(
  'forbidden',
  'communities.not_community_owner',
  'Only the owner of this community can do this.',
);

/** R3: unknown, inactive, non-member, owner and ineligible grantees are refused alike. */
export const GRANTEE_INELIGIBLE = failure(
  'validation',
  'communities.grantee_ineligible',
  'That account cannot hold these capabilities in this community.',
);

/** Removing oneself would end the stint as REMOVED — closing the way back by link (Q49). */
export const CANNOT_REMOVE_SELF = failure(
  'validation',
  'communities.cannot_remove_self',
  'You cannot remove yourself; leave the community instead.',
);

/** R6. Deliberately without detail: which capabilities a member holds is the owner's to see (Q45). */
export const MEMBER_HOLDS_MORE_CAPABILITIES = failure(
  'forbidden',
  'communities.member_holds_more_capabilities',
  'This member holds a capability you do not; only the owner can remove them.',
);

/** R2 and R3's account half: the identity permissions a capability needs — its standing ceiling. */
export function ceilingOf(capability: CommunityCapability): readonly Permission[] {
  return ruleFor(capability).standingCeiling;
}

export type OwnerDecision =
  | {
      readonly kind: 'permit';
      readonly basis: 'owner';
      readonly membership: {
        readonly membershipId: string;
        readonly joinedAt: Date;
        readonly version: number;
      };
    }
  | { readonly kind: 'permit'; readonly basis: 'oversight'; readonly membership: null }
  /** No ceiling on any path: identity's own refusal is the answer, and nothing is read. */
  | { readonly kind: 'no_ceiling' }
  | { readonly kind: 'refused'; readonly failure: typeof COMMUNITY_NOT_FOUND };

/**
 * R1, and a transfer's authority (§6.9): the owner — an ACTIVE OWNER stint
 * and the owner ceiling — or, where the operation allows it, oversight.
 * The evaluator's order: the ceiling in memory first, then the read; a
 * non-member hears what anyone hears about a community that does not exist,
 * and a member who is not the owner hears `not_community_owner`. Grants never
 * reach these operations, and no lifecycle status closes them.
 */
export function decideOwnerOperation(
  operation: OwnerOperation,
  held: HeldCeilings,
  read: AuthorityRead,
): OwnerDecision {
  const oversight = operation.oversightCeiling !== null && held.oversight;
  if (!held.standing && !oversight) return { kind: 'no_ceiling' };
  if (read.community === null) return { kind: 'refused', failure: COMMUNITY_NOT_FOUND };
  const stint = read.stint;
  if (stint?.standing === 'OWNER' && held.standing) {
    return {
      kind: 'permit',
      basis: 'owner',
      membership: { membershipId: stint.id, joinedAt: stint.joinedAt, version: stint.version },
    };
  }
  if (oversight) return { kind: 'permit', basis: 'oversight', membership: null };
  if (stint === null) return { kind: 'refused', failure: COMMUNITY_NOT_FOUND };
  return { kind: 'refused', failure: NOT_COMMUNITY_OWNER };
}

/**
 * R3's membership half and R5, decided under lock: the grantee's ACTIVE
 * stint exists, is not the owner's, and is not the grantor's own.
 */
export function mayGrant(input: {
  readonly grantorUserId: string;
  readonly grantee: { readonly userId: string; readonly standing: MembershipStanding } | null;
}): boolean {
  const { grantee } = input;
  return grantee !== null && grantee.standing !== 'OWNER' && grantee.userId !== input.grantorUserId;
}

/**
 * R4: of the capabilities someone's ACTIVE grants name, those whose identity
 * ceiling they hold right now. The others are dormant — still granted, not
 * effective, and effective again if the ceiling comes back.
 */
export function effectiveCapabilities(
  granted: readonly CommunityCapability[],
  ceilingHeld: ReadonlySet<CommunityCapability>,
): ReadonlySet<CommunityCapability> {
  return new Set(granted.filter((capability) => ceilingHeld.has(capability)));
}

export type RemovalDecision = 'allowed' | 'owner' | 'self' | 'holds_more';

/**
 * Who may be removed (§3.2, R6), decided under lock. The owner never is —
 * by anyone. Nobody removes themself: leaving is a leave (LEFT, and a way
 * back by link), never a removal (REMOVED, which closes it — Q49). A
 * delegate (the grant basis) removes only someone whose ACTIVE grants,
 * dormant ones included, are all among the delegate's own effective
 * capabilities: nobody can take out a peer stronger than themself, and two
 * delegates can never remove each other in one interleaving. The owner and
 * oversight are not bounded by R6.
 */
export function mayRemove(input: {
  readonly basis: 'owner' | 'grant' | 'oversight';
  readonly target: { readonly userId: string; readonly standing: MembershipStanding };
  readonly targetGrants: readonly CommunityCapability[];
  readonly removerUserId: string | null;
  readonly removerEffective: ReadonlySet<CommunityCapability>;
}): RemovalDecision {
  if (input.target.standing === 'OWNER') return 'owner';
  if (input.target.userId === input.removerUserId) return 'self';
  if (input.basis !== 'grant') return 'allowed';
  return input.targetGrants.every((capability) => input.removerEffective.has(capability))
    ? 'allowed'
    : 'holds_more';
}

export type TransferDecision = 'proceed' | 'unchanged' | 'self_assignment';

/**
 * A transfer naming its own actor (§6.9, PROVISIONAL Q42): the owner already
 * is the owner — nothing changes, nothing is recorded; an overseer never
 * names themself (separation of duties). Any other target proceeds: whether
 * it is an eligible ACTIVE member is the account directory's and the store's
 * to say, and the store answers `unchanged` when it already is the owner.
 */
export function mayTransfer(input: {
  readonly basis: 'owner' | 'oversight';
  readonly actorUserId: string;
  readonly actorIsOwner: boolean;
  readonly targetUserId: string;
}): TransferDecision {
  if (input.targetUserId !== input.actorUserId) return 'proceed';
  return input.basis === 'owner' || input.actorIsOwner ? 'unchanged' : 'self_assignment';
}
