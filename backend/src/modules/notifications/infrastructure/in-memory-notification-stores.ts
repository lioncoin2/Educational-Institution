import { Injectable } from '@nestjs/common';

import type { NotificationCategory } from '../contracts/vocabulary';
import type { Device, DeviceId, DeviceRegistration } from '../domain/device';
import type { Notification } from '../domain/notification';
import type {
  DeviceRepository,
  NotificationCursor,
  NotificationRepository,
  PreferenceRepository,
} from '../domain/ports';
import type { ChannelPreferences, StoredPreferences } from '../domain/preferences';

/** Newest first, ties by id — the order every list and boundary uses. */
function newestFirst(a: NotificationCursor, b: NotificationCursor): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** `a` comes strictly after `b` in newest-first order. */
function isAfter(a: NotificationCursor, b: NotificationCursor): boolean {
  return newestFirst(b, a) < 0;
}

const laterOf = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/**
 * Notifications without a database — development, and the unit suites. The
 * same contract as the Postgres adapter, including the one guarantee that
 * matters most: one row per (recipient, dedupeKey), checked and written in a
 * single synchronous step, so concurrent deliveries cannot both win.
 */
@Injectable()
export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly rows = new Map<string, Notification>();
  private readonly dedupe = new Set<string>();

  async insertMany(batch: readonly Notification[]): Promise<readonly Notification[]> {
    const created: Notification[] = [];
    for (const notification of batch) {
      const key = `${notification.recipientUserId}\u0000${notification.dedupeKey}`;
      if (this.dedupe.has(key)) continue;
      this.dedupe.add(key);
      this.rows.set(notification.id, notification);
      created.push(notification);
    }
    return created;
  }

  async list(
    recipientUserId: string,
    page: { readonly limit: number; readonly after?: NotificationCursor },
  ) {
    const after = page.after;
    const mine = this.of(recipientUserId).filter(
      (notification) => after === undefined || isAfter(notification, after),
    );
    const items = mine.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items,
      next:
        mine.length > page.limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  async countUnread(recipientUserId: string, cap: number): Promise<number> {
    return Math.min(
      this.of(recipientUserId).filter((notification) => notification.readAt === null).length,
      cap,
    );
  }

  async find(recipientUserId: string, id: string): Promise<Notification | null> {
    const found = this.rows.get(id);
    return found !== undefined && found.recipientUserId === recipientUserId ? found : null;
  }

  async markRead(recipientUserId: string, id: string, at: Date) {
    const found = await this.find(recipientUserId, id);
    if (found === null) return null;
    if (found.readAt !== null) return { notification: found, changed: false };
    const read = { ...found, readAt: laterOf(found.createdAt, at) };
    this.rows.set(id, read);
    return { notification: read, changed: true };
  }

  async markReadThrough(
    recipientUserId: string,
    through: { readonly createdAt: Date; readonly id: string | null },
    at: Date,
    limit: number,
  ): Promise<number> {
    const boundary = through.createdAt.getTime();
    const due = this.of(recipientUserId)
      .filter((notification) => notification.readAt === null)
      .filter((notification) => {
        const created = notification.createdAt.getTime();
        if (created !== boundary) return created < boundary;
        return through.id === null || notification.id <= through.id;
      })
      .slice(0, limit);
    for (const notification of due) {
      this.rows.set(notification.id, {
        ...notification,
        readAt: laterOf(notification.createdAt, at),
      });
    }
    return due.length;
  }

  async findByIds(ids: readonly string[]): Promise<readonly Notification[]> {
    return ids.flatMap((id) => {
      const found = this.rows.get(id);
      return found === undefined ? [] : [found];
    });
  }

  /** Everything stored, for assertions. */
  all(): readonly Notification[] {
    return [...this.rows.values()].sort(newestFirst);
  }

  private of(recipientUserId: string): Notification[] {
    return [...this.rows.values()]
      .filter((notification) => notification.recipientUserId === recipientUserId)
      .sort(newestFirst);
  }
}

@Injectable()
export class InMemoryPreferenceRepository implements PreferenceRepository {
  private readonly rows = new Map<string, Map<NotificationCategory, ChannelPreferences>>();

  async forUsers(userIds: readonly string[]): Promise<ReadonlyMap<string, StoredPreferences>> {
    const found = new Map<string, StoredPreferences>();
    for (const userId of userIds) {
      const stored = this.rows.get(userId);
      if (stored !== undefined) found.set(userId, new Map(stored));
    }
    return found;
  }

  async save(
    userId: string,
    category: NotificationCategory,
    preferences: ChannelPreferences,
  ): Promise<void> {
    const stored = this.rows.get(userId) ?? new Map<NotificationCategory, ChannelPreferences>();
    stored.set(category, { ...preferences });
    this.rows.set(userId, stored);
  }
}

@Injectable()
export class InMemoryDeviceRepository implements DeviceRepository {
  private readonly rows = new Map<string, Device>();

  async register(input: {
    readonly id: DeviceId;
    readonly userId: string;
    readonly registration: DeviceRegistration;
    readonly at: Date;
  }): Promise<{ readonly device: Device; readonly previousUserId: string | null }> {
    const { provider, platform, token } = input.registration;
    const existing = [...this.rows.values()].find(
      (device) => device.provider === provider && device.token === token,
    );
    if (existing === undefined) {
      const device: Device = {
        id: input.id,
        userId: input.userId,
        platform,
        provider,
        token,
        createdAt: input.at,
        lastSeenAt: input.at,
        disabledAt: null,
      };
      this.rows.set(device.id, device);
      return { device, previousUserId: null };
    }
    const device: Device = {
      ...existing,
      userId: input.userId,
      platform,
      lastSeenAt: laterOf(existing.lastSeenAt, input.at),
      disabledAt: null,
    };
    this.rows.set(device.id, device);
    return {
      device,
      previousUserId: existing.userId === input.userId ? null : existing.userId,
    };
  }

  async find(userId: string, id: string): Promise<Device | null> {
    const found = this.rows.get(id);
    return found !== undefined && found.userId === userId ? found : null;
  }

  async remove(userId: string, id: string): Promise<Device | null> {
    const found = await this.find(userId, id);
    if (found !== null) this.rows.delete(id);
    return found;
  }

  async trim(userId: string, max: number): Promise<readonly Device[]> {
    const stale = [...this.rows.values()]
      .filter((device) => device.userId === userId && device.disabledAt === null)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(max);
    for (const device of stale) this.rows.delete(device.id);
    return stale;
  }

  async enabledForUsers(userIds: readonly string[]): Promise<readonly Device[]> {
    const wanted = new Set(userIds);
    return [...this.rows.values()].filter(
      (device) => wanted.has(device.userId) && device.disabledAt === null,
    );
  }

  async disable(id: DeviceId, at: Date): Promise<void> {
    const found = this.rows.get(id);
    if (found !== undefined && found.disabledAt === null) {
      this.rows.set(id, { ...found, disabledAt: at });
    }
  }

  /** Everything stored, for assertions. */
  all(): readonly Device[] {
    return [...this.rows.values()];
  }
}
