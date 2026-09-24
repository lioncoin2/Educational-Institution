import type { ParticipantRole } from '../contracts/vocabulary';
import type { ApplyCounts, CommunityMemberState } from './community-chat';
import type { Conversation, ConversationId, NewConversation } from './conversation';
import type { Message, MessageDraft, MessageId } from './message';
import type { Participant } from './participant';

export type CreateDirectOutcome =
  | { readonly created: true; readonly conversation: Conversation }
  | { readonly created: false; readonly conversation: Conversation };

export type AppendOutcome =
  /** Stored with the next sequence. */
  | { readonly kind: 'appended'; readonly message: Message }
  /** A retry of a send that already succeeded: the original, untouched. */
  | { readonly kind: 'duplicate'; readonly message: Message }
  /** The key was used before for DIFFERENT content. */
  | { readonly kind: 'key_reused' }
  /** The sender is not (or no longer) a current member. */
  | { readonly kind: 'not_participant' };

export type AddParticipantsOutcome =
  | {
      readonly kind: 'added';
      readonly added: readonly Participant[];
      /** Already current members — left as they were. */
      readonly unchanged: readonly string[];
    }
  | { readonly kind: 'capacity_exceeded'; readonly capacity: number; readonly memberCount: number }
  | { readonly kind: 'conversation_not_found' };

export type MarkReadOutcome =
  | { readonly kind: 'advanced'; readonly lastReadSequence: number }
  | { readonly kind: 'unchanged'; readonly lastReadSequence: number }
  | { readonly kind: 'not_participant' };

export type ApplyMembershipOutcome =
  | (ApplyCounts & {
      readonly kind: 'applied';
      /** The projection's version after the apply (it may have been further already). */
      readonly projectedVersion: number;
      readonly memberCount: number;
    })
  | { readonly kind: 'conversation_not_found' }
  | { readonly kind: 'not_community_chat' };

/** Which conversation is a community's chat, and how far its projection reaches. */
export interface CommunityChatRef {
  readonly conversationId: ConversationId;
  readonly communityId: string;
  readonly projectedVersion: number;
}

/** One projection row as the reconciler compares it with the authority. */
export interface ProjectionRow {
  readonly userId: string;
  readonly active: boolean;
  readonly sourceVersion: number | null;
  readonly sourceMembershipId: string | null;
  readonly sourceJoinedAt: Date | null;
}

/**
 * The write side. Every method that changes a conversation's membership or
 * appends to it runs as ONE transaction holding that conversation's row lock,
 * so membership changes, sends and caps are serialized per conversation and
 * each method's guarantee holds under concurrency — not just in sequence.
 */
export interface MessagingRepository {
  /** Group or channel, with its initial participants, atomically. */
  createConversation(input: NewConversation): Promise<void>;

  /**
   * The direct conversation for this pair — created with its two members, or
   * the one that already exists. Two simultaneous calls for one pair return
   * the same conversation: the database's uniqueness on the pair decides.
   */
  createDirectConversation(input: NewConversation): Promise<CreateDirectOutcome>;

  findConversation(id: ConversationId): Promise<Conversation | null>;
  findParticipant(conversationId: ConversationId, userId: string): Promise<Participant | null>;
  findMessage(conversationId: ConversationId, messageId: MessageId): Promise<Message | null>;

  /**
   * Under the conversation lock: re-check that the sender is a current member,
   * resolve the idempotency key, assign `lastSequence + 1`, store the message
   * and its attachments, and advance the sender's own read watermark to it.
   */
  appendMessage(draft: MessageDraft): Promise<AppendOutcome>;

  /**
   * Under the conversation lock: newcomers join (or rejoin) with a visibility
   * window computed from the conversation's state at that instant; current
   * members are left alone; the cap is checked against the live count.
   */
  addParticipants(input: {
    readonly conversationId: ConversationId;
    readonly userIds: readonly string[];
    readonly role: ParticipantRole;
    readonly addedBy: string;
    readonly at: Date;
    readonly capacity: number;
  }): Promise<AddParticipantsOutcome>;

  /** Under the conversation lock. The membership as ended, or null if not a current member. */
  removeParticipant(
    conversationId: ConversationId,
    userId: string,
    at: Date,
  ): Promise<Participant | null>;

  /** Monotonic, clamped to the conversation's last sequence — in one statement. */
  markRead(
    conversationId: ConversationId,
    userId: string,
    sequence: number,
  ): Promise<MarkReadOutcome>;

  // ── Community chats (community-chat.md §5–§7). Silent: no event, no audit. ──

