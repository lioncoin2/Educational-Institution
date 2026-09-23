/**
 * Notifications — one way to reach a person, whatever the channel.
 *
 * Other modules never talk to a push service. They describe *what happened and
 * to whom*; this module decides channel, batching and quiet hours.
 */
export type NotificationChannel = 'in_app' | 'push' | 'email';

export interface NotificationRequest {
  readonly recipientUserId: string;
  /** Template key, resolved to localized copy inside this module. */
  readonly template: string;
  readonly params: Readonly<Record<string, string | number>>;
  /** Groups related notifications so a burst collapses into one. */
  readonly collapseKey?: string;
}

export interface NotificationSender {
  send(request: NotificationRequest): Promise<void>;
}

export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');
