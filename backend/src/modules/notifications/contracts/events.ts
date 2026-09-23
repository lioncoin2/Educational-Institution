import type { DomainEvent } from '../../../shared/domain-event';
import type { NotificationType } from './vocabulary';

/**
 * Facts notifications publishes — after the database has them. Delivery
 * modules subscribe (realtime; this module's own push delivery); nothing
 * about delivery is decided by the code that stores a notification.
 *
 * Payloads carry identifiers, codes and flags only — never a notification's
 * text parameters, which may hold a person's name. A subscriber that needs
 * the notification itself asks `NOTIFICATION_READER`.
 *
 * Every event's `aggregateId` is the RECIPIENT's user id: one person's
 * notifications are one stream, so their order survives any future
 * partitioned transport.
 */
export const NotificationEvents = {
  created: 'notifications.notification.created',
  read: 'notifications.notification.read',
  allRead: 'notifications.notification.all_read',
} as const;

/**
 * One notification was stored — once: a duplicate of an earlier one (the same
 * source fact delivered twice) is not stored and publishes nothing, so this
 * event is the idempotency boundary for everything downstream.
 */
export type NotificationCreated = DomainEvent<
  typeof NotificationEvents.created,
  {
    readonly notificationId: string;
    readonly recipientUserId: string;
    readonly type: NotificationType;
    /** Whether the recipient's preferences, when it was stored, allowed each delivery channel. */
    readonly channels: { readonly realtime: boolean; readonly push: boolean };
  }
>;

/** One notification went from unread to read. Marking it again publishes nothing. */
export type NotificationRead = DomainEvent<
  typeof NotificationEvents.read,
  {
    readonly recipientUserId: string;
    readonly notificationId: string;
    /** ISO 8601. */
    readonly readAt: string;
  }
>;

/**
 * Everything up to a boundary was marked read at once. The boundary is a
 * position in the recipient's list — `(createdAt, id)`, newest first — so a
 * notification that arrived after the person pressed "mark all" stays unread.
 */
export type AllNotificationsRead = DomainEvent<
  typeof NotificationEvents.allRead,
  {
    readonly recipientUserId: string;
    /** ISO 8601: notifications created before this instant are read… */
    readonly throughCreatedAt: string;
    /** …and those created AT it, with an id up to this one (null: all of them). */
    readonly throughId: string | null;
    readonly readAt: string;
    /** How many went from unread to read. */
    readonly count: number;
  }
>;

export type NotificationEvent = NotificationCreated | NotificationRead | AllNotificationsRead;
