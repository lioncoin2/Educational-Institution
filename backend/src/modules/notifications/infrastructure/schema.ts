import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import type {
  DevicePlatform,
  NotificationCategory,
  NotificationType,
  PushProviderName,
} from '../contracts/vocabulary';

/**
 * Notifications' tables. Notifications owns them; no other module reads or
 * writes them (dependency-cruiser: this file is private to the module).
 *
 * Account ids (`recipient_user_id`, `user_id`) are NOT foreign keys: accounts
 * belong to identity, and no module holds a constraint on another's tables.
 * Suspending or disabling an account therefore leaves its history alone.
 *
 * The guarantees the database makes, by name:
 *
 *   notifications_dedupe_unique        one notification per source fact and
 *                                      recipient, however often (and however
 *                                      concurrently) the fact is delivered
 *   notification_preferences_pkey      one row of choices per person and category
 *   notification_devices_token_unique  one owner per push token
 */
export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    recipientUserId: text('recipient_user_id').notNull(),
    type: text('type').$type<NotificationType>().notNull(),
    category: text('category').$type<NotificationCategory>().notNull(),
    /** Localized on the client: text is never stored rendered. */
    titleKey: text('title_key').notNull(),
    bodyKey: text('body_key').notNull(),
    params: jsonb('params').$type<Record<string, string | number | boolean>>().notNull(),
    /** A typed reference (`{"kind":"conversation","conversationId":"…"}`), never a URL. */
    target: jsonb('target').$type<Record<string, string>>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    unique('notifications_dedupe_unique').on(table.recipientUserId, table.dedupeKey),
    // The inbox: every page is a range scan of one person's rows, newest
    // first. Ascending on purpose: scanned backwards it yields exactly
    // `ORDER BY created_at DESC, id DESC` (whose default is NULLS FIRST, which
    // a `DESC NULLS LAST` index could not serve without a sort).
    index('notifications_recipient_created_idx').on(
      table.recipientUserId,
      table.createdAt,
      table.id,
    ),
    // Unread only — the badge count and "mark all as read" never touch read rows.
    index('notifications_recipient_unread_idx')
      .on(table.recipientUserId, table.createdAt, table.id)
      .where(sql`${table.readAt} is null`),
    check('notifications_type_shape', sql`${table.type} ~ '^[A-Z][A-Z_]{0,63}$'`),
    check('notifications_category_shape', sql`${table.category} ~ '^[A-Z][A-Z_]{0,31}$'`),
    check(
      'notifications_template_keys_shape',
      sql`${table.titleKey} ~ '^notification\\.[a-z0-9_]{1,40}\\.[a-z0-9_]{1,40}$' and ${table.bodyKey} ~ '^notification\\.[a-z0-9_]{1,40}\\.[a-z0-9_]{1,40}$'`,
    ),
    check('notifications_params_is_object', sql`jsonb_typeof(${table.params}) = 'object'`),
    check(
      'notifications_target_has_kind',
      sql`jsonb_typeof(${table.target}) = 'object' and jsonb_typeof(${table.target} -> 'kind') = 'string'`,
    ),
    check(
      'notifications_dedupe_key_length',
      sql`char_length(${table.dedupeKey}) between 1 and 200`,
    ),
    check(
      'notifications_read_after_created',
      sql`${table.readAt} is null or ${table.readAt} >= ${table.createdAt}`,
    ),
  ],
);

/**
 * A person's choices, one row per category they have changed. No row means
 * the defaults (`domain/preferences.ts`), so a new account costs nothing here.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: text('user_id').notNull(),
    category: text('category').$type<NotificationCategory>().notNull(),
    inApp: boolean('in_app').notNull(),
    realtime: boolean('realtime').notNull(),
    push: boolean('push').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.category] }),
    check(
      'notification_preferences_category_shape',
      sql`${table.category} ~ '^[A-Z][A-Z_]{0,31}$'`,
    ),
  ],
);

/**
 * App installations that receive push. The token is stored because sending
 * needs it; it is never returned, logged, audited or put in an event.
 */
export const notificationDevices = pgTable(
  'notification_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    platform: text('platform').$type<DevicePlatform>().notNull(),
    provider: text('provider').$type<PushProviderName>().notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    unique('notification_devices_token_unique').on(table.provider, table.token),
    // "Where does this person receive push?" — enabled devices only.
    index('notification_devices_user_enabled_idx')
      .on(table.userId, table.lastSeenAt)
      .where(sql`${table.disabledAt} is null`),
    check(
      'notification_devices_platform_valid',
      sql`${table.platform} in ('IOS', 'ANDROID', 'WEB')`,
    ),
    check('notification_devices_provider_valid', sql`${table.provider} in ('APNS', 'FCM')`),
    check(
      'notification_devices_apns_is_ios',
      sql`${table.provider} <> 'APNS' or ${table.platform} = 'IOS'`,
    ),
    check(
      'notification_devices_token_length',
      sql`char_length(${table.token}) between 32 and 1024`,
    ),
  ],
);

