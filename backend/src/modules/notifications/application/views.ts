import type { NotificationView } from '../contracts/notification-reader';
import type { NotificationCategory } from '../contracts/vocabulary';
import type { ConversationMute } from '../domain/conversation-mute';
import type { Device } from '../domain/device';
import type { Notification } from '../domain/notification';
import type { ChannelPreferences } from '../domain/preferences';
import type { InstitutionQuietHours, UserNotificationSettings } from '../domain/quiet-hours';

export type { NotificationView };

/** A notification as its recipient sees it: everything but the deduplication key. */
export function toNotificationView(notification: Notification): NotificationView {
  return {
    id: notification.id,
    recipientUserId: notification.recipientUserId,
    type: notification.type,
    category: notification.category,
    titleKey: notification.titleKey,
    bodyKey: notification.bodyKey,
    params: notification.params,
    target: notification.target,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
  };
}

export interface UnreadCountView {
  /** Up to the cap… */
  readonly count: number;
  /** …and true when there are more: show "99+". */
  readonly capped: boolean;
}

export interface CategoryPreferencesView extends ChannelPreferences {
  readonly category: NotificationCategory;
}

/**
 * A registered device as its owner sees it. The token is deliberately absent:
 * the app already has it, and nothing else should.
 */
export interface DeviceView {
  readonly id: string;
  readonly platform: Device['platform'];
  readonly provider: Device['provider'];
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export function toDeviceView(device: Device): DeviceView {
  return {
    id: device.id,
    platform: device.platform,
    provider: device.provider,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

/** The institution quiet-hours policy, or null when none is configured. */
export interface InstitutionQuietHoursView {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
}

export function toInstitutionQuietHoursView(
  settings: InstitutionQuietHours,
): InstitutionQuietHoursView {
  return {
    enabled: settings.enabled,
    start: settings.window.start,
    end: settings.window.end,
    timezone: settings.timezone,
  };
}

/** A person's own notification settings — their timezone and quiet-hours choice. */
export interface UserNotificationSettingsView {
  readonly timezone: string | null;
  readonly quietHoursMode: 'INHERIT' | 'DISABLED' | 'CUSTOM';
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
}

export function toUserNotificationSettingsView(
  settings: UserNotificationSettings,
): UserNotificationSettingsView {
  const custom = settings.quietHours.mode === 'CUSTOM' ? settings.quietHours.window : null;
  return {
    timezone: settings.timezone,
    quietHoursMode: settings.quietHours.mode,
    quietHoursStart: custom?.start ?? null,
    quietHoursEnd: custom?.end ?? null,
  };
}

export interface MutedConversationView {
  readonly conversationId: string;
  readonly mutedAt: Date;
}

export function toMutedConversationView(mute: ConversationMute): MutedConversationView {
  return { conversationId: mute.conversationId, mutedAt: mute.mutedAt };
}
