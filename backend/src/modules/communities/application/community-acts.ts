import { failure, type Failure, type Principal } from '../../../shared';
import { isSystemPrincipal } from '../../identity/contracts/principal';
import type { CommunityPermit } from '../contracts/authorization';
import type { ActRule } from '../domain/act-rules';
import type { ActingBasis } from '../domain/ports';
import type { CommunityAuthorizationService } from './community-authorization.service';

/** A deadlock victim, after the store's one retry. Nothing was changed. */
export const COMMUNITY_CONFLICT = failure(
  'conflict',
  'communities.conflict',
  'Another change to this community got in the way. Nothing was changed; try again.',
);

/**
 * Only a person can own a community or join one: a system principal (a job,
 * an automation) never holds a stint, so it can take no act that needs one.
 */
export const PERSON_REQUIRED = failure(
  'forbidden',
  'communities.person_required',
  'Only a person can do this in a community.',
);

/** Who to record as having acted: a person's id, or null for a system job. */
export function actorOf(principal: Principal): string | null {
  return isSystemPrincipal(principal) ? null : principal.userId;
}

/**
 * The basis a mutation hands the store to re-verify under lock. A
 * membership permit never mutates on someone else's behalf, and the grant
 * basis arrives with delegation (P3).
 */
export function actingBasis(permit: CommunityPermit): ActingBasis {
  if (permit.basis === 'oversight') return { kind: 'oversight' };
  if (permit.basis === 'owner' && permit.membership !== null) {
    return {
      kind: 'owner',
      userId: permit.principalUserId,
      membershipId: permit.membership.membershipId,
    };
  }
  throw new Error(`A ${permit.basis} permit cannot authorize this change.`);
}

/**
 * The basis an act rested on was gone by the time the store locked it (a
 * concurrent change won). The permit is asked for again, and its refusal is
 * the answer; if it now passes, the two raced and the caller may retry.
 */
export async function refusalAfterBasisLost(
  authorization: CommunityAuthorizationService,
  principal: Principal,
  communityId: string,
  rule: ActRule,
): Promise<Failure> {
  const again = await authorization.evaluate(principal, communityId, rule);
  return again.result.ok ? COMMUNITY_CONFLICT : again.result.error;
}
