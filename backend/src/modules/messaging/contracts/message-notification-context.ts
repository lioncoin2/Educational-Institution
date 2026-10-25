/** DI token. */
export const MESSAGE_NOTIFICATION_CONTEXT = Symbol('MESSAGE_NOTIFICATION_CONTEXT');

/** Upper bound on references per call — an inbox page is far smaller. */
export const MAX_NOTIFICATION_CONTEXT_REFS = 100;

/** A conversation a notification is about, and the message, when it is about one. */
export interface NotificationContextRef {
  readonly conversationId: string;
  readonly messageId: string | null;
}

/** What one recipient may be shown of a conversation and a message, as of now. */
export interface NotificationContext {
  readonly conversationId: string;
  readonly messageId: string | null;
  /**
   * The group's or channel's title, a community chat's community title; null
   * for a direct conversation (its sender's name says who) or no title.
   */
  readonly conversationTitle: string | null;
  /**
   * The start of the message's text — a TEXT body, a media caption — as the
   * conversation list previews it; null when there is none, the message is
   * deleted, or the reference names no message.
   */
  readonly messagePreview: string | null;
}

/**
 * What a notification may SAY about messaging content (ADR 0046), decided
 * where the content can be read — messaging — at the moment it is shown, never
 * copied into a notification when it is created.
 *
 * A context is returned only for references the recipient may read NOW: a
 * current member (a community chat: Communities' ACTIVE member, holding the
 * chat read ceiling), whose account may read messages, whose history window
 * includes the message. A removed member, a revoked account, a reference to
 * a message from before someone joined, an unknown conversation — none of
 * these returns anything, so the notification falls back to its content-free
 * wording. A deleted message returns no preview; an edited one, its new text.
 *
 * No principal: like `MESSAGE_RECIPIENTS`, this serves trusted in-process
 * delivery code (the inbox and the realtime notification frame), which may
 * hand a context ONLY to the recipient it was asked for.
 */
export interface MessageNotificationContext {
  forRecipient(
    recipientUserId: string,
    refs: readonly NotificationContextRef[],
  ): Promise<readonly NotificationContext[]>;
}
