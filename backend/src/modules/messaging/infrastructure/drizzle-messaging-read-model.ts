import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { MessageType, ParticipantRole } from '../contracts/vocabulary';
import type { ConversationId } from '../domain/conversation';
import type { MessageAttachment, MessageId } from '../domain/message';
import { UNREAD_COUNT_CAP } from '../domain/messaging-policy';
import type {
  ConversationCursor,
  ConversationSummaryRow,
  MessageSlice,
  MessageWindow,
  MessagingReadModel,
} from '../domain/ports';
import { date, dateOrNull, num, str, strOrNull, toMessage, toParticipant } from './row-mapping';
import { conversationParticipants, conversations, messageAttachments, messages } from './schema';

/**
 * Messaging's queries. Each is a bounded number of index scans, whatever the
 * size of the conversation or the length of its history:
 *
 *   list / summary   one statement: the member's rows via the user index, and
 *                    per conversation three LATERAL probes of the timeline
 *                    index — counterpart, newest visible message, and an
 *                    unread count that stops at the cap
 *   messages         one range scan of (conversation_id, sequence), plus one
 *                    lookup of the page's attachments
 *   members          keyset scans of the primary key
 *
 * No OFFSET anywhere: every page starts from a key, so page 1000 costs what
 * page 1 does.
 */
@Injectable()
export class DrizzleMessagingReadModel implements MessagingReadModel {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listConversations(
    userId: string,
    page: { readonly limit: number; readonly after?: ConversationCursor },
  ) {
    const after =
      page.after === undefined
        ? sql``
        : sql`and (coalesce(c.last_message_at, c.created_at), c.id) < (${page.after.activityAt.toISOString()}::timestamptz, ${page.after.id})`;
    const rows = await this.summaries(
      sql`p.user_id = ${userId} and p.left_at is null ${after}`,
      page.limit + 1,
    );
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items,
      next:
        rows.length > page.limit && last !== undefined
          ? {
              activityAt: last.conversation.lastMessageAt ?? last.conversation.createdAt,
              id: last.conversation.id,
            }
          : null,
    };
  }

  async conversationSummary(
    conversationId: ConversationId,
    userId: string,
  ): Promise<ConversationSummaryRow | null> {
    const rows = await this.summaries(
      sql`p.conversation_id = ${conversationId} and p.user_id = ${userId} and p.left_at is null`,
      1,
    );
    return rows[0] ?? null;
  }

  async listMessages(conversationId: ConversationId, window: MessageWindow): Promise<MessageSlice> {
    const hidden = window.hiddenThroughSequence;
    const forConversation = eq(messages.conversationId, conversationId);

    let rows: (typeof messages.$inferSelect)[];
    let hasOlder: boolean;
    let hasNewer: boolean;
    if (window.after !== undefined) {
      // Forward: catching up after a gap. Oldest first from the cursor.
      const from = Math.max(hidden, window.after);
      const found = await this.db
        .select()
        .from(messages)
        .where(and(forConversation, gt(messages.sequence, from)))
        .orderBy(asc(messages.sequence))
        .limit(window.limit + 1);
      rows = found.slice(0, window.limit);
      hasNewer = found.length > window.limit;
      // Sequences are dense (deletion is soft), so "anything visible below
      // the cursor" is arithmetic, not a query.
      hasOlder = from > hidden && hidden < window.lastSequence;
    } else {
      // Backward: the latest page, or older than a cursor. Newest first from
      // the index, returned oldest first.
      const upper = window.before ?? window.lastSequence + 1;
      const found = await this.db
        .select()
        .from(messages)
        .where(and(forConversation, gt(messages.sequence, hidden), lt(messages.sequence, upper)))
        .orderBy(desc(messages.sequence))
        .limit(window.limit + 1);
      rows = found.slice(0, window.limit).reverse();
      hasOlder = found.length > window.limit;
      hasNewer = upper <= window.lastSequence;
    }

    const attachments = await this.attachmentsFor(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toMessage(row, attachments.get(row.id) ?? [])),
      hasOlder,
      hasNewer,
    };
  }

  async listParticipants(
    conversationId: ConversationId,
    page: { readonly limit: number; readonly afterUserId?: string },
  ) {
    const rows = await this.db
      .select()
      .from(conversationParticipants)
      .where(this.currentMembers(conversationId, page.afterUserId))
      .orderBy(asc(conversationParticipants.userId))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit).map(toParticipant);
    return {
      items,
      next: rows.length > page.limit ? (items[items.length - 1]?.userId ?? null) : null,
    };
  }

  async listMemberIds(
    conversationId: ConversationId,
    page: {
      readonly limit: number;
      readonly afterUserId?: string;
      readonly excludeUserId?: string;
      readonly visibleSequence?: number;
    },
  ) {
    const rows = await this.db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          this.currentMembers(conversationId, page.afterUserId),
          page.excludeUserId === undefined
            ? undefined
            : ne(conversationParticipants.userId, page.excludeUserId),
          // Someone who joined after this message was sent cannot see it.
          page.visibleSequence === undefined
            ? undefined
            : lt(conversationParticipants.hiddenThroughSequence, page.visibleSequence),
        ),
      )
      .orderBy(asc(conversationParticipants.userId))
      .limit(page.limit + 1);
    const userIds = rows.slice(0, page.limit).map((row) => row.userId);
    return {
      userIds,
      next: rows.length > page.limit ? (userIds[userIds.length - 1] ?? null) : null,
    };
  }

  private currentMembers(conversationId: string, afterUserId: string | undefined): SQL | undefined {
    return and(
      eq(conversationParticipants.conversationId, conversationId),
      isNull(conversationParticipants.leftAt),
      afterUserId === undefined ? undefined : gt(conversationParticipants.userId, afterUserId),
    );
  }

  private async attachmentsFor(
    messageIds: readonly string[],
  ): Promise<Map<string, MessageAttachment[]>> {
    const byMessage = new Map<string, MessageAttachment[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = await this.db
      .select()
      .from(messageAttachments)
      .where(inArray(messageAttachments.messageId, [...messageIds]))
      .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position));
    for (const row of rows) {
      const list = byMessage.get(row.messageId) ?? [];
      list.push({ fileAssetId: row.fileAssetId, position: row.position });
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  }

  /**
   * The member's conversations matching `where`, most recently active first.
   * Unread = visible, above the watermark, someone else's, not deleted —
   * counted only up to the cap, so a 100,000-message backlog costs what a
   * 100-message one does.
   */
  private async summaries(where: SQL, limit: number): Promise<ConversationSummaryRow[]> {
    const result = await this.db.execute(sql`
      select
        c.id, c.type, c.title, c.created_by, c.created_at, c.direct_user_low, c.direct_user_high,
        c.last_sequence, c.last_message_at, c.member_count,
        p.user_id as member_user_id, p.role, p.joined_at, p.left_at, p.added_by, p.last_read_sequence, p.hidden_through_sequence,
        counterpart.user_id as counterpart_user_id,
        latest.id as m_id, latest.sequence as m_sequence, latest.sender_id as m_sender_id,
        latest.type as m_type, latest.body as m_body, latest.created_at as m_created_at,
        latest.deleted_at as m_deleted_at,
        unread.count as unread_count
      from ${conversationParticipants} p
      join ${conversations} c on c.id = p.conversation_id
      left join lateral (
        select o.user_id from ${conversationParticipants} o
        where c.type = 'DIRECT' and o.conversation_id = c.id and o.user_id <> p.user_id
        limit 1
      ) counterpart on true
      left join lateral (
        select m.id, m.sequence, m.sender_id, m.type, m.body, m.created_at, m.deleted_at
        from ${messages} m
        where m.conversation_id = c.id and m.sequence > p.hidden_through_sequence
        order by m.sequence desc
        limit 1
      ) latest on true
      cross join lateral (
        select count(*)::int as count from (
          select 1 from ${messages} u
          where u.conversation_id = c.id
            and u.sequence > p.last_read_sequence
            and u.sender_id <> p.user_id
            and u.deleted_at is null
          limit ${UNREAD_COUNT_CAP}
        ) capped
      ) unread
      where ${where}
      order by coalesce(c.last_message_at, c.created_at) desc, c.id desc
      limit ${limit}
    `);
    return result.rows.map(toSummaryRow);
  }
}

