/** DI token. */
export const MESSAGE_RECIPIENTS = Symbol('MESSAGE_RECIPIENTS');

export interface RecipientPage {
  readonly userIds: readonly string[];
  /** Pass back to continue; null when there are no more. */
  readonly nextCursor: string | null;
}

/** Upper bound on one page, so a 10,000-member channel is walked, never loaded. */
export const MAX_RECIPIENT_PAGE = 1000;

/**
 * Who should hear about activity in a conversation: its CURRENT members.
 *
 * For delivery modules — notifications and realtime — so they never read
 * messaging's tables and never keep a copy of membership that could drift
 * from the real one. Asked at delivery time, it reflects every removal that
 * has committed by then.
 */
export interface MessageRecipients {
  list(
    conversationId: string,
    options: {
      readonly excludeUserId?: string;
      /**
       * Only members who may see the message at this sequence. Someone added
       * to a group after it was sent joins with their history window beyond
       * it; without this they would be told about a message they cannot open.
       */
      readonly visibleSequence?: number;
      readonly cursor?: string | null;
      readonly limit: number;
    },
  ): Promise<RecipientPage>;
}
