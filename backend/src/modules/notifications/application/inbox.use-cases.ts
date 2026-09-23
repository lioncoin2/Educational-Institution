import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  EVENT_PUBLISHER,
  domainEvent,
  err,
  failure,
  ok,
  type Clock,
  type EventPublisher,
  type Principal,
  type Result,
} from '../../../shared';
import {
  NotificationEvents,
  type AllNotificationsRead,
  type NotificationRead,
} from '../contracts/events';
import { NotificationLimits } from '../domain/notification-policy';
import { NOTIFICATION_REPOSITORY, type NotificationRepository } from '../domain/ports';
import { decodeNotificationCursor, encodeNotificationCursor } from './cursors';
import { toNotificationView, type NotificationView, type UnreadCountView } from './views';

/**
 * A person's own inbox. There is no permission to hold and none to check:
 * every query and change is scoped to the principal's own id, so the only
 * notifications anyone can list, count or mark are their own — another
 * person's id is indistinguishable from one that does not exist.
 *
 * Opening what a notification points at is NOT done here. The client takes
 * the target to the owning module's API, which authorizes it as it would any
 * request: a notification is never a way into anything.
 */
const NOT_FOUND = failure(
  'not_found',
  'notifications.notification_not_found',
  'There is no such notification.',
);

@Injectable()
export class ListNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
  ) {}

  async execute(input: {
    readonly principal: Principal;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<{ items: NotificationView[]; nextCursor: string | null }>> {
    const after = decodeNotificationCursor(input.cursor);
    if (!after.ok) return after;
    const limit = Math.max(
      1,
      Math.min(input.limit ?? NotificationLimits.defaultPageSize, NotificationLimits.maxPageSize),
    );
    const page = await this.notifications.list(input.principal.userId, {
      limit,
      after: after.value,
    });
    return ok({
      items: page.items.map(toNotificationView),
      nextCursor: page.next === null ? null : encodeNotificationCursor(page.next),
    });
  }
}

@Injectable()
export class CountUnreadNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
  ) {}

  /** Counted up to the cap, never further: "99+" needs no more precision than that. */
  async execute(input: { readonly principal: Principal }): Promise<Result<UnreadCountView>> {
    const cap = NotificationLimits.unreadCountCap;
    const counted = await this.notifications.countUnread(input.principal.userId, cap + 1);
    return ok({ count: Math.min(counted, cap), capped: counted > cap });
  }
}

@Injectable()
export class MarkNotificationReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Idempotent: marking a read notification again changes nothing and says so by its `readAt`. */
  async execute(input: {
    readonly principal: Principal;
    readonly notificationId: string;
  }): Promise<Result<NotificationView>> {
    const userId = input.principal.userId;
    const marked = await this.notifications.markRead(
      userId,
      input.notificationId,
      this.clock.now(),
    );
    if (marked === null) return err(NOT_FOUND);
    const { notification, changed } = marked;
    if (changed && notification.readAt !== null) {
      const event: NotificationRead = domainEvent(
        NotificationEvents.read,
        userId,
        {
          recipientUserId: userId,
          notificationId: notification.id,
          readAt: notification.readAt.toISOString(),
        },
        notification.readAt,
      );
      await this.events.publish([event]);
    }
    return ok(toNotificationView(notification));
  }
}

@Injectable()
export class MarkAllNotificationsReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Marks read everything up to a boundary: the notification `throughId`
   * (the newest one the person was looking at) or, without it, everything
   * created until now. So one that arrives while the request is on its way
   * stays unread. Done in chunks of rows, never one unbounded UPDATE;
   * `complete` is false if the chunk limit stopped it early, and calling
   * again finishes the job.
   */
  async execute(input: {
    readonly principal: Principal;
    readonly throughId?: string;
  }): Promise<Result<{ markedRead: number; complete: boolean }>> {
    const userId = input.principal.userId;
    const now = this.clock.now();
    let through: { createdAt: Date; id: string | null } = { createdAt: now, id: null };
    if (input.throughId !== undefined) {
      const boundary = await this.notifications.find(userId, input.throughId);
      if (boundary === null) return err(NOT_FOUND);
      through = { createdAt: boundary.createdAt, id: boundary.id };
    }

    let markedRead = 0;
    let complete = false;
    for (let chunk = 0; chunk < NotificationLimits.markAllMaxChunks; chunk++) {
      const changed = await this.notifications.markReadThrough(
        userId,
        through,
        now,
        NotificationLimits.markAllChunk,
      );
      markedRead += changed;
      if (changed < NotificationLimits.markAllChunk) {
        complete = true;
        break;
      }
    }

    if (markedRead > 0) {
      const event: AllNotificationsRead = domainEvent(
        NotificationEvents.allRead,
        userId,
        {
          recipientUserId: userId,
          throughCreatedAt: through.createdAt.toISOString(),
          throughId: through.id,
          readAt: now.toISOString(),
          count: markedRead,
        },
        now,
      );
      await this.events.publish([event]);
    }
    return ok({ markedRead, complete });
  }
}