function toSummaryRow(row: Record<string, unknown>): ConversationSummaryRow {
  const conversationId = str(row.id) as ConversationId;
  const low = strOrNull(row.direct_user_low);
  const high = strOrNull(row.direct_user_high);
  return {
    conversation: {
      id: conversationId,
      type: str(row.type) as ConversationSummaryRow['conversation']['type'],
      title: strOrNull(row.title),
      createdBy: str(row.created_by),
      createdAt: date(row.created_at),
      directPair: low !== null && high !== null ? { low, high } : null,
      lastSequence: num(row.last_sequence),
      lastMessageAt: dateOrNull(row.last_message_at),
      memberCount: num(row.member_count),
    },
    me: {
      conversationId,
      userId: str(row.member_user_id),
      role: str(row.role) as ParticipantRole,
      joinedAt: date(row.joined_at),
      leftAt: dateOrNull(row.left_at),
      addedBy: strOrNull(row.added_by),
      lastReadSequence: num(row.last_read_sequence),
      hiddenThroughSequence: num(row.hidden_through_sequence),
    },
    counterpartUserId: strOrNull(row.counterpart_user_id),
    lastMessage:
      row.m_id === null || row.m_id === undefined
        ? null
        : {
            id: str(row.m_id) as MessageId,
            sequence: num(row.m_sequence),
            senderId: str(row.m_sender_id),
            type: str(row.m_type) as MessageType,
            body: strOrNull(row.m_body),
            createdAt: date(row.m_created_at),
            deletedAt: dateOrNull(row.m_deleted_at),
          },
    unreadCount: num(row.unread_count),
  };
}
