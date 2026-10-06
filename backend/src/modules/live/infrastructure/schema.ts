import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import {
  LIVE_SESSION_END_REASONS,
  LIVE_SESSION_STATES,
  type LiveSessionEndReason,
  type LiveSessionState,
} from '../domain/live-session';
import { MODERATION_ACTION_TYPES, type ModerationActionType } from '../domain/moderation';
import { PRESENTER_END_REASONS, type PresenterEndReason } from '../domain/presenter-grant';
import { SPEAKER_REQUEST_STATES, type SpeakerRequestState } from '../domain/speaker-request';

/**
 * Live's tables (live.md §10.1; P6 audit §10). Live owns them; no other
 * module reads or writes them, and only live/infrastructure's adapters touch
 * them.
 *
 * No key leaves Live's tables: `community_id` is Communities' opaque id and
 * every account id (`host_user_id`, `user_id`, `*_by`, `*_user_id`) is
 * identity's, both plain text — no module holds a constraint on another's
 * tables, and Communities stays the membership authority. Inside Live the
 * keys are real and RESTRICT: `session_id` → `live_sessions`, because nothing
 * is deleted (Q3) and nothing a session's history refers to can vanish.
 *
 * The guarantees the database makes, by name:
 *
 *   live_sessions_one_live_per_community        at most one live session per community (S1)
 *   live_sessions_ended_at_consistent           live exactly while ended_at is null (S2)
 *   live_sessions_end_reason_consistent         …and exactly while end_reason is null (S2)
 *   live_sessions_moderator_end_named           a moderator's end names the moderator (S2)
 *   live_sessions_ended_by_needs_end            nobody has ended a live session
 *   live_speaker_requests_one_open_per_person   one open request per person and session (R1)
 *   live_speaker_requests_decided_at_consistent decided exactly when no longer pending
 *   live_speaker_requests_decided_by_consistent a person decides, except pending and expired (R3)
 *   live_speaker_requests_granted_at_set        a granted request says since when
 *   live_presenter_grants_one_open_per_session  at most one open presenter grant (P1) — a
 *                                               backstop: a claim reads the slot under the
 *                                               session's lock first
 *   live_presenter_grants_end_consistent        closed exactly when it says why
 *   live_presenter_grants_ended_by_needs_end    nobody has closed an open grant
 *   live_moderation_actions_reason_code_shape   a reason is a code, never free text
 *   live_*_valid                                every enumerated column, its list generated
 *                                               from the domain's constant, never retyped
 *
 * `ended` is terminal (S3) and nothing changes a session's hands, floor or
 * presenter after End (S4): the adapter's every update is `WHERE state =
 * 'live'`, under the session row's lock. There is no time-ordering CHECK:
 * every instant comes from the injected clock, and a clock may step back.
 *
 * `participant_cap` has no upper bound: it is configuration, copied at start,
 * never a community's size (§12). It and `moderator_reserve` are bigint, so
 * every whole number configuration and the domain accept is stored as given:
 * an integer column would refuse every start above 2,147,483,647, which mock
 * mode accepts. `state_version` is bigint, as Communities' versions are: it
 * only ever grows, one step per change a moderator can observe, and a session
 * has no maximum duration (Q61) — so no count of its changes can be promised
 * to fit in 32 bits.
 */

/** A vocabulary as a SQL list — generated from the domain's constant, never retyped. */
const listOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

