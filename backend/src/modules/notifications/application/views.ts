import type { NotificationView } from '../contracts/notification-reader';
import type { NotificationCategory } from '../contracts/vocabulary';
import type { Device } from '../domain/device';
import type { Notification } from '../domain/notification';
import type { ChannelPreferences } from '../domain/preferences';

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
