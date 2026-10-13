import type { NotificationCategory } from '../contracts/vocabulary';
import type { ConversationMute } from './conversation-mute';
import type { Device, DeviceId, DeviceRegistration } from './device';
import type { Notification, NotificationId } from './notification';
import type { ChannelPreferences, StoredPreferences } from './preferences';
import type { InstitutionQuietHours, UserNotificationSettings } from './quiet-hours';

/** A position in one person's list: newest first, ties broken by id. */
export interface NotificationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Notifications, as stored. Every read and write is scoped to ONE recipient
 * — there is no method that lists or changes another person's — except
 * `insertMany` and `findByIds`, which serve the dispatcher and delivery.
 */
export interface NotificationRepository {
  /**
   * Stores each notification whose `(recipientUserId, dedupeKey)` is new and
   * returns exactly those. A duplicate — the same fact delivered again, even
   * concurrently — is skipped by the database's unique constraint, never an
   * error and never a second row.
   */
  insertMany(notifications: readonly Notification[]): Promise<readonly Notification[]>;

  /** One page, newest first, strictly after `after` when given. */
  list(
    recipientUserId: string,
    page: { readonly limit: number; readonly after?: NotificationCursor },
  ): Promise<{ readonly items: readonly Notification[]; readonly next: NotificationCursor | null }>;

  /** Unread notifications, counted up to `cap` and no further. */
  countUnread(recipientUserId: string, cap: number): Promise<number>;

  find(recipientUserId: string, id: string): Promise<Notification | null>;

  /**
   * Sets `readAt` if it is not set. Null when the recipient has no such
   * notification; `changed` false when it was read already.
   */
  markRead(
    recipientUserId: string,
    id: string,
    at: Date,
  ): Promise<{ readonly notification: Notification; readonly changed: boolean } | null>;

  /**
   * Marks read at most `limit` unread notifications at or before `through`
   * (by createdAt, then id; `through.id` null: everything created at or
   * before `through.createdAt`). Returns how many it changed — fewer than
   * `limit` means none are left.
   */
  markReadThrough(
    recipientUserId: string,
    through: { readonly createdAt: Date; readonly id: string | null },
    at: Date,
    limit: number,
  ): Promise<number>;

  /** For delivery: the notifications among `ids` that exist. */
  findByIds(ids: readonly string[]): Promise<readonly Notification[]>;
}

export interface PreferenceRepository {
  /** Stored choices of each person among `userIds`; people with none are absent. */
  forUsers(userIds: readonly string[]): Promise<ReadonlyMap<string, StoredPreferences>>;
  save(
    userId: string,
    category: NotificationCategory,
    preferences: ChannelPreferences,
    at: Date,
  ): Promise<void>;
}

export interface DeviceRepository {
  /**
   * Registers a token for `userId`, or refreshes it: one row per
   * `(provider, token)`. A token another account registered moves to this
   * one — `previousUserId` says whose it was. A disabled token is enabled.
   */
  register(input: {
    readonly id: DeviceId;
    readonly userId: string;
    readonly registration: DeviceRegistration;
    readonly at: Date;
  }): Promise<{ readonly device: Device; readonly previousUserId: string | null }>;

  find(userId: string, id: string): Promise<Device | null>;

  /** Forgets the device if it is this user's, and returns what it was. */
  remove(userId: string, id: string): Promise<Device | null>;

  /**
   * Keeps a user's `max` most recently seen enabled devices and forgets the
   * rest. Returns the forgotten ones.
   */
  trim(userId: string, max: number): Promise<readonly Device[]>;

  /** Enabled devices of these users, for sending. */
  enabledForUsers(userIds: readonly string[]): Promise<readonly Device[]>;

  /** The provider said this token is dead: push skips it from now on. */
  disable(id: DeviceId, at: Date): Promise<void>;
}

/**
 * The institution-wide quiet-hours policy and each person's own settings
 * (their timezone and quiet-hours override). The institution row is a
 * singleton; a person with no row uses the defaults
 * (`DEFAULT_USER_NOTIFICATION_SETTINGS`), so a new account costs nothing here.
 */
export interface NotificationSettingsRepository {
  /** The institution policy, or null when none has been configured. */
  institution(): Promise<InstitutionQuietHours | null>;
  /** Stores the institution policy (one row), recording who last changed it. */
  saveInstitution(
    settings: InstitutionQuietHours,
    at: Date,
    updatedBy: string | null,
  ): Promise<void>;
  /** Settings of each person among `userIds`; people with none are absent. */
  settingsForUsers(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, UserNotificationSettings>>;
  /** One person's settings, the defaults when they have set none. */
  getUserSettings(userId: string): Promise<UserNotificationSettings>;
  saveUserSettings(userId: string, settings: UserNotificationSettings, at: Date): Promise<void>;
}

/**
 * Per-person, per-conversation mutes. Every read and write is scoped to ONE
 * person — there is no method that reads or changes another's. A mute is
 * opaque: the conversation id is stored as given, exactly as a notification's
 * target carries it, and notifications holds no constraint on messaging's
 * tables.
 */
export interface ConversationMuteRepository {
  /** The set of conversation ids each person has muted; people with none are absent. */
  mutedConversationsForUsers(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /** One person's muted conversations, newest first. */
  listMuted(userId: string): Promise<readonly ConversationMute[]>;
  /** Mutes a conversation for a person; idempotent. `created` false if already muted. */
  mute(userId: string, conversationId: string, at: Date): Promise<{ readonly created: boolean }>;
  /** Unmutes; `removed` false when it was not muted. */
  unmute(userId: string, conversationId: string): Promise<{ readonly removed: boolean }>;
}

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
export const PREFERENCE_REPOSITORY = Symbol('PREFERENCE_REPOSITORY');
export const DEVICE_REPOSITORY = Symbol('DEVICE_REPOSITORY');
export const NOTIFICATION_SETTINGS_REPOSITORY = Symbol('NOTIFICATION_SETTINGS_REPOSITORY');
export const CONVERSATION_MUTE_REPOSITORY = Symbol('CONVERSATION_MUTE_REPOSITORY');

export type { NotificationId };
