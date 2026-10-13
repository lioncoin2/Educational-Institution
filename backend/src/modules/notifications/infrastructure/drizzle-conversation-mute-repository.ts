import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { ConversationMute } from '../domain/conversation-mute';
import type { ConversationMuteRepository } from '../domain/ports';
import { conversationMutes } from './schema';

/** Conversation mutes in Postgres: one keyed lookup for a whole page of recipients. */
@Injectable()
export class DrizzleConversationMuteRepository implements ConversationMuteRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async mutedConversationsForUsers(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const byUser = new Map<string, Set<string>>();
    if (userIds.length === 0) return byUser;
    const rows = await this.db
      .select({
        userId: conversationMutes.userId,
        conversationId: conversationMutes.conversationId,
      })
      .from(conversationMutes)
      .where(inArray(conversationMutes.userId, [...new Set(userIds)]));
    for (const row of rows) {
      const set = byUser.get(row.userId) ?? new Set<string>();
      set.add(row.conversationId);
      byUser.set(row.userId, set);
    }
    return byUser;
  }

  async listMuted(userId: string): Promise<readonly ConversationMute[]> {
    const rows = await this.db
      .select()
      .from(conversationMutes)
      .where(eq(conversationMutes.userId, userId))
      .orderBy(desc(conversationMutes.mutedAt), desc(conversationMutes.conversationId));
    return rows.map((row) => ({ conversationId: row.conversationId, mutedAt: row.mutedAt }));
  }

  async mute(
    userId: string,
    conversationId: string,
    at: Date,
  ): Promise<{ readonly created: boolean }> {
    const inserted = await this.db
      .insert(conversationMutes)
      .values({ userId, conversationId, mutedAt: at })
      .onConflictDoNothing()
      .returning({ conversationId: conversationMutes.conversationId });
    return { created: inserted.length > 0 };
  }

  async unmute(userId: string, conversationId: string): Promise<{ readonly removed: boolean }> {
    const removed = await this.db
      .delete(conversationMutes)
      .where(
        and(
          eq(conversationMutes.userId, userId),
          eq(conversationMutes.conversationId, conversationId),
        ),
      )
      .returning({ conversationId: conversationMutes.conversationId });
    return { removed: removed.length > 0 };
  }
}
