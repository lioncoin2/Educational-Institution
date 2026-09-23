/**
 * Messaging — direct conversations, groups and channels.
 *
 * The contracts are shaped so the features listed as "later" (reactions, edits,
 * deletions, threads, pins, search) are additive: a message carries an id, an
 * optional parent for threading, and a list of attachment references rather than
 * inline payloads. None of those features are implemented yet.
 */
export type ConversationType = 'direct' | 'group' | 'channel';

export type MessageKind = 'text' | 'voice' | 'image' | 'file' | 'system';

export interface ConversationRef {
  readonly conversationId: string;
  readonly type: ConversationType;
}

export interface MessageRef {
  readonly messageId: string;
  readonly conversationId: string;
  readonly senderUserId: string;
  readonly kind: MessageKind;
  /** Set when the message is a reply — the seam threading will use. */
  readonly inReplyToMessageId: string | null;
}

/**
 * Attachments are references to Files assets, never bytes. A message row stays
 * small, and media lifecycle (retention, deletion) belongs to one module.
 */
export interface MessageAttachmentRef {
  readonly fileAssetId: string;
}

/** Read state is per participant, which is what makes unread counts cheap. */
export interface ReadReceipt {
  readonly conversationId: string;
  readonly userId: string;
  readonly lastReadMessageId: string | null;
}
