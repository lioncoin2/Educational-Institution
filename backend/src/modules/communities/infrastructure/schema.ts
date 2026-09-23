import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import type {
  CommunityStatus,
  MembershipSource,
  MembershipStanding,
  MembershipStatus,
} from '../contracts/vocabulary';

/**
 * Communities' tables (§5). Communities owns them; no other module reads or
 * writes them (dependency-cruiser and communities-boundaries.spec.ts).
 *
 * Account ids (`user_id`, `*_by`) are NOT foreign keys: accounts belong to
 * identity, and no module holds a constraint on another's tables — so a
 * suspended account's membership stays exactly as it was (Q13). Inside
 * Communities the keys are real and RESTRICT: a community is never deleted
 * (Q47), and nothing its history refers to can vanish underneath it.
 *
 * The guarantees the database makes, by name:
 *
 *   community_members_current_unique   at most one ACTIVE stint per community and person
 *   community_members_owner_unique     exactly one owner per community (with …_owner_active)
 *   community_members_version_unique   membership versions unique per community
 *   community_invitations_token_hash_unique   a token hash identifies one link
 *   community_invitations_uses_within_limit   a link is never used past its limit
 *
 * `member_count` has no upper bound: no size limit is policy here (Q20).
 * `membership_version` and `version` are bigint — they only ever grow.
 */
export const communities = pgTable(
  'communities',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: text('status').$type<CommunityStatus>().notNull(),
    lifecycleVersion: integer('lifecycle_version').notNull().default(1),
    membershipVersion: bigint('membership_version', { mode: 'number' }).notNull().default(0),
    memberCount: integer('member_count').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusChangedBy: text('status_changed_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The oversight listing of every community, newest first — keyset.
    index('communities_created_idx').on(table.createdAt, table.id),
    check('communities_title_length', sql`char_length(${table.title}) between 1 and 100`),
    check('communities_status_valid', sql`${table.status} in ('OPEN', 'LOCKED')`),
    check('communities_lifecycle_version_positive', sql`${table.lifecycleVersion} >= 1`),
    check('communities_membership_version_nonnegative', sql`${table.membershipVersion} >= 0`),
    check('communities_member_count_nonnegative', sql`${table.memberCount} >= 0`),
    check('communities_updated_after_created', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const communityInvitations = pgTable(
  'community_invitations',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'restrict' }),
    /** SHA-256 hex of the bearer token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
  },
  (table) => [
    // The redemption lookup.
    unique('community_invitations_token_hash_unique').on(table.tokenHash),
    // A community's links, newest first — keyset.
    index('community_invitations_community_idx').on(table.communityId, table.createdAt, table.id),
    check('community_invitations_token_hash_shape', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'community_invitations_expires_after_created',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'community_invitations_max_uses_positive',
      sql`${table.maxUses} is null or ${table.maxUses} >= 1`,
    ),
    check(
      'community_invitations_uses_within_limit',
      sql`${table.uses} >= 0 and (${table.maxUses} is null or ${table.uses} <= ${table.maxUses})`,
    ),
    check(
      'community_invitations_revoked_after_created',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const communityMembers = pgTable(
  'community_members',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'restrict' }),
    userId: text('user_id').notNull(),
    status: text('status').$type<MembershipStatus>().notNull(),
    standing: text('standing').$type<MembershipStanding>().notNull().default('MEMBER'),
    source: text('source').$type<MembershipSource>().notNull(),
    addedBy: text('added_by'),
    invitationId: text('invitation_id').references((): AnyPgColumn => communityInvitations.id, {
      onDelete: 'restrict',
    }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: text('ended_by'),
    /** The community-wide version of this row's latest change: unique, in commit order, only raised. */
    version: bigint('version', { mode: 'number' }).notNull(),
  },
  (table) => [
    // One ACTIVE stint per person — the arbiter of joins; the authorization
    // probe; and members() keyset by user id.
    uniqueIndex('community_members_current_unique')
      .on(table.communityId, table.userId)
      .where(sql`${table.status} = 'ACTIVE'`),
    // Exactly one owner (with the owner-is-active CHECK).
    uniqueIndex('community_members_owner_unique')
      .on(table.communityId)
      .where(sql`${table.standing} = 'OWNER'`),
    // The ordered changefeed: changesSince.
    uniqueIndex('community_members_version_unique').on(table.communityId, table.version),
    // Target of delegated grants' composite key (P3): a grant is bound to one stint.
    unique('community_members_stint_key').on(table.id, table.communityId, table.userId),
    // Roster pages, oldest first.
    index('community_members_roster_idx')
      .on(table.communityId, table.joinedAt, table.userId)
      .where(sql`${table.status} = 'ACTIVE'`),
    // "My communities", newest join first.
    index('community_members_user_idx')
      .on(table.userId, table.joinedAt, table.communityId)
      .where(sql`${table.status} = 'ACTIVE'`),
    // Latest stint per person (statesOf, the rejoin rule): highest version first.
    index('community_members_history_idx').on(
      table.communityId,
      table.userId,
      table.version.desc(),
    ),
    // Who joined through a given — possibly leaked — link.
    index('community_members_invitation_idx')
      .on(table.invitationId)
      .where(sql`${table.invitationId} is not null`),
    check('community_members_status_valid', sql`${table.status} in ('ACTIVE', 'LEFT', 'REMOVED')`),
    check('community_members_standing_valid', sql`${table.standing} in ('OWNER', 'MEMBER')`),
    check('community_members_source_valid', sql`${table.source} in ('ADDED', 'INVITATION')`),
    check('community_members_version_positive', sql`${table.version} > 0`),
    check(
      'community_members_ended_consistent',
      sql`(${table.status} = 'ACTIVE') = (${table.endedAt} is null)`,
    ),
    check(
      'community_members_ended_after_joined',
      sql`${table.endedAt} is null or ${table.endedAt} >= ${table.joinedAt}`,
    ),
    check(
      'community_members_source_consistent',
      sql`(${table.source} = 'INVITATION') = (${table.invitationId} is not null)`,
    ),
    check(
      'community_members_owner_active',
      sql`${table.standing} <> 'OWNER' or ${table.status} = 'ACTIVE'`,
    ),
    check(
      'community_members_left_by_self',
      sql`${table.status} <> 'LEFT' or ${table.endedBy} = ${table.userId}`,
    ),
  ],
);

export type CommunityRow = typeof communities.$inferSelect;
export type CommunityMemberRow = typeof communityMembers.$inferSelect;
export type CommunityInvitationRow = typeof communityInvitations.$inferSelect;
