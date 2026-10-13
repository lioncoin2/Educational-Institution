import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { NotificationSettingsRepository } from '../domain/ports';
import {
  DEFAULT_USER_NOTIFICATION_SETTINGS,
  type InstitutionQuietHours,
  type UserNotificationSettings,
} from '../domain/quiet-hours';
import { institutionNotificationSettings, userNotificationSettings } from './schema';

const INSTITUTION_ROW = 'institution';

type UserRow = typeof userNotificationSettings.$inferSelect;

function toUserSettings(row: UserRow): UserNotificationSettings {
  if (
    row.quietHoursMode === 'CUSTOM' &&
    row.quietHoursStart !== null &&
    row.quietHoursEnd !== null
  ) {
    return {
      timezone: row.timezone,
      quietHours: {
        mode: 'CUSTOM',
        window: { start: row.quietHoursStart, end: row.quietHoursEnd },
      },
    };
  }
  return {
    timezone: row.timezone,
    quietHours: { mode: row.quietHoursMode === 'DISABLED' ? 'DISABLED' : 'INHERIT' },
  };
}

function toUserColumns(settings: UserNotificationSettings) {
  const custom = settings.quietHours.mode === 'CUSTOM' ? settings.quietHours.window : null;
  return {
    timezone: settings.timezone,
    quietHoursMode: settings.quietHours.mode,
    quietHoursStart: custom?.start ?? null,
    quietHoursEnd: custom?.end ?? null,
  };
}

/** Notification settings in Postgres: a singleton institution row, and one row per person. */
@Injectable()
export class DrizzleNotificationSettingsRepository implements NotificationSettingsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async institution(): Promise<InstitutionQuietHours | null> {
    const [row] = await this.db
      .select()
      .from(institutionNotificationSettings)
      .where(eq(institutionNotificationSettings.id, INSTITUTION_ROW));
    if (row === undefined) return null;
    return {
      enabled: row.quietHoursEnabled,
      window: { start: row.quietHoursStart, end: row.quietHoursEnd },
      timezone: row.timezone,
    };
  }

  async saveInstitution(
    settings: InstitutionQuietHours,
    at: Date,
    updatedBy: string | null,
  ): Promise<void> {
    const values = {
      quietHoursEnabled: settings.enabled,
      quietHoursStart: settings.window.start,
      quietHoursEnd: settings.window.end,
      timezone: settings.timezone,
      updatedAt: at,
      updatedBy,
    };
    await this.db
      .insert(institutionNotificationSettings)
      .values({ id: INSTITUTION_ROW, ...values })
      .onConflictDoUpdate({ target: institutionNotificationSettings.id, set: values });
  }

  async settingsForUsers(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, UserNotificationSettings>> {
    const byUser = new Map<string, UserNotificationSettings>();
    if (userIds.length === 0) return byUser;
    const rows = await this.db
      .select()
      .from(userNotificationSettings)
      .where(inArray(userNotificationSettings.userId, [...new Set(userIds)]));
    for (const row of rows) byUser.set(row.userId, toUserSettings(row));
    return byUser;
  }

  async getUserSettings(userId: string): Promise<UserNotificationSettings> {
    const [row] = await this.db
      .select()
      .from(userNotificationSettings)
      .where(eq(userNotificationSettings.userId, userId));
    return row === undefined ? DEFAULT_USER_NOTIFICATION_SETTINGS : toUserSettings(row);
  }

  async saveUserSettings(
    userId: string,
    settings: UserNotificationSettings,
    at: Date,
  ): Promise<void> {
    const columns = toUserColumns(settings);
    await this.db
      .insert(userNotificationSettings)
      .values({ userId, ...columns, updatedAt: at })
      .onConflictDoUpdate({
        target: userNotificationSettings.userId,
        set: { ...columns, updatedAt: at },
      });
  }
}
