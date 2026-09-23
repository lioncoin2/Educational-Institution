import { Inject, Injectable } from '@nestjs/common';

import type { CommunityDirectory, CommunitySummary } from '../contracts/directory';
import { MAX_MEMBER_PAGE } from '../contracts/membership';
import { COMMUNITY_READ_MODEL, type CommunityReadModel } from '../domain/ports';

/**
 * COMMUNITY_DIRECTORY — a community's title, for display after a positive
 * permit. It answers nothing about access; unknown ids are absent.
 */
@Injectable()
export class CommunityDirectoryService implements CommunityDirectory {
  constructor(@Inject(COMMUNITY_READ_MODEL) private readonly readModel: CommunityReadModel) {}

  async describe(communityIds: readonly string[]): Promise<readonly CommunitySummary[]> {
    if (communityIds.length > MAX_MEMBER_PAGE) {
      throw new RangeError(`At most ${MAX_MEMBER_PAGE} community ids per call.`);
    }
    if (communityIds.length === 0) return [];
    const communities = await this.readModel.communities([...new Set(communityIds)]);
    return communities.map((community) => ({
      communityId: community.id,
      title: community.title,
    }));
  }
}
