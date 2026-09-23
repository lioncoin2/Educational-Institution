import type { NotificationParams, NotificationTarget } from './targets';
import type { NotificationCategory, NotificationType } from './vocabulary';

/** DI token. */
export const NOTIFICATION_READER = Symbol('NOTIFICATION_READER');

/**
 * A stored notification as its recipient sees it — the HTTP API and the
 * realtime frame render exactly this.
 *
 * Text is never stored rendered: `titleKey` and `bodyKey` name localized
 * templates the client owns, and `params` fill them. So a notification reads
 * correctly in whatever language the app is showing, and wording can change
 * without rewriting history.
 */
export interface NotificationView {
  readonly id: string;
  readonly recipientUserId: string;
  readonly type: NotificationType;
  readonly category: NotificationCategory;
  /** e.g. `notification.message_received.title`. */
  readonly titleKey: string;
  /** e.g. `notification.message_received.body`. */
  readonly bodyKey: string;
  readonly params: NotificationParams;
  readonly target: NotificationTarget;
  readonly createdAt: Date;
  /** Null while unread. */
  readonly readAt: Date | null;
}

/** Upper bound on ids per call; callers with more ask in chunks. */
export const NOTIFICATION_READER_MAX_IDS = 1000;

/**
 * Stored notifications, for the modules that DELIVER them (realtime today).
 *
 * No principal: this serves trusted in-process delivery code, which learns
 * ids from `notifications.notification.created` and may hand each view ONLY
 * to its `recipientUserId`. A notification is personal — there is no
 * audience to compute.
 */
export interface NotificationReader {
  /** The notifications that exist among `ids`; unknown ids are simply absent. */
  forDelivery(ids: readonly string[]): Promise<readonly NotificationView[]>;
}
