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
 *
 * For a community chat (conversations.community_id set), "current members"
 * means messaging's NAMED PROJECTION of Communities' ACTIVE members: derived,
 * versioned, written only by the projection applier. While its version
 * differs from the community's head, each page is narrowed to the members
 * Communities reports ACTIVE. Every page, whatever readersOnly says, is then
 * narrowed to the accounts holding every permission of
 * COMMUNITY_CHAT_READ_CEILING. An unknown or unreadable community yields an
 * empty page. Delivery modules still never keep a copy.
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
      /**
       * Only members who may READ the conversation now: active accounts whose
       * roles grant `messaging.read` — the two conditions, besides
       * membership, that the HTTP API checks before showing it. For a
       * delivery module that tells people about content, rather than one
       * that relies on its own connection-time check.
       */
      readonly readersOnly?: boolean;
      /**
       * Only these people, if they are members (at most `MAX_RECIPIENT_PAGE`)
       * — "is this person still in it?" without walking everyone.
       */
      readonly onlyUserIds?: readonly string[];
      readonly cursor?: string | null;
      readonly limit: number;
    },
  ): Promise<RecipientPage>;
}
