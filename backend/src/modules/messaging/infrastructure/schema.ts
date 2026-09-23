import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import type { ConversationType, MessageType, ParticipantRole } from '../contracts/vocabulary';

/**
 * Messaging's tables. Messaging owns them; no other module reads or writes
 * them (enforced by dependency-cruiser — this file is private to the module).
 *
 * Account ids (`created_by`, `user_id`, `sender_id`, …) and file ids are NOT
 * foreign keys: those rows belong to identity and files, and no module holds a
 * constraint on another's tables. Inside messaging, the keys are real.
 *
 * The guarantees the brief asks the DATABASE to make are here, by name:
 *
 *   conversations_direct_pair_unique   one direct conversation per pair
 *   conversation_participants_pkey     one membership row per person
 *   messages_conversation_sequence_unique   one message per position
 *   messages_idempotency_unique        one message per client retry key
 *
 * Sequences are bigint (mode "number": exact to 2^53, far beyond any chat).
 */
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    type: text('type').$type<ConversationType>().notNull(),
    title: text('title'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** DIRECT only, ordered low < high. NULLs never collide, so other types are exempt. */
    directUserLow: text('direct_user_low'),
    directUserHigh: text('direct_user_high'),
    /** The ordering authority: the last sequence handed out. */
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    /** Current members, maintained in the same transactions as membership. */
    memberCount: integer('member_count').notNull().default(0),
  },
  (table) => [
    unique('conversations_direct_pair_unique').on(table.directUserLow, table.directUserHigh),
    check('conversations_type_valid', sql`${table.type} in ('DIRECT', 'GROUP', 'CHANNEL')`),
    check(
      'conversations_direct_pair_shape',
      sql`(${table.directUserLow} is null) = (${table.directUserHigh} is null) and (${table.type} = 'DIRECT') = (${table.directUserLow} is not null) and (${table.directUserLow} is null or ${table.directUserLow} < ${table.directUserHigh})`,
    ),
    check(
      'conversations_title_shape',
      sql`(${table.type} = 'DIRECT') = (${table.title} is null) and (${table.title} is null or char_length(${table.title}) between 1 and 100)`,
    ),
    check('conversations_sequence_nonnegative', sql`${table.lastSequence} >= 0`),
    check('conversations_member_count_nonnegative', sql`${table.memberCount} >= 0`),
    check(
      'conversations_activity_consistent',
      sql`(${table.lastSequence} = 0) = (${table.lastMessageAt} is null)`,
    ),
  ],
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').$type<ParticipantRole>().notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when they leave or are removed. Rejoining clears it and restarts the window. */
    leftAt: timestamp('left_at', { withTimezone: true }),
    addedBy: text('added_by'),
    lastReadSequence: bigint('last_read_sequence', { mode: 'number' }).notNull().default(0),
    hiddenThroughSequence: bigint('hidden_through_sequence', { mode: 'number' })
      .notNull()
      .default(0),
  },
  (table) => [
    // Also serves "members of this conversation, by user id" (fan-out paging).
    primaryKey({ columns: [table.conversationId, table.userId] }),
    // "My conversations": a person's current memberships only.
    index('conversation_participants_user_current_idx')
      .on(table.userId)
      .where(sql`${table.leftAt} is null`),
    check(
      'conversation_participants_role_valid',
      sql`${table.role} in ('OWNER', 'PUBLISHER', 'MEMBER')`,
    ),
    // The read-state invariant (see participant.ts); the upper bound — the
    // conversation's last sequence — is enforced by the one UPDATE that moves it.
    check(
      'conversation_participants_read_state_valid',
      sql`${table.hiddenThroughSequence} >= 0 and ${table.lastReadSequence} >= ${table.hiddenThroughSequence}`,
    ),
    check(
      'conversation_participants_left_after_joined',
      sql`${table.leftAt} is null or ${table.leftAt} >= ${table.joinedAt}`,
    ),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    // RESTRICT: a conversation that holds messages cannot be hard-deleted by
    // accident. Retention, when designed, will do it deliberately.
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    senderId: text('sender_id').notNull(),
    type: text('type').$type<MessageType>().notNull(),
    body: text('body'),
    replyToMessageId: text('reply_to_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'restrict',
    }),
    clientMessageId: text('client_message_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // The timeline index: every page, unread count and "last message" is a
    // range scan on it.
    unique('messages_conversation_sequence_unique').on(table.conversationId, table.sequence),
    unique('messages_idempotency_unique').on(
      table.conversationId,
      table.senderId,
      table.clientMessageId,
    ),
    check('messages_type_valid', sql`${table.type} in ('TEXT', 'VOICE', 'IMAGE', 'FILE')`),
    check('messages_sequence_positive', sql`${table.sequence} > 0`),
    check(
      'messages_body_length',
      sql`${table.body} is null or char_length(${table.body}) between 1 and 4000`,
    ),
    check(
      'messages_text_has_body',
      sql`${table.type} <> 'TEXT' or ${table.body} is not null or ${table.deletedAt} is not null`,
    ),
    check(
      'messages_client_message_id_shape',
      sql`${table.clientMessageId} ~ '^[A-Za-z0-9_-]{8,64}$'`,
    ),
    check(
      'messages_lifecycle_after_creation',
      sql`(${table.editedAt} is null or ${table.editedAt} >= ${table.createdAt}) and (${table.deletedAt} is null or ${table.deletedAt} >= ${table.createdAt})`,
    ),
  ],
);

/**
 * A message's files, by reference. The asset's metadata and bytes stay in the
 * files module; this row only says "this message carries that file, here".
 */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    fileAssetId: text('file_asset_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.position] }),
    check('message_attachments_position_valid', sql`${table.position} between 0 and 9`),
  ],
);
