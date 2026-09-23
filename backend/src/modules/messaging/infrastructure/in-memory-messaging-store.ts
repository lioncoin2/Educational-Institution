import type { ConversationId, Conversation, NewConversation } from '../domain/conversation';
import { sameContent, type Message, type MessageDraft, type MessageId } from '../domain/message';
import { UNREAD_COUNT_CAP } from '../domain/messaging-policy';
import { isActive, newParticipant, type Participant } from '../domain/participant';
import { advancedWatermark } from '../domain/read-state';
import type {
  AddParticipantsOutcome,
  AppendOutcome,
  ConversationCursor,
  ConversationSummaryRow,
  CreateDirectOutcome,
  MarkReadOutcome,
  MessageSlice,
  MessageWindow,
  MessagingReadModel,
  MessagingRepository,
} from '../domain/ports';

const key = (conversationId: string, userId: string) => `${conversationId}\u0000${userId}`;

/**
 * Both messaging ports over plain maps — unit tests, and a server run without
 * a database.
 *
 * It keeps every guarantee the Postgres adapter keeps: one direct
 * conversation per pair, one message per sequence and per client key,
 * membership re-checked at append, caps against the live count, a watermark
 * that only moves forward. Each mutating method runs to completion without an
 * `await`, which in one JavaScript thread is what the row lock is in Postgres.
 */
export class InMemoryMessagingStore implements MessagingRepository, MessagingReadModel {
  private readonly conversations = new Map<string, Conversation>();
  private readonly participants = new Map<string, Participant>();
  /** Per conversation, ascending by sequence. */
  private readonly timelines = new Map<string, Message[]>();

  // ── MessagingRepository ────────────────────────────────────────────────

  async createConversation(input: NewConversation): Promise<void> {
    if (this.conversations.has(input.conversation.id)) throw new Error('duplicate conversation id');
    this.store(input);
  }

  async createDirectConversation(input: NewConversation): Promise<CreateDirectOutcome> {
    const pair = input.conversation.directPair;
    if (pair === null) throw new Error('A direct conversation needs its pair.');
    for (const existing of this.conversations.values()) {
      if (existing.directPair?.low === pair.low && existing.directPair.high === pair.high) {
        return { created: false, conversation: existing };
      }
    }
    this.store(input);
    return { created: true, conversation: input.conversation };
  }

  async findConversation(id: ConversationId): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async findParticipant(conversationId: ConversationId, userId: string) {
    return this.participants.get(key(conversationId, userId)) ?? null;
  }

  async findMessage(conversationId: ConversationId, messageId: MessageId) {
    return this.timeline(conversationId).find((message) => message.id === messageId) ?? null;
  }

  async appendMessage(draft: MessageDraft): Promise<AppendOutcome> {
    const conversation = this.conversations.get(draft.conversationId);
    const sender = this.participants.get(key(draft.conversationId, draft.senderId)) ?? null;
    if (conversation === undefined || !isActive(sender)) return { kind: 'not_participant' };

    const timeline = this.timeline(draft.conversationId);
    const existing = timeline.find(
      (message) =>
        message.senderId === draft.senderId && message.clientMessageId === draft.clientMessageId,
    );
    if (existing !== undefined) {
      return sameContent(existing, draft)
        ? { kind: 'duplicate', message: existing }
        : { kind: 'key_reused' };
    }

    const sequence = conversation.lastSequence + 1;
    const message: Message = { ...draft, sequence, editedAt: null, deletedAt: null };
    timeline.push(message);
    this.timelines.set(draft.conversationId, timeline);
    this.conversations.set(conversation.id, {
      ...conversation,
      lastSequence: sequence,
      lastMessageAt: draft.createdAt,
    });
    this.participants.set(key(draft.conversationId, draft.senderId), {
      ...sender,
      lastReadSequence: sequence,
    });
    return { kind: 'appended', message };
  }