  /**
   * A community's chat — created, or the one that already exists. Any number
   * of concurrent calls for one community return one conversation: the
   * partial unique index on `community_id` decides.
   */
  materializeCommunityChat(input: {
    readonly id: ConversationId;
    readonly communityId: string;
    readonly at: Date;
  }): Promise<Conversation>;

  /**
   * The projection applier — the only writer of a community chat's
   * membership columns. ONE transaction under the conversation's row lock:
   * each state through `projectMember` (the version guard repeated in the
   * database), `member_count` moved by the real transitions, and the
   * projected version advanced only across a contiguous range. At most
   * MAX_APPLY_BATCH states, one per member (a RangeError otherwise).
   * `override` is the reconciler's alone.
   */
  applyCommunityMembership(input: {
    readonly conversationId: ConversationId;
    readonly states: readonly CommunityMemberState[];
    readonly advance: { readonly from: number; readonly to: number } | null;
    readonly override?: true;
    readonly at: Date;
  }): Promise<ApplyMembershipOutcome>;

  /** The reconciler's alone: the projected version set to `to`, backwards if need be. */
  resetProjectedVersion(conversationId: ConversationId, to: number): Promise<void>;
}

/** Enough of a message to show it as a conversation's latest. */
export type MessageHead = Pick<
  Message,
  'id' | 'sequence' | 'senderId' | 'type' | 'body' | 'createdAt' | 'deletedAt'
>;

/** A conversation as one member sees it in a list. */
export interface ConversationSummaryRow {
  readonly conversation: Conversation;
  readonly me: Participant;
  /** DIRECT: the other member. */
  readonly counterpartUserId: string | null;
  /** The newest message this member may see — possibly a tombstone. */
  readonly lastMessage: MessageHead | null;
  /** Visible, unread, not their own, not deleted — capped at UNREAD_COUNT_CAP. */
  readonly unreadCount: number;
}

/** Keyset position in "my conversations, most recently active first". */
export interface ConversationCursor {
  readonly activityAt: Date;
  readonly id: string;
}

export interface MessageWindow {
  readonly hiddenThroughSequence: number;
  readonly lastSequence: number;
  /** Older than this sequence. */
  readonly before?: number;
  /** Newer than this sequence. */
  readonly after?: number;
  readonly limit: number;
}

export interface MessageSlice {
  /** Ascending by sequence. */
  readonly items: readonly Message[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

/**
 * The read side: pages, never whole collections. Each method is a bounded
 * number of indexed queries whatever the conversation's size.
 */
export interface MessagingReadModel {
  listConversations(
    userId: string,
    page: { readonly limit: number; readonly after?: ConversationCursor },
  ): Promise<{
    readonly items: readonly ConversationSummaryRow[];
    readonly next: ConversationCursor | null;
  }>;

  conversationSummary(
    conversationId: ConversationId,
    userId: string,
  ): Promise<ConversationSummaryRow | null>;

  listMessages(conversationId: ConversationId, window: MessageWindow): Promise<MessageSlice>;

  /** Current members, by user id — a stable keyset. */
  listParticipants(
    conversationId: ConversationId,
    page: { readonly limit: number; readonly afterUserId?: string },
  ): Promise<{ readonly items: readonly Participant[]; readonly next: string | null }>;

  /** Current members' ids only, by user id — for fan-out. */
  listMemberIds(
    conversationId: ConversationId,
    page: {
      readonly limit: number;
      readonly afterUserId?: string;
      readonly excludeUserId?: string;
      /** Only members whose visibility window includes this sequence. */
      readonly visibleSequence?: number;
      /** Only these people, when they are members. */
      readonly onlyUserIds?: readonly string[];
    },
  ): Promise<{ readonly userIds: readonly string[]; readonly next: string | null }>;

  /** The chat of each of these communities that has one — at most 1,000 ids. */
  communityChatsFor(communityIds: readonly string[]): Promise<readonly CommunityChatRef[]>;

  communityChat(communityId: string): Promise<CommunityChatRef | null>;

  /**
   * The reconciler's walk (§7.5), by user id: a chat's current members, and
   * any other row whose source version is above `versionAbove` — the rows
   * that could outrank what the authority will allocate next.
   */
  projectionRows(
    conversationId: ConversationId,
    page: { readonly limit: number; readonly afterUserId?: string; readonly versionAbove: number },
  ): Promise<{ readonly items: readonly ProjectionRow[]; readonly next: string | null }>;
}

export const MESSAGING_REPOSITORY = Symbol('MESSAGING_REPOSITORY');
export const MESSAGING_READ_MODEL = Symbol('MESSAGING_READ_MODEL');
