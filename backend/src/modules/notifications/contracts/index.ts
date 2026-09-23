/**
 * Notifications — one way to reach a person, whatever the channel.
 *
 * Other modules never talk to a push service. There are two ways in:
 *
 *   - publish a domain event; a translator inside this module decides whether
 *     it is worth a notification (how messages arrive today);
 *   - call `NotificationSender` directly with a template and parameters.
 *
 * Either way, what leaves this module is decided here: channel, batching,
 * preferences, quiet hours. None of that is built in V1 — delivery is a
 * logging placeholder until a push provider is chosen (open-questions.md Q24).
 */
export type NotificationChannel = 'in_app' | 'push' | 'email';

export interface NotificationRequest {
  /** One notification, many recipients: a channel post is one request, not ten thousand. */
  readonly recipientUserIds: readonly string[];
  /** Template key, resolved to localized copy inside this module. */
  readonly template: string;
  /**
   * Identifiers and codes. Never message text or personal data: whether a
   * lock screen may show a preview is a policy this module will own (Q24).
   */
  readonly params: Readonly<Record<string, string | number>>;
  /** Groups related notifications so a burst collapses into one. */
  readonly collapseKey?: string;
}

/** Upper bound on recipients per request; senders page larger audiences. */
export const MAX_RECIPIENTS_PER_REQUEST = 1000;

export interface NotificationSender {
  send(request: NotificationRequest): Promise<void>;
}

export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');
