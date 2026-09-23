import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { Community } from '../domain/community';
import type { Invitation } from '../domain/invitation';
import type { Stint } from '../domain/membership';
import type { CommunityReadModel, Keyset, MyCommunity } from '../domain/ports';
import { toCommunity, toInvitation, toStint } from './row-mapping';
import {
  communities,
  communityInvitations,
  communityMembers,
  type CommunityMemberRow,
  type CommunityRow,
} from './schema';

const iso = (at: Date) => sql`${at.toISOString()}::timestamptz`;

/**
 * Communities' lists and contract reads. Each is ONE statement on an index
 * that holds exactly what it lists — the partial indexes carry ACTIVE rows
 * only, so churn history never slows a page — keyset-paged, with no OFFSET
 * and no count. The EXPLAIN suite pins each to an index scan at 30,000 and
 * 100,000 members.
 */
@Injectable()
export class DrizzleCommunityReadModel implements CommunityReadModel {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async myCommunities(
    userId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly MyCommunity[]> {
    // community_members_user_idx (user_id, joined_at, community_id) WHERE ACTIVE, backwards.
    const rows = await this.db
      .select({ stint: communityMembers, community: communities })
      .from(communityMembers)
      .innerJoin(communities, eq(communities.id, communityMembers.communityId))
      .where(
        and(
          eq(communityMembers.userId, userId),
          eq(communityMembers.status, 'ACTIVE'),
          page.before === undefined
            ? undefined
            : sql`(${communityMembers.joinedAt}, ${communityMembers.communityId}) < (${iso(page.before.at)}, ${page.before.id})`,
        ),
      )
      .orderBy(desc(communityMembers.joinedAt), desc(communityMembers.communityId))
      .limit(page.limit);
    return rows.map((row) => ({
      community: toCommunity(row.community),
      stint: toStint(row.stint),
    }));
  }

  async allCommunities(page: {
    readonly before?: Keyset;
    readonly limit: number;
  }): Promise<readonly Community[]> {
    // communities_created_idx (created_at, id), backwards.
    const rows = await this.db
      .select()
      .from(communities)
      .where(
        page.before === undefined
          ? undefined
          : sql`(${communities.createdAt}, ${communities.id}) < (${iso(page.before.at)}, ${page.before.id})`,
      )
      .orderBy(desc(communities.createdAt), desc(communities.id))
      .limit(page.limit);
    return rows.map(toCommunity);
  }

  async roster(
    communityId: string,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly Stint[]> {
    // community_members_roster_idx (community_id, joined_at, user_id) WHERE ACTIVE.
    const rows = await this.db
      .select()
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.status, 'ACTIVE'),
          page.after === undefined
            ? undefined
            : sql`(${communityMembers.joinedAt}, ${communityMembers.userId}) > (${iso(page.after.at)}, ${page.after.id})`,
        ),
      )
      .orderBy(asc(communityMembers.joinedAt), asc(communityMembers.userId))
      .limit(page.limit);
    return rows.map(toStint);
  }

  async invitations(
    communityId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly Invitation[]> {
    // community_invitations_community_idx (community_id, created_at, id), backwards.
    const rows = await this.db
      .select()
      .from(communityInvitations)
      .where(
        and(
          eq(communityInvitations.communityId, communityId),
          page.before === undefined
            ? undefined
            : sql`(${communityInvitations.createdAt}, ${communityInvitations.id}) < (${iso(page.before.at)}, ${page.before.id})`,
        ),
      )
      .orderBy(desc(communityInvitations.createdAt), desc(communityInvitations.id))
      .limit(page.limit);
    return rows.map(toInvitation);
  }

  async findInvitation(communityId: string, invitationId: string): Promise<Invitation | null> {
    const [row] = await this.db
      .select()
      .from(communityInvitations)
      .where(
        and(
          eq(communityInvitations.id, invitationId),
          eq(communityInvitations.communityId, communityId),
        ),
      );
    return row === undefined ? null : toInvitation(row);
  }

  async communities(ids: readonly string[]): Promise<readonly Community[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(communities)
      .where(inArray(communities.id, [...ids]));
    return rows.map(toCommunity);
  }

  async communitiesAfter(
    afterId: string | undefined,
    limit: number,
  ): Promise<readonly Community[]> {
    const rows = await this.db
      .select()
      .from(communities)
      .where(afterId === undefined ? undefined : gt(communities.id, afterId))
      .orderBy(asc(communities.id))
      .limit(limit);
    return rows.map(toCommunity);
  }

  async latestStints(communityId: string, userIds: readonly string[]): Promise<readonly Stint[]> {
    if (userIds.length === 0) return [];
    // community_members_history_idx (community_id, user_id, version DESC):
    // the latest stint is the highest version, never the latest joined_at.
    const rows = await this.db
      .selectDistinctOn([communityMembers.userId])
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          inArray(communityMembers.userId, [...userIds]),
        ),
      )
      .orderBy(asc(communityMembers.userId), desc(communityMembers.version));
    return rows.map(toStint);
  }

  async changesSince(
    communityId: string,
    afterVersion: number,
    limit: number,
  ): Promise<{ readonly community: Community; readonly stints: readonly Stint[] } | null> {
    // ONE statement, so the head and the changes are the same snapshot:
    // community_members_version_unique (community_id, version) supplies the
    // changes in order through a lateral join.
    const result = await this.db.execute<{
      readonly community: CommunityRow;
      readonly stint: CommunityMemberRow | null;
    }>(sql`
      select to_jsonb(c) as community, to_jsonb(m) as stint
        from ${communities} c
        left join lateral (
          select *
            from ${communityMembers} m
           where m.community_id = c.id
             and m.version > ${afterVersion}
           order by m.version
           limit ${limit}
        ) m on true
       where c.id = ${communityId}
       order by m.version`);
    const first = result.rows[0];
    if (first === undefined) return null;
    return {
      community: toCommunity(fromJson(first.community)),
      stints: result.rows.flatMap((row) =>
        row.stint === null ? [] : [toStint(fromJsonStint(row.stint))],
      ),
    };
  }

  async memberIds(
    communityId: string,
    page: {
      readonly afterUserId?: string;
      readonly onlyUserIds?: readonly string[];
      readonly excludeUserId?: string;
      readonly limit: number;
    },
  ): Promise<readonly string[]> {
    // community_members_current_unique (community_id, user_id) WHERE ACTIVE.
    const rows = await this.db
      .select({ userId: communityMembers.userId })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.status, 'ACTIVE'),
          page.afterUserId === undefined
            ? undefined
            : gt(communityMembers.userId, page.afterUserId),
          page.onlyUserIds === undefined
            ? undefined
            : inArray(communityMembers.userId, [...page.onlyUserIds]),
          page.excludeUserId === undefined
            ? undefined
            : ne(communityMembers.userId, page.excludeUserId),
        ),
      )
      .orderBy(asc(communityMembers.userId))
      .limit(page.limit);
    return rows.map((row) => row.userId);
  }
}

