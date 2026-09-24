import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { DATABASE, isUniqueViolation, type Database } from '../../../platform/database';
import {
  checkApplyBatch,
  newCommunityChat,
  projectMember,
  type CommunityMemberState,
  type ProjectionTransition,
} from '../domain/community-chat';
import type { Conversation, ConversationId, NewConversation } from '../domain/conversation';
import { sameContent, type Message, type MessageDraft, type MessageId } from '../domain/message';
import { isActive, newParticipant, type Participant } from '../domain/participant';
import type {
  AddParticipantsOutcome,
  AppendOutcome,
  ApplyMembershipOutcome,
  CreateDirectOutcome,
  MarkReadOutcome,
  MessagingRepository,
} from '../domain/ports';
import {
  conversationRow,
  participantRow,
  toConversation,
  toMessage,
  toParticipant,
} from './row-mapping';
import { conversationParticipants, conversations, messageAttachments, messages } from './schema';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

/**
 * Messaging's writes in Postgres.
 *
 * Every write that touches an EXISTING conversation starts by locking its row
 * (`SELECT … FOR UPDATE`). That one lock is what serializes, per conversation:
 * sequence assignment, the idempotency check, membership changes and the
 * member cap. Different conversations never contend. See messaging.md,
 * "Ordering" and "Concurrency".
 */
