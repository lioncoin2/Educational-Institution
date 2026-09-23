import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { NotificationCategory } from '../contracts/vocabulary';
import type { PreferenceRepository } from '../domain/ports';
import type { ChannelPreferences, StoredPreferences } from '../domain/preferences';
import { notificationPreferences } from './schema';

/** Preferences in Postgres: one keyed lookup for a whole page of recipients. */
@Injectable()
export class DrizzlePreferenceRepository implements PreferenceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async forUsers(userIds: readonly string[]): Promise<ReadonlyMap<string, StoredPreferences>> {
    const byUser = new Map<string, Map<NotificationCategory, ChannelPreferences>>();
    if (userIds.length === 0) return byUser;
    const rows = await this.db
      .select()
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, [...new Set(userIds)]));
    for (const row of rows) {
      const stored = byUser.get(row.userId) ?? new Map<NotificationCategory, ChannelPreferences>();
      stored.set(row.category, { inApp: row.inApp, realtime: row.realtime, push: row.push });
      byUser.set(row.userId, stored);
    }
    return byUser;
  }

  async save(
    userId: string,
    category: NotificationCategory,
    preferences: ChannelPreferences,
    at: Date,
  ): Promise<void> {
    const values = {
      inApp: preferences.inApp,
      realtime: preferences.realtime,
      push: preferences.push,
      updatedAt: at,
    };
    await this.db
      .insert(notificationPreferences)
      .values({ userId, category, ...values })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.category],
        set: values,
      });
  }
}
