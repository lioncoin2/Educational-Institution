import { Inject, Injectable } from '@nestjs/common';

import { MAX_HOLDER_PAGE, type CommunityCapabilityHolders } from '../contracts/capability-holders';
import { isCommunityCapability, type CommunityCapability } from '../contracts/capabilities';
import { ceilingOf } from '../domain/delegation';
import { COMMUNITY_READ_MODEL, type CommunityReadModel } from '../domain/ports';
import { CommunityPeople } from './community-people';
import { decodeHolderCursor, encodeHolderCursor } from './cursors';

/**
 * COMMUNITY_CAPABILITY_HOLDERS — who may exercise a capability by standing:
 * the owner and the ACTIVE grantees, a page of candidates at a time in
 * user-id order, each kept only while identity gives them every permission
 * of the capability's ceiling (one ACCOUNT_DIRECTORY call per permission per
 * page, never one per person). Dormant holders drop out; overseers are never
 * candidates. The cursor follows the candidates, so a page may be short.
 */
@Injectable()
export class CapabilityHoldersService implements CommunityCapabilityHolders {
  constructor(
    @Inject(COMMUNITY_READ_MODEL) private readonly readModel: CommunityReadModel,
    private readonly people: CommunityPeople,
  ) {}

  async list(
    communityId: string,
    capability: CommunityCapability,
    page: { readonly cursor?: string | null; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }> {
    if (!isCommunityCapability(capability)) {
      throw new RangeError(`${String(capability)} is not a delegable capability.`);
    }
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_HOLDER_PAGE) {
      throw new RangeError(`A page is 1 to ${MAX_HOLDER_PAGE} holders.`);
    }
    const after =
      page.cursor === undefined || page.cursor === null
        ? undefined
        : decodeHolderCursor(page.cursor);
    const candidates = await this.readModel.holderCandidates(communityId, capability, {
      afterUserId: after,
      limit: page.limit + 1,
    });
    const shown = candidates.slice(0, page.limit);
    let holders: readonly string[] = shown;
    for (const permission of ceilingOf(capability)) {
      if (holders.length === 0) break;
      const holding = await this.people.eligible(holders, permission);
      holders = holders.filter((userId) => holding.has(userId));
    }
    const last = shown[shown.length - 1];
    return {
      userIds: holders,
      nextCursor:
        candidates.length > page.limit && last !== undefined ? encodeHolderCursor(last) : null,
    };
  }
}