/**
 * The institution-wide quiet-hours policy: one row, ever. Quiet hours hold back
 * PUSH in the window; the record is still stored and realtime is untouched. The
 * window is a wall-clock policy, so it carries its own IANA timezone (validated
 * in the application — SQL cannot know the zone database). A person may override
 * it for themselves (`user_notification_settings`).
 *
 *   institution_notification_settings_singleton  at most one policy row exists
 */
export const institutionNotificationSettings = pgTable(
  'institution_notification_settings',
  {
    id: text('id').primaryKey(),
    quietHoursEnabled: boolean('quiet_hours_enabled').notNull(),
    quietHoursStart: text('quiet_hours_start').notNull(),
    quietHoursEnd: text('quiet_hours_end').notNull(),
    timezone: text('timezone').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    /** Who last changed it — an account id, NOT a foreign key. Null for a seed. */
    updatedBy: text('updated_by'),
  },
  (table) => [
    check('institution_notification_settings_singleton', sql`${table.id} = 'institution'`),
    check(
      'institution_notification_settings_window_shape',
      sql`${table.quietHoursStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${table.quietHoursEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      'institution_notification_settings_window_nonempty',
      sql`${table.quietHoursStart} <> ${table.quietHoursEnd}`,
    ),
    check(
      'institution_notification_settings_timezone_length',
      sql`char_length(${table.timezone}) between 1 and 64`,
    ),
  ],
);

/**
 * A person's own notification settings: the timezone their quiet hours are read
 * in, and their quiet-hours choice. One row per person, absent until they
 * change something (then the defaults — `domain/quiet-hours.ts`).
 *
 *   INHERIT    follow the institution window (null start/end)
 *   DISABLED   no quiet hours for me (null start/end)
 *   CUSTOM     my own window (start/end required, and of non-zero length)
 */
export const userNotificationSettings = pgTable(
  'user_notification_settings',
  {
    userId: text('user_id').primaryKey(),
    /** An IANA zone, or null when the user has set none (then the institution's is used). */
    timezone: text('timezone'),
    quietHoursMode: text('quiet_hours_mode').notNull(),
    quietHoursStart: text('quiet_hours_start'),
    quietHoursEnd: text('quiet_hours_end'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'user_notification_settings_mode_valid',
      sql`${table.quietHoursMode} in ('INHERIT', 'DISABLED', 'CUSTOM')`,
    ),
    check(
      'user_notification_settings_timezone_length',
      sql`${table.timezone} is null or char_length(${table.timezone}) between 1 and 64`,
    ),
    // A custom window needs both bounds, of non-zero length; any other mode has none.
    check(
      'user_notification_settings_custom_window',
      sql`(${table.quietHoursMode} = 'CUSTOM' and ${table.quietHoursStart} is not null and ${table.quietHoursEnd} is not null and ${table.quietHoursStart} <> ${table.quietHoursEnd}) or (${table.quietHoursMode} <> 'CUSTOM' and ${table.quietHoursStart} is null and ${table.quietHoursEnd} is null)`,
    ),
    check(
      'user_notification_settings_window_shape',
      sql`(${table.quietHoursStart} is null or ${table.quietHoursStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and (${table.quietHoursEnd} is null or ${table.quietHoursEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')`,
    ),
  ],
);

/**
 * Per-person, per-conversation mutes. A muted conversation's PUSH is held; the
 * record is still stored and realtime is untouched. The conversation id is
 * opaque — stored as a notification's target carries it — and is NOT a foreign
 * key: notifications holds no constraint on messaging's tables.
 *
 *   conversation_mutes_pkey  one mute per person and conversation
 */
export const conversationMutes = pgTable(
  'conversation_mutes',
  {
    userId: text('user_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    mutedAt: timestamp('muted_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.conversationId] }),
    // "What has this person muted?" — newest first.
    index('conversation_mutes_user_idx').on(table.userId, table.mutedAt),
    check(
      'conversation_mutes_conversation_id_length',
      sql`char_length(${table.conversationId}) between 1 and 128`,
    ),
  ],
);
