import { Inject, Injectable } from '@nestjs/common';

import { err, ok, type Result } from '../../../shared';
import {
  COMMUNITY_MEMBERSHIP,
  MAX_MEMBER_PAGE,
  type CommunityMembership,
} from '../../communities/contracts';
import {
  ACCOUNT_ROSTER,
  ACCOUNT_ROSTER_MAX_PAGE,
  type AccountRoster,
} from '../../identity/contracts/account-roster';
import { AUDIENCE_ROLES, type TaskAudience } from '../domain/audience';
import { COMMUNITY_NOT_FOUND } from './task-failures';

export interface Addressee {
  readonly recipientId: string;
  /** The first of the task's audiences (canonical order) the person belongs to. */
  readonly audience: TaskAudience;
}

/**
 * Who a task is addressed to (ADR 0052 §2): the ACTIVE holders of the audiences'
 * roles (identity's `ACCOUNT_ROSTER`), optionally narrowed to one existing
 * community's active members (communities' `COMMUNITY_MEMBERSHIP`) — the app's
 * groups reused, never re-created. The publisher is not addressed to themself.
 */
@Injectable()
export class AudienceResolver {
  constructor(
    @Inject(ACCOUNT_ROSTER) private readonly roster: AccountRoster,
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
  ) {}

  async resolve(
    audiences: readonly TaskAudience[],
    communityId: string | null,
    publisherId: string,
  ): Promise<Result<readonly Addressee[]>> {
    if (communityId !== null && !(await this.communityExists(communityId))) {
      return err(COMMUNITY_NOT_FOUND);
    }
    const byPerson = new Map<string, TaskAudience>();
    for (const audience of audiences) {
      for (const id of await this.holders(audience)) {
        if (id !== publisherId && !byPerson.has(id)) byPerson.set(id, audience);
      }
    }
    const allowed =
      communityId === null ? null : await this.membersAmong(communityId, [...byPerson.keys()]);
    return ok(
      [...byPerson.entries()]
        .filter(([id]) => allowed === null || allowed.has(id))
        .map(([recipientId, audience]) => ({ recipientId, audience })),
    );
  }

  /** The audience a person would be addressed through, if they may hold the task. */
  async audienceOf(
    userId: string,
    audiences: readonly TaskAudience[],
    communityId: string | null,
  ): Promise<TaskAudience | null> {
    if (communityId !== null && !(await this.membersAmong(communityId, [userId])).has(userId)) {
      return null;
    }
    for (const audience of audiences) {
      if ((await this.roster.activeAmong([userId], AUDIENCE_ROLES[audience])).has(userId)) {
        return audience;
      }
    }
    return null;
  }

  private async holders(audience: TaskAudience): Promise<readonly string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.roster.activeWithRoles(AUDIENCE_ROLES[audience], {
        cursor,
        limit: ACCOUNT_ROSTER_MAX_PAGE,
      });
      ids.push(...page.userIds);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return ids;
  }

  private async membersAmong(
    communityId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    const members = new Set<string>();
    for (let start = 0; start < userIds.length; start += MAX_MEMBER_PAGE) {
      const chunk = userIds.slice(start, start + MAX_MEMBER_PAGE);
      let cursor: string | null = null;
      do {
        const page = await this.membership.members(communityId, {
          onlyUserIds: chunk,
          cursor,
          limit: MAX_MEMBER_PAGE,
        });
        for (const id of page.userIds) members.add(id);
        cursor = page.nextCursor;
      } while (cursor !== null);
    }
    return members;
  }

  private async communityExists(communityId: string): Promise<boolean> {
    return (await this.membership.heads([communityId])).length > 0;
  }
}
