import { Inject, Injectable } from '@nestjs/common';

import {
  MAX_MEMBER_PAGE,
  type CommunityHead,
  type CommunityMembership,
  type MemberState,
  type MembershipChanges,
} from '../contracts/membership';
import type { Community } from '../domain/community';
import { effectsOf } from '../domain/lifecycle';
import type { Stint } from '../domain/membership';
import { COMMUNITY_READ_MODEL, type CommunityReadModel } from '../domain/ports';
import { decodeMemberCursor, encodeMemberCursor } from './cursors';

function headOf(community: Community): CommunityHead {
  return {
    communityId: community.id,
    membershipVersion: community.membershipVersion,
    lifecycleVersion: community.lifecycleVersion,
    effects: effectsOf(community.status),
  };
}

function stateOf(stint: Stint): MemberState {
  return {
    communityId: stint.communityId,
    userId: stint.userId,
    membershipId: stint.id,
    active: stint.status === 'ACTIVE',
    joinedAt: stint.joinedAt,
    version: stint.version,
  };
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMBER_PAGE) {
    throw new RangeError(`A page is 1 to ${MAX_MEMBER_PAGE} items.`);
  }
}

function checkList(ids: readonly string[]): void {
  if (ids.length > MAX_MEMBER_PAGE) {
    throw new RangeError(`At most ${MAX_MEMBER_PAGE} ids per call.`);
  }
}

/**
 * COMMUNITY_MEMBERSHIP — membership facts for trusted in-process consumers,
 * with no principal. Every call is a point lookup, a keyset page or an
 * ordered feed; none loads a whole community or reports its size.
 */
@Injectable()
export class CommunityMembershipService implements CommunityMembership {
  constructor(@Inject(COMMUNITY_READ_MODEL) private readonly readModel: CommunityReadModel) {}

  async heads(communityIds: readonly string[]): Promise<readonly CommunityHead[]> {
    checkList(communityIds);
    if (communityIds.length === 0) return [];
    return (await this.readModel.communities([...new Set(communityIds)])).map(headOf);
  }

  async listHeads(page: {
    readonly afterCommunityId?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly CommunityHead[]; readonly next: string | null }> {
    checkLimit(page.limit);
    const rows = await this.readModel.communitiesAfter(page.afterCommunityId, page.limit + 1);
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(headOf),
      next: rows.length > page.limit && last !== undefined ? last.id : null,
    };
  }

  async statesOf(communityId: string, userIds: readonly string[]): Promise<readonly MemberState[]> {
    checkList(userIds);
    if (userIds.length === 0) return [];
    return (await this.readModel.latestStints(communityId, [...new Set(userIds)])).map(stateOf);
  }

  async changesSince(
    communityId: string,
    afterVersion: number,
    limit: number,
  ): Promise<MembershipChanges | null> {
    checkLimit(limit);
    if (!Number.isInteger(afterVersion) || afterVersion < 0) {
      throw new RangeError('afterVersion is a whole number from 0.');
    }
    const snapshot = await this.readModel.changesSince(communityId, afterVersion, limit + 1);
    if (snapshot === null) return null;
    const hasMore = snapshot.stints.length > limit;
    const page = snapshot.stints.slice(0, limit);
    // The latest state per user within the page — a user who left and
    // rejoined appears once, as they are now.
    const latest = new Map<string, Stint>();
    for (const stint of page) latest.set(stint.userId, stint);
    const last = page[page.length - 1];
    return {
      states: [...latest.values()].sort((a, b) => a.version - b.version).map(stateOf),
      head: headOf(snapshot.community),
      // Versions are unique and in commit order, and the head is the same
      // snapshot: with nothing more to read, everything up to the head is seen.
      throughVersion:
        hasMore && last !== undefined
          ? last.version
          : Math.max(afterVersion, snapshot.community.membershipVersion),
      hasMore,
    };
  }

  async members(
    communityId: string,
    page: {
      readonly onlyUserIds?: readonly string[];
      readonly excludeUserId?: string;
      readonly cursor?: string | null;
      readonly limit: number;
    },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }> {
    checkLimit(page.limit);
    if (page.onlyUserIds !== undefined) checkList(page.onlyUserIds);
    const afterUserId =
      page.cursor === undefined || page.cursor === null
        ? undefined
        : decodeMemberCursor(page.cursor);
    if (page.onlyUserIds !== undefined && page.onlyUserIds.length === 0) {
      return { userIds: [], nextCursor: null };
    }
    const rows = await this.readModel.memberIds(communityId, {
      afterUserId,
      onlyUserIds: page.onlyUserIds === undefined ? undefined : [...new Set(page.onlyUserIds)],
      excludeUserId: page.excludeUserId,
      limit: page.limit + 1,
    });
    const userIds = rows.slice(0, page.limit);
    const last = userIds[userIds.length - 1];
    return {
      userIds,
      nextCursor: rows.length > page.limit && last !== undefined ? encodeMemberCursor(last) : null,
    };
  }
}