@Injectable()
export class DrizzleMessagingRepository implements MessagingRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async createConversation(input: NewConversation): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(conversations).values(conversationRow(input.conversation));
      if (input.participants.length > 0) {
        await tx.insert(conversationParticipants).values(input.participants.map(participantRow));
      }
    });
  }

  async createDirectConversation(input: NewConversation): Promise<CreateDirectOutcome> {
    const pair = input.conversation.directPair;
    if (pair === null) throw new Error('A direct conversation needs its pair.');

    return this.db.transaction(async (tx) => {
      // The pair's unique constraint arbitrates: a concurrent creator of the
      // same pair waits here for the other transaction, then does nothing.
      const inserted = await tx
        .insert(conversations)
        .values(conversationRow(input.conversation))
        .onConflictDoNothing({
          target: [conversations.directUserLow, conversations.directUserHigh],
        })
        .returning({ id: conversations.id });

      if (inserted.length === 1) {
        await tx.insert(conversationParticipants).values(input.participants.map(participantRow));
        return { created: true, conversation: input.conversation };
      }

      const existing = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.directUserLow, pair.low),
            eq(conversations.directUserHigh, pair.high),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (row === undefined) throw new Error('Direct conversation vanished during creation.');
      return { created: false, conversation: toConversation(row) };
    });
  }

  async findConversation(id: ConversationId) {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toConversation(row);
  }

  async findParticipant(conversationId: ConversationId, userId: string) {
    return this.participant(this.db, conversationId, userId);
  }

  async findMessage(conversationId: ConversationId, messageId: MessageId): Promise<Message | null> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.id, messageId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return toMessage(row, await this.attachmentsOf(this.db, row.id));
  }

  async appendMessage(draft: MessageDraft): Promise<AppendOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const locked = await tx
          .select({ lastSequence: conversations.lastSequence })
          .from(conversations)
          .where(eq(conversations.id, draft.conversationId))
          .for('update');
        const conversation = locked[0];
        if (conversation === undefined) return { kind: 'not_participant' } as const;

        // Membership, re-checked under the lock: a removal either committed
        // before this point (and we refuse) or waits until we are done.
        const sender = await this.participant(tx, draft.conversationId, draft.senderId);
        if (!isActive(sender)) return { kind: 'not_participant' } as const;

        // Idempotency, under the same lock: two retries of one send serialize
        // here, and the second finds the first.
        const existing = await this.byClientMessageId(tx, draft);
        if (existing !== null) {
          return sameContent(existing, draft)
            ? ({ kind: 'duplicate', message: existing } as const)
            : ({ kind: 'key_reused' } as const);
        }

        const sequence = conversation.lastSequence + 1;
        await tx
          .update(conversations)
          .set({ lastSequence: sequence, lastMessageAt: draft.createdAt })
          .where(eq(conversations.id, draft.conversationId));
        await tx.insert(messages).values({
          id: draft.id,
          conversationId: draft.conversationId,
          sequence,
          senderId: draft.senderId,
          type: draft.type,
          body: draft.body,
          replyToMessageId: draft.replyToMessageId,
          clientMessageId: draft.clientMessageId,
          createdAt: draft.createdAt,
        });
        if (draft.attachments.length > 0) {
          await tx.insert(messageAttachments).values(
            draft.attachments.map((attachment) => ({
              messageId: draft.id,
              position: attachment.position,
              fileAssetId: attachment.fileAssetId,
            })),
          );
        }
        // Writing in a conversation means having read it up to here.
        await tx
          .update(conversationParticipants)
          .set({ lastReadSequence: sequence })
          .where(
            and(
              eq(conversationParticipants.conversationId, draft.conversationId),
              eq(conversationParticipants.userId, draft.senderId),
            ),
          );

        const message: Message = { ...draft, sequence, editedAt: null, deletedAt: null };
        return { kind: 'appended', message } as const;
      });
    } catch (error) {
      // Unreachable while the lookup above runs under the lock; the unique
      // constraint remains the last word if that ever changes.
      if (!isUniqueViolation(error, 'messages_idempotency_unique')) throw error;
      const existing = await this.byClientMessageId(this.db, draft);
      if (existing === null) throw error;
      return sameContent(existing, draft)
        ? { kind: 'duplicate', message: existing }
        : { kind: 'key_reused' };
    }
  }

  async addParticipants(input: {
    readonly conversationId: ConversationId;
    readonly userIds: readonly string[];
    readonly role: Participant['role'];
    readonly addedBy: string;
    readonly at: Date;
    readonly capacity: number;
  }): Promise<AddParticipantsOutcome> {
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .for('update');
      const row = locked[0];
      if (row === undefined) return { kind: 'conversation_not_found' } as const;
      const conversation = toConversation(row);

      const candidates = [...new Set(input.userIds)];
      const current =
        candidates.length === 0
          ? []
          : await tx
              .select({ userId: conversationParticipants.userId })
              .from(conversationParticipants)
              .where(
                and(
                  eq(conversationParticipants.conversationId, input.conversationId),
                  inArray(conversationParticipants.userId, candidates),
                  isNull(conversationParticipants.leftAt),
                ),
              );
      const unchanged = new Set(current.map((member) => member.userId));
      const newcomers = candidates.filter((userId) => !unchanged.has(userId));

      if (conversation.memberCount + newcomers.length > input.capacity) {
        return {
          kind: 'capacity_exceeded',
          capacity: input.capacity,
          memberCount: conversation.memberCount,
        } as const;
      }
      if (newcomers.length === 0) {
        return { kind: 'added', added: [], unchanged: [...unchanged] } as const;
      }

      // The window is computed from the conversation as locked — the true
      // "now" of the join, whatever was sent a moment before.
      const joining = newcomers.map((userId) =>
        newParticipant(conversation, userId, input.role, input.addedBy, input.at),
      );
      await tx
        .insert(conversationParticipants)
        .values(joining.map(participantRow))
        // Someone who left and is added again rejoins: a new window, a new role.
        .onConflictDoUpdate({
          target: [conversationParticipants.conversationId, conversationParticipants.userId],
          set: {
            role: sql`excluded.role`,
            joinedAt: sql`excluded.joined_at`,
            leftAt: sql`null`,
            addedBy: sql`excluded.added_by`,
            lastReadSequence: sql`excluded.last_read_sequence`,
            hiddenThroughSequence: sql`excluded.hidden_through_sequence`,
          },
        });
      await tx
        .update(conversations)
        .set({ memberCount: sql`${conversations.memberCount} + ${newcomers.length}` })
        .where(eq(conversations.id, input.conversationId));

      return { kind: 'added', added: joining, unchanged: [...unchanged] } as const;
    });
  }

  async removeParticipant(
    conversationId: ConversationId,
    userId: string,
    at: Date,
  ): Promise<Participant | null> {
    return this.db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update');
      if (locked.length === 0) return null;

      const removed = await tx
        .update(conversationParticipants)
        // Never before they joined, whatever a skewed clock says.
        .set({
          leftAt: sql`greatest(${at.toISOString()}::timestamptz, ${conversationParticipants.joinedAt})`,
        })
        .where(
          and(
            eq(conversationParticipants.conversationId, conversationId),
            eq(conversationParticipants.userId, userId),
            isNull(conversationParticipants.leftAt),
          ),
        )
        .returning();
      const row = removed[0];
      if (row === undefined) return null;

      await tx
        .update(conversations)
        .set({ memberCount: sql`${conversations.memberCount} - 1` })
        .where(eq(conversations.id, conversationId));
      return toParticipant(row);
    });
  }

  async markRead(
    conversationId: ConversationId,
    userId: string,
    sequence: number,
  ): Promise<MarkReadOutcome> {
    // One statement: clamped to the conversation's last sequence, and applied
    // only if it moves the watermark forward. Concurrent calls re-check the
    // condition on the row they wait for, so the watermark never goes back.
    const target = sql`least(${sequence}::bigint, (select ${conversations.lastSequence} from ${conversations} where ${conversations.id} = ${conversationId}))`;
    const advanced = await this.db
      .update(conversationParticipants)
      .set({ lastReadSequence: target })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, userId),
          isNull(conversationParticipants.leftAt),
          sql`${conversationParticipants.lastReadSequence} < ${target}`,
        ),
      )
      .returning({ lastReadSequence: conversationParticipants.lastReadSequence });
    const moved = advanced[0];
    if (moved !== undefined) return { kind: 'advanced', lastReadSequence: moved.lastReadSequence };

    const current = await this.participant(this.db, conversationId, userId);
    return isActive(current)
      ? { kind: 'unchanged', lastReadSequence: current.lastReadSequence }
      : { kind: 'not_participant' };
  }

  async materializeCommunityChat(input: {
    readonly id: ConversationId;
    readonly communityId: string;
    readonly at: Date;
  }): Promise<Conversation> {
    // The partial unique index arbitrates: a concurrent materialization of the
    // same community waits here for the other transaction, then does nothing.
    await this.db
      .insert(conversations)
      .values(conversationRow(newCommunityChat(input)))
      .onConflictDoNothing({
        target: conversations.communityId,
        where: sql`${conversations.communityId} is not null`,
      });
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.communityId, input.communityId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error('A community chat vanished during materialization.');
    return toConversation(row);
  }

  async applyCommunityMembership(input: {
    readonly conversationId: ConversationId;
    readonly states: readonly CommunityMemberState[];
    readonly advance: { readonly from: number; readonly to: number } | null;
    readonly override?: true;
    readonly at: Date;
  }): Promise<ApplyMembershipOutcome> {
    checkApplyBatch(input.states);
    return this.db.transaction(async (tx) => {
      // The lock appendMessage takes: an apply and a send never interleave.
      const locked = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .for('update');
      const row = locked[0];
      if (row === undefined) return { kind: 'conversation_not_found' } as const;
      const conversation = toConversation(row);
      if (conversation.communityId === null) return { kind: 'not_community_chat' } as const;

      // The members' rows too, in key order: markRead moves a watermark
      // without the conversation lock, and must not be overwritten by a value
      // read a moment before it. One array parameter, however many members.
      const userIds = input.states.map((state) => state.userId);
      const current =
        userIds.length === 0
          ? []
          : await tx
              .select()
              .from(conversationParticipants)
              .where(
                and(
                  eq(conversationParticipants.conversationId, conversation.id),
                  sql`${conversationParticipants.userId} = any(${sql.param(userIds)}::text[])`,
                ),
              )
              .orderBy(asc(conversationParticipants.userId))
              .for('update');
      const before = new Map(current.map((found) => [found.userId, toParticipant(found)]));

      const transitions = new Map<string, ProjectionTransition>();
      const writes: Participant[] = [];
      for (const state of input.states) {
        const projected = projectMember(
          before.get(state.userId) ?? null,
          state,
          conversation,
          input.at,
          { override: input.override },
        );
        if (projected.transition === 'ignored' || projected.next === null) continue;
        transitions.set(state.userId, projected.transition);
        writes.push(projected.next);
      }

      const counts = { joined: 0, rejoined: 0, left: 0, tombstoned: 0 };
      let delta = 0;
      if (writes.length > 0) {
        const written = await this.upsertProjected(tx, writes, input.override === true);
        // C5, from what was really written: rows read under the lock, before
        // and after.
        for (const after of written) {
          const was = before.get(after.userId);
          delta += Number(after.current) - Number(was !== undefined && was.leftAt === null);
          const transition = transitions.get(after.userId);
          if (transition !== undefined && transition !== 'bumped' && transition !== 'ignored') {
            counts[transition] += 1;
          }
        }
      }

      const advance = input.advance;
      if (delta === 0 && advance === null) {
        return {
          kind: 'applied',
          ...counts,
          projectedVersion: conversation.projectedMembershipVersion ?? 0,
          memberCount: conversation.memberCount,
        } as const;
      }
      // Contiguous and monotonic (C6): the version moves only if everything
      // up to `from` was already reflected, and `greatest` never moves it
      // back. The check sits in a CASE, so it never skips the count (C5).
      const updated = await tx
        .update(conversations)
        .set({
          memberCount: sql`${conversations.memberCount} + ${delta}`,
          projectedMembershipVersion:
            advance === null
              ? sql`${conversations.projectedMembershipVersion}`
              : sql`case when ${conversations.projectedMembershipVersion} >= ${advance.from} then greatest(${conversations.projectedMembershipVersion}, ${advance.to}) else ${conversations.projectedMembershipVersion} end`,
        })
        .where(eq(conversations.id, conversation.id))
        .returning({
          memberCount: conversations.memberCount,
          projectedVersion: conversations.projectedMembershipVersion,
        });
      const after = updated[0];
      if (after === undefined) throw new Error('A locked conversation vanished during an apply.');
      return {
        kind: 'applied',
        ...counts,
        projectedVersion: after.projectedVersion ?? 0,
        memberCount: after.memberCount,
      } as const;
    });
  }

  /**
   * The projection rows, written in ONE statement of eleven array parameters
   * — a batch of 1,000 is not 11,000 bind values to build and serialize while
   * the conversation lock is held. The register's guard is repeated here, in
   * the database: only a newer version writes, whatever the code decided.
   * The reconciler's override is the one writer allowed past it.
   */
  private async upsertProjected(
    tx: Transaction,
    writes: readonly Participant[],
    override: boolean,
  ): Promise<{ readonly userId: string; readonly current: boolean }[]> {
    const column = <T>(pick: (participant: Participant) => T) => sql.param(writes.map(pick));
    const result = await tx.execute(sql`
      insert into ${conversationParticipants} (
        conversation_id, user_id, role, joined_at, left_at, added_by, last_read_sequence,
        hidden_through_sequence, source_version, source_membership_id, source_joined_at)
      select * from unnest(
        ${column((p) => p.conversationId)}::text[],
        ${column((p) => p.userId)}::text[],
        ${column((p) => p.role)}::text[],
        ${column((p) => p.joinedAt)}::timestamptz[],
        ${column((p) => p.leftAt)}::timestamptz[],
        ${column((p) => p.addedBy)}::text[],
        ${column((p) => p.lastReadSequence)}::bigint[],
        ${column((p) => p.hiddenThroughSequence)}::bigint[],
        ${column((p) => p.sourceVersion)}::bigint[],
        ${column((p) => p.sourceMembershipId)}::text[],
        ${column((p) => p.sourceJoinedAt)}::timestamptz[])
      on conflict (conversation_id, user_id) do update set
        role = excluded.role,
        joined_at = excluded.joined_at,
        left_at = excluded.left_at,
        added_by = excluded.added_by,
        last_read_sequence = excluded.last_read_sequence,
        hidden_through_sequence = excluded.hidden_through_sequence,
        source_version = excluded.source_version,
        source_membership_id = excluded.source_membership_id,
        source_joined_at = excluded.source_joined_at
      ${override ? sql`` : sql`where coalesce(${conversationParticipants.sourceVersion}, 0) < excluded.source_version`}
      returning user_id, left_at is null as current`);
    return result.rows.map((row) => ({
      userId: String(row.user_id),
      current: row.current === true,
    }));
  }

  async resetProjectedVersion(conversationId: ConversationId, to: number): Promise<void> {
    if (!Number.isSafeInteger(to) || to < 0) {
      throw new RangeError('A projected version is a whole number from 0.');
    }
    await this.db
      .update(conversations)
      .set({ projectedMembershipVersion: to })
      .where(and(eq(conversations.id, conversationId), isNotNull(conversations.communityId)));
  }

  private async participant(
    db: Executor,
    conversationId: string,
    userId: string,
  ): Promise<Participant | null> {
    const rows = await db
      .select()
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toParticipant(row);
  }

  private async byClientMessageId(db: Executor, draft: MessageDraft): Promise<Message | null> {
    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, draft.conversationId),
          eq(messages.senderId, draft.senderId),
          eq(messages.clientMessageId, draft.clientMessageId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return toMessage(row, await this.attachmentsOf(db, row.id));
  }

  private async attachmentsOf(db: Executor, messageId: string) {
    const rows = await db
      .select({
        fileAssetId: messageAttachments.fileAssetId,
        position: messageAttachments.position,
      })
      .from(messageAttachments)
      .where(eq(messageAttachments.messageId, messageId))
      .orderBy(asc(messageAttachments.position));
    return rows;
  }
}
