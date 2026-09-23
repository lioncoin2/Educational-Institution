import { failure, type Failure, type Principal } from '../../../shared';
import { isSystemPrincipal } from '../../identity/contracts/principal';
import type { CommunityPermit } from '../contracts/authorization';
import { backingCapability, type ActRule, type OwnerOperation } from '../domain/act-rules';
import type { ActingBasis, OwnerBasis } from '../domain/ports';
import type { CommunityAuthorizationService, OwnerPermit } from './community-authorization.service';

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
 * membership permit never mutates on someone else's behalf.
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
  const capability = backingCapability(permit.act);
  if (permit.basis === 'grant' && permit.membership !== null && permit.grantId !== null) {
    if (capability === null) throw new Error(`${permit.act} rests on no capability.`);
    return {
      kind: 'grant',
      userId: permit.principalUserId,
      membershipId: permit.membership.membershipId,
      grantId: permit.grantId,
      capability,
    };
  }
  throw new Error(`A ${permit.basis} permit cannot authorize this change.`);
}

/** The owner an owner-operation permit rests on; refuses an oversight permit. */
export function ownerBasis(permit: OwnerPermit): OwnerBasis {
  if (permit.basis !== 'owner' || permit.membership === null) {
    throw new Error(`${permit.operation} on the ${permit.basis} basis has no owner to rest on.`);
  }
  return { userId: permit.principalUserId, membershipId: permit.membership.membershipId };
}

/** An owner-operation permit as the store re-verifies it: the owner's stint, or oversight. */
export function ownerActingBasis(permit: OwnerPermit): ActingBasis {
  return permit.basis === 'oversight'
    ? { kind: 'oversight' }
    : { kind: 'owner', ...ownerBasis(permit) };
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

/** `refusalAfterBasisLost` for the owner's own operations. */
export async function ownerRefusalAfterBasisLost(
  authorization: CommunityAuthorizationService,
  principal: Principal,
  communityId: string,
  operation: OwnerOperation,
): Promise<Failure> {
  const again = await authorization.evaluateOwner(principal, communityId, operation);
  return again.result.ok ? COMMUNITY_CONFLICT : again.result.error;
}