/** A `to_jsonb` row back into a typed row: snake_case keys, ISO timestamps. */
function fromJson(json: unknown): CommunityRow {
  const row = json as Record<string, string | number | null>;
  const date = (value: string | number | null) => (value === null ? null : new Date(value));
  return {
    id: row.id as string,
    title: row.title as string,
    status: row.status as CommunityRow['status'],
    lifecycleVersion: Number(row.lifecycle_version),
    membershipVersion: Number(row.membership_version),
    memberCount: Number(row.member_count),
    createdBy: row.created_by as string | null,
    createdAt: date(row.created_at) as Date,
    statusChangedAt: date(row.status_changed_at),
    statusChangedBy: row.status_changed_by as string | null,
    updatedAt: date(row.updated_at) as Date,
  };
}

function fromJsonStint(json: unknown): CommunityMemberRow {
  const row = json as Record<string, string | number | null>;
  const date = (value: string | number | null) => (value === null ? null : new Date(value));
  return {
    id: row.id as string,
    communityId: row.community_id as string,
    userId: row.user_id as string,
    status: row.status as CommunityMemberRow['status'],
    standing: row.standing as CommunityMemberRow['standing'],
    source: row.source as CommunityMemberRow['source'],
    addedBy: row.added_by as string | null,
    invitationId: row.invitation_id as string | null,
    joinedAt: date(row.joined_at) as Date,
    endedAt: date(row.ended_at),
    endedBy: row.ended_by as string | null,
    version: Number(row.version),
  };
}