  async addParticipants(input: {
    readonly conversationId: ConversationId;
    readonly userIds: readonly string[];
    readonly role: Participant['role'];
    readonly addedBy: string;
    readonly at: Date;
    readonly capacity: number;
  }): Promise<AddParticipantsOutcome> {
    const conversation = this.conversations.get(input.conversationId);
    if (conversation === undefined) return { kind: 'conversation_not_found' };

    const candidates = [...new Set(input.userIds)];
    const unchanged = candidates.filter((userId) =>
      isActive(this.participants.get(key(conversation.id, userId)) ?? null),
    );
    const newcomers = candidates.filter((userId) => !unchanged.includes(userId));
    if (conversation.memberCount + newcomers.length > input.capacity) {
      return {
        kind: 'capacity_exceeded',
        capacity: input.capacity,
        memberCount: conversation.memberCount,
      };
    }

    const added = newcomers.map((userId) =>
      newParticipant(conversation, userId, input.role, input.addedBy, input.at),
    );
    for (const participant of added) {
      this.participants.set(key(conversation.id, participant.userId), participant);
    }
    this.conversations.set(conversation.id, {
      ...conversation,
      memberCount: conversation.memberCount + added.length,
    });
    return { kind: 'added', added, unchanged };
  }

  async removeParticipant(
    conversationId: ConversationId,
    userId: string,
    at: Date,
  ): Promise<Participant | null> {
    const conversation = this.conversations.get(conversationId);
    const participant = this.participants.get(key(conversationId, userId)) ?? null;
    if (conversation === undefined || !isActive(participant)) return null;

    const leftAt = at < participant.joinedAt ? participant.joinedAt : at;
    const removed = { ...participant, leftAt };
    this.participants.set(key(conversationId, userId), removed);
    this.conversations.set(conversationId, {
      ...conversation,
      memberCount: conversation.memberCount - 1,
    });
    return removed;
  }

  async markRead(
    conversationId: ConversationId,
    userId: string,
    sequence: number,
  ): Promise<MarkReadOutcome> {
    const conversation = this.conversations.get(conversationId);
    const participant = this.participants.get(key(conversationId, userId)) ?? null;
    if (conversation === undefined || !isActive(participant)) return { kind: 'not_participant' };

    const target = advancedWatermark(
      participant.lastReadSequence,
      sequence,
      conversation.lastSequence,
    );
    if (target === participant.lastReadSequence) {
      return { kind: 'unchanged', lastReadSequence: participant.lastReadSequence };
    }
    this.participants.set(key(conversationId, userId), {
      ...participant,
      lastReadSequence: target,
    });
    return { kind: 'advanced', lastReadSequence: target };
  }

  // ── MessagingReadModel ─────────────────────────────────────────────────