export const liveSessions = pgTable(
  'live_sessions',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id').notNull(),
    hostUserId: text('host_user_id').notNull(),
    state: text('state').$type<LiveSessionState>().notNull(),
    stateVersion: bigint('state_version', { mode: 'number' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: text('ended_by'),
    endReason: text('end_reason').$type<LiveSessionEndReason>(),
    participantCap: bigint('participant_cap', { mode: 'number' }).notNull(),
    moderatorReserve: bigint('moderator_reserve', { mode: 'number' }).notNull(),
    mediaRoomEpoch: integer('media_room_epoch').notNull().default(0),
    // The reconciler's bookkeeping (§11.2, §11.4).
    emptySince: timestamp('empty_since', { withTimezone: true }),
    enforcementViolations: integer('enforcement_violations').notNull().default(0),
    lastViolationAt: timestamp('last_violation_at', { withTimezone: true }),
  },
  (table) => [
    // One live session per community (S1, Q55): the arbiter of racing starts.
    uniqueIndex('live_sessions_one_live_per_community')
      .on(table.communityId)
      .where(sql`${table.state} = 'live'`),
    // A community's sessions, newest first — its history. Plain DESC, which
    // is NULLS FIRST, as `ORDER BY started_at DESC, id DESC` reads: drizzle's
    // `.desc()` alone writes DESC NULLS LAST, which that order cannot use
    // without a sort, NOT NULL columns or not.
    index('live_sessions_community_history_idx').on(
      table.communityId,
      table.startedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // The live sessions in (started_at, id) order — the reconciler's keyset pages.
    index('live_sessions_live_page_idx')
      .on(table.startedAt, table.id)
      .where(sql`${table.state} = 'live'`),
    check('live_sessions_state_valid', sql`${table.state} in (${listOf(LIVE_SESSION_STATES)})`),
    check(
      'live_sessions_end_reason_valid',
      sql`${table.endReason} in (${listOf(LIVE_SESSION_END_REASONS)})`,
    ),
    check('live_sessions_state_version_positive', sql`${table.stateVersion} >= 1`),
    check('live_sessions_participant_cap_positive', sql`${table.participantCap} > 0`),
    check('live_sessions_moderator_reserve_nonnegative', sql`${table.moderatorReserve} >= 0`),
    check('live_sessions_media_room_epoch_nonnegative', sql`${table.mediaRoomEpoch} >= 0`),
    check(
      'live_sessions_enforcement_violations_nonnegative',
      sql`${table.enforcementViolations} >= 0`,
    ),
    check(
      'live_sessions_ended_at_consistent',
      sql`(${table.state} = 'live') = (${table.endedAt} is null)`,
    ),
    check(
      'live_sessions_end_reason_consistent',
      sql`(${table.state} = 'live') = (${table.endReason} is null)`,
    ),
    check(
      'live_sessions_moderator_end_named',
      sql`${table.endReason} is distinct from 'moderator' or ${table.endedBy} is not null`,
    ),
    check(
      'live_sessions_ended_by_needs_end',
      sql`${table.endedBy} is null or ${table.endedAt} is not null`,
    ),
  ],
);

export const liveSpeakerRequests = pgTable(
  'live_speaker_requests',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => liveSessions.id, { onDelete: 'restrict' }),
    userId: text('user_id').notNull(),
    state: text('state').$type<SpeakerRequestState>().notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
  },
  (table) => [
    // One open request per person and session (R1): the arbiter of racing raises.
    uniqueIndex('live_speaker_requests_one_open_per_person')
      .on(table.sessionId, table.userId)
      .where(sql`${table.state} in ('pending', 'granted')`),
    // The pending queue, first come first served (R4) — the hands page's keyset.
    index('live_speaker_requests_queue_idx')
      .on(table.sessionId, table.requestedAt, table.id)
      .where(sql`${table.state} = 'pending'`),
    // The floor: the cap's count and the granted hands (at most four).
    index('live_speaker_requests_granted_idx')
      .on(table.sessionId)
      .where(sql`${table.state} = 'granted'`),
    // Floors lost at or after an instant — the targeted watch.
    index('live_speaker_requests_floor_closed_idx')
      .on(table.sessionId, table.decidedAt)
      .where(
        sql`${table.grantedAt} is not null and ${table.state} in ('revoked', 'withdrawn', 'expired')`,
      ),
    check(
      'live_speaker_requests_state_valid',
      sql`${table.state} in (${listOf(SPEAKER_REQUEST_STATES)})`,
    ),
    check(
      'live_speaker_requests_decided_at_consistent',
      sql`(${table.state} = 'pending') = (${table.decidedAt} is null)`,
    ),
    check(
      'live_speaker_requests_decided_by_consistent',
      sql`(${table.state} in ('pending', 'expired')) = (${table.decidedBy} is null)`,
    ),
    check(
      'live_speaker_requests_granted_at_set',
      sql`${table.state} <> 'granted' or ${table.grantedAt} is not null`,
    ),
  ],
);

export const livePresenterGrants = pgTable(
  'live_presenter_grants',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => liveSessions.id, { onDelete: 'restrict' }),
    userId: text('user_id').notNull(),
    grantedBy: text('granted_by').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: text('ended_by'),
    endReason: text('end_reason').$type<PresenterEndReason>(),
  },
  (table) => [
    // At most one OPEN grant per person per session (Q56): the per-user
    // backstop the session lock makes unreachable. The ≤ MAX_CONCURRENT_PRESENTERS
    // cap is counted under that lock, exactly as the speaker floor is — not by
    // a unique index, which cannot express a count.
    uniqueIndex('live_presenter_grants_one_open_per_user')
      .on(table.sessionId, table.userId)
      .where(sql`${table.endedAt} is null`),
    // Grants closed at or after an instant — the targeted watch.
    index('live_presenter_grants_closed_idx').on(table.sessionId, table.endedAt),
    check(
      'live_presenter_grants_end_reason_valid',
      sql`${table.endReason} in (${listOf(PRESENTER_END_REASONS)})`,
    ),
    check(
      'live_presenter_grants_end_consistent',
      sql`(${table.endedAt} is null) = (${table.endReason} is null)`,
    ),
    check(
      'live_presenter_grants_ended_by_needs_end',
      sql`${table.endedBy} is null or ${table.endedAt} is not null`,
    ),
  ],
);

export const liveModerationActions = pgTable(
  'live_moderation_actions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => liveSessions.id, { onDelete: 'restrict' }),
    /** Null when the system acted: an idle end, a community closing, a media reset. */
    actorUserId: text('actor_user_id'),
    targetUserId: text('target_user_id'),
    type: text('type').$type<ModerationActionType>().notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    reasonCode: text('reason_code'),
  },
  (table) => [
    // A session's record, oldest first.
    index('live_moderation_actions_session_idx').on(table.sessionId, table.at, table.id),
    check(
      'live_moderation_actions_type_valid',
      sql`${table.type} in (${listOf(MODERATION_ACTION_TYPES)})`,
    ),
    check(
      'live_moderation_actions_reason_code_shape',
      sql`${table.reasonCode} is null or ${table.reasonCode} ~ '^[a-z][a-z0-9_.]{0,63}$'`,
    ),
  ],
);

export type LiveSessionRow = typeof liveSessions.$inferSelect;
export type SpeakerRequestRow = typeof liveSpeakerRequests.$inferSelect;
export type PresenterGrantRow = typeof livePresenterGrants.$inferSelect;
export type ModerationActionRow = typeof liveModerationActions.$inferSelect;
