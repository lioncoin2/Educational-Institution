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
 * For delivery modules — notifications today, a realtime gateway later — so
 * they never read messaging's tables and never keep a copy of membership that
 * could drift from the real one.
 */
export interface MessageRecipients {
  list(
    conversationId: string,
    options: {
      readonly excludeUserId?: string;
      readonly cursor?: string | null;
      readonly limit: number;
    },
  ): Promise<RecipientPage>;
}