  async listConversations(
    userId: string,
    page: { readonly limit: number; readonly after?: ConversationCursor },
  ) {
    const rows = [...this.participants.values()]
      .filter((participant) => participant.userId === userId && participant.leftAt === null)
      .map((participant) => this.summary(participant))
      .sort(byActivityDescending)
      .filter((row) => page.after === undefined || isBefore(row, page.after));
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items,
      next:
        rows.length > page.limit && last !== undefined
          ? { activityAt: activityOf(last), id: last.conversation.id }
          : null,
    };
  }

  async conversationSummary(
    conversationId: ConversationId,
    userId: string,
  ): Promise<ConversationSummaryRow | null> {
    const participant = this.participants.get(key(conversationId, userId)) ?? null;
    return isActive(participant) ? this.summary(participant) : null;
  }

  async listMessages(conversationId: ConversationId, window: MessageWindow): Promise<MessageSlice> {
    const hidden = window.hiddenThroughSequence;
    const timeline = this.timeline(conversationId);
    if (window.after !== undefined) {
      const from = Math.max(hidden, window.after);
      const found = timeline.filter((message) => message.sequence > from);
      return {
        items: found.slice(0, window.limit),
        hasOlder: from > hidden && hidden < window.lastSequence,
        hasNewer: found.length > window.limit,
      };
    }
    const upper = window.before ?? window.lastSequence + 1;
    const found = timeline.filter(
      (message) => message.sequence > hidden && message.sequence < upper,
    );
    return {
      items: found.slice(Math.max(0, found.length - window.limit)),
      hasOlder: found.length > window.limit,
      hasNewer: upper <= window.lastSequence,
    };
  }

  async listParticipants(
    conversationId: ConversationId,
    page: { readonly limit: number; readonly afterUserId?: string },
  ) {
    const members = this.members(conversationId, page.afterUserId);
    const items = members.slice(0, page.limit);
    return {
      items,
      next: members.length > page.limit ? (items[items.length - 1]?.userId ?? null) : null,
    };
  }

  async listMemberIds(
    conversationId: ConversationId,
    page: {
      readonly limit: number;
      readonly afterUserId?: string;
      readonly excludeUserId?: string;
    },
  ) {
    const ids = this.members(conversationId, page.afterUserId)
      .map((participant) => participant.userId)
      .filter((userId) => userId !== page.excludeUserId);
    const userIds = ids.slice(0, page.limit);
    return {
      userIds,
      next: ids.length > page.limit ? (userIds[userIds.length - 1] ?? null) : null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private store(input: NewConversation): void {
    this.conversations.set(input.conversation.id, input.conversation);
    for (const participant of input.participants) {
      this.participants.set(key(participant.conversationId, participant.userId), participant);
    }
  }

  private timeline(conversationId: string): Message[] {
    return this.timelines.get(conversationId) ?? [];
  }

  private members(conversationId: string, afterUserId: string | undefined): Participant[] {
    return [...this.participants.values()]
      .filter(
        (participant) =>
          participant.conversationId === conversationId &&
          participant.leftAt === null &&
          (afterUserId === undefined || participant.userId > afterUserId),
      )
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  private summary(me: Participant): ConversationSummaryRow {
    const conversation = this.conversations.get(me.conversationId);
    if (conversation === undefined) throw new Error('participant without conversation');
    const timeline = this.timeline(conversation.id);
    const visible = timeline.filter((message) => message.sequence > me.hiddenThroughSequence);
    const latest = visible[visible.length - 1];
    const counterpart =
      conversation.type === 'DIRECT'
        ? [...this.participants.values()].find(
            (other) => other.conversationId === conversation.id && other.userId !== me.userId,
          )
        : undefined;
    const unread = timeline.filter(
      (message) =>
        message.sequence > me.lastReadSequence &&
        message.senderId !== me.userId &&
        message.deletedAt === null,
    ).length;
    return {
      conversation,
      me,
      counterpartUserId: counterpart?.userId ?? null,
      lastMessage:
        latest === undefined
          ? null
          : {
              id: latest.id,
              sequence: latest.sequence,
              senderId: latest.senderId,
              type: latest.type,
              body: latest.body,
              createdAt: latest.createdAt,
              deletedAt: latest.deletedAt,
            },
      unreadCount: Math.min(unread, UNREAD_COUNT_CAP),
    };
  }
}

function activityOf(row: ConversationSummaryRow): Date {
  return row.conversation.lastMessageAt ?? row.conversation.createdAt;
}

function byActivityDescending(a: ConversationSummaryRow, b: ConversationSummaryRow): number {
  const difference = activityOf(b).getTime() - activityOf(a).getTime();
  if (difference !== 0) return difference;
  return a.conversation.id < b.conversation.id ? 1 : a.conversation.id > b.conversation.id ? -1 : 0;
}

/** Strictly after the cursor in (activity desc, id desc) order. */
function isBefore(row: ConversationSummaryRow, cursor: ConversationCursor): boolean {
  const activity = activityOf(row).getTime();
  const at = cursor.activityAt.getTime();
  return activity < at || (activity === at && row.conversation.id < cursor.id);
}
