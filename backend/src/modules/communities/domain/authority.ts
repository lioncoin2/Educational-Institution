import { failure, type Failure } from '../../../shared/result';
import type { Permission } from '../../identity/contracts/permissions';
import type { CommunityAuthorityBasis } from '../contracts/authorization';
import type { CommunityCapability } from '../contracts/capabilities';
import type { MembershipStanding } from '../contracts/vocabulary';
import { backingCapability, type ActRule } from './act-rules';
import { permitsGate } from './lifecycle';

/** Which of a rule's ceilings the principal holds — identity's answer, asked in memory. */
export interface HeldCeilings {
  readonly standing: boolean;
  readonly oversight: boolean;
}

/** An ACTIVE grant resting on the principal's stint. */
export interface HeldGrant {
  readonly id: string;
  readonly capability: CommunityCapability;
}

/**
 * The one read the evaluator needs (step 2): the community's status, the
 * principal's ACTIVE stint in it, and that stint's ACTIVE grants (at most
 * one per capability). Unique-index probes only, whatever the size.
 */
export interface AuthorityRead {
  readonly community: { readonly status: string } | null;
  readonly stint: {
    readonly id: string;
    readonly standing: MembershipStanding;
    readonly joinedAt: Date;
    readonly version: number;
    readonly grants: readonly HeldGrant[];
  } | null;
}

export type AuthorityDecision =
  | {
      readonly kind: 'permit';
      readonly basis: CommunityAuthorityBasis;
      readonly membership: {
        readonly membershipId: string;
        readonly joinedAt: Date;
        readonly version: number;
      } | null;
      /** Non-null exactly when the basis is a grant. */
      readonly grantId: string | null;
      readonly ceiling: readonly Permission[];
    }
  /** No ceiling on any path: identity's own refusal is returned, and nothing is read. */
  | { readonly kind: 'no_ceiling' }
  | { readonly kind: 'refused'; readonly failure: Failure };

export const COMMUNITY_NOT_FOUND = failure(
  'not_found',
  'communities.community_not_found',
  'No such community.',
);

/** Step 1, in memory: may anything be read at all? */
export function holdsAnyCeiling(rule: ActRule, held: HeldCeilings): boolean {
  return held.standing || (rule.oversightCeiling !== null && held.oversight);
}

/**
 * The evaluator (§6.5), as one pure function. The order is fixed:
 *
 *   1  ceiling     the standing ceiling, or the oversight ceiling if the act has one
 *   2  read        (done by the caller — only once step 1 passed)
 *   3  basis       first match wins: membership (a participation act, ACTIVE
 *                  stint, standing ceiling); owner (a capability or derived act,
 *                  standing OWNER, standing ceiling); grant (a capability or
 *                  derived act, an ACTIVE grant of its backing capability on the
 *                  ACTIVE stint, standing ceiling); oversight (its ceiling held)
 *   4  not found   the community is missing — or there is no basis and the
 *                  principal is not a member: the two answers are identical
 *   4′ forbidden   no basis, but a member: `capability_required {act}`
 *   5  gate        the lifecycle permits the act now; never blocks `community.lock`
 *
 * The gate comes after the basis, so a non-member never learns a community's
 * state. A grant is checked against the holder's ceiling at every
 * evaluation: one whose holder lost it is dormant — never effective, never
 * deleted (R4).
 */
export function decideCommunityAct(
  rule: ActRule,
  held: HeldCeilings,
  read: AuthorityRead,
): AuthorityDecision {
  if (!holdsAnyCeiling(rule, held)) return { kind: 'no_ceiling' };
  if (read.community === null) return { kind: 'refused', failure: COMMUNITY_NOT_FOUND };

  const stint = read.stint;
  const membership =
    stint === null
      ? null
      : { membershipId: stint.id, joinedAt: stint.joinedAt, version: stint.version };
  const backing = backingCapability(rule.act);
  const grant =
    stint === null || backing === null
      ? undefined
      : stint.grants.find((held) => held.capability === backing);

  let basis: CommunityAuthorityBasis | null = null;
  if (rule.kind === 'participation' && stint !== null && held.standing) {
    basis = 'membership';
  } else if (
    rule.kind !== 'participation' &&
    rule.ownerImplicit &&
    stint?.standing === 'OWNER' &&
    held.standing
  ) {
    basis = 'owner';
  } else if (rule.kind !== 'participation' && grant !== undefined && held.standing) {
    basis = 'grant';
  } else if (rule.oversightCeiling !== null && held.oversight) {
    basis = 'oversight';
  }

  if (basis === null) {
    if (stint === null) return { kind: 'refused', failure: COMMUNITY_NOT_FOUND };
    return {
      kind: 'refused',
      failure: failure(
        'forbidden',
        'communities.capability_required',
        'You do not hold this capability in this community.',
        { act: rule.act },
      ),
    };
  }

  if (!permitsGate(read.community.status, rule.gate)) {
    return {
      kind: 'refused',
      failure: failure(
        'precondition_failed',
        'communities.community_locked',
        'This community is locked.',
        { act: rule.act },
      ),
    };
  }

  return {
    kind: 'permit',
    basis,
    membership: basis === 'oversight' ? null : membership,
    grantId: basis === 'grant' ? (grant?.id ?? null) : null,
    ceiling: basis === 'oversight' ? (rule.oversightCeiling ?? []) : rule.standingCeiling,
  };
}
