/**
 * Where a notification physically goes. The push provider (FCM, APNs, web
 * push) will be an adapter behind this port; V1's adapter only logs.
 */
export interface OutboundNotification {
  readonly recipientUserIds: readonly string[];
  readonly template: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly collapseKey: string | null;
}

export interface NotificationDelivery {
  deliver(notification: OutboundNotification): Promise<void>;
}

export const NOTIFICATION_DELIVERY = Symbol('NOTIFICATION_DELIVERY');
