import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CLOCK,
  EVENT_PUBLISHER,
  ID_GENERATOR,
  domainEvent,
  type Clock,
  type EventPublisher,
  type IdGenerator,
} from '../../../shared';
import {
  ACCOUNT_DIRECTORY,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import { NotificationEvents, type NotificationCreated } from '../contracts/events';
import {
  createNotification,
  type Notification,
  type NotificationId,
  type NotificationRequest,
} from '../domain/notification';
import { NotificationLimits } from '../domain/notification-policy';
import {
  NOTIFICATION_REPOSITORY,
  PREFERENCE_REPOSITORY,
  type NotificationRepository,
  type PreferenceRepository,
} from '../domain/ports';
import { effectiveChannels, preferencesFor } from '../domain/preferences';

export interface DispatchOutcome {
  /** Stored now — each announced once by `notifications.notification.created`. */
  readonly created: readonly Notification[];
  /** Already stored by an earlier delivery of the same fact, or repeated in this batch. */
  readonly duplicates: number;
  /** Refused by validation — a translator's bug, logged. */
  readonly invalid: number;
  /** For accounts that are unknown or may not sign in (pending, suspended, disabled). */
  readonly inactive: number;
  /** For people who turned this category off. */
  readonly optedOut: number;
}

/**
 * The single way a notification comes to exist — for every source.
 *
 * It knows notification requests, never why they were made: translators turn
 * their module's facts into requests; this decides, the same way for all of
 * them, what is stored:
 *
 *   1. valid     every field checked by the domain (`createNotification`)
 *   2. active    the recipient's account may sign in now — a suspended or
 *                disabled account gets no new notifications (and keeps the
 *                ones it has); asked of identity, one call per batch
 *   3. wanted    the recipient's IN_APP preference for the category
 *   4. new       INSERT … ON CONFLICT DO NOTHING on (recipient, dedupeKey):
 *                the database, not a prior read, decides — so the same fact
 *                delivered twice, even concurrently, stores one row
 *   5. announced one `notifications.notification.created` per row actually
 *                stored, carrying the realtime and push decisions
 *
 * Delivery is not its business: it never sends anything. Realtime and push
 * subscribe to the event, so a failure there cannot undo the notification.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(PREFERENCE_REPOSITORY) private readonly preferences: PreferenceRepository,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async dispatch(
    requests: readonly NotificationRequest[],
    correlationId?: string,
  ): Promise<DispatchOutcome> {
    if (requests.length > NotificationLimits.maxRequestsPerDispatch) {
      throw new RangeError(
        `A dispatch holds at most ${NotificationLimits.maxRequestsPerDispatch} requests; page larger audiences.`,
      );
    }
    const now = this.clock.now();

    let invalid = 0;
    let duplicates = 0;
    const candidates: Notification[] = [];
    const inBatch = new Set<string>();
    for (const request of requests) {
      const created = createNotification(request, this.ids.next<'Notification'>(), now);
      if (!created.ok) {
        invalid += 1;
        this.logger.warn(
          { type: request.type, field: created.error.details?.field, code: created.error.code },
          'refusing an invalid notification request',
        );
        continue;
      }
      const key = `${created.value.recipientUserId}\u0000${created.value.dedupeKey}`;
      if (inBatch.has(key)) {
        duplicates += 1;
        continue;
      }
      inBatch.add(key);
      candidates.push(created.value);
    }
    if (candidates.length === 0) {
      return { created: [], duplicates, invalid, inactive: 0, optedOut: 0 };
    }

    const recipients = [...new Set(candidates.map((notification) => notification.recipientUserId))];
    const accounts = await this.directory.describe(recipients);
    const active = new Set(accounts.filter((account) => account.active).map((a) => a.userId));
    const stored = await this.preferences.forUsers([...active]);

    let inactive = 0;
    let optedOut = 0;
    const wanted: Notification[] = [];
    const channels = new Map<NotificationId, { realtime: boolean; push: boolean }>();
    for (const notification of candidates) {
      if (!active.has(notification.recipientUserId)) {
        inactive += 1;
        continue;
      }
      const decided = effectiveChannels(
        preferencesFor(stored.get(notification.recipientUserId), notification.category),
      );
      if (!decided.store) {
        optedOut += 1;
        continue;
      }
      wanted.push(notification);
      channels.set(notification.id, { realtime: decided.realtime, push: decided.push });
    }

    const created = await this.notifications.insertMany(wanted);
    duplicates += wanted.length - created.length;

    if (created.length > 0) {
      await this.events.publish(
        created.map((notification): NotificationCreated =>
          domainEvent(
            NotificationEvents.created,
            notification.recipientUserId,
            {
              notificationId: notification.id,
              recipientUserId: notification.recipientUserId,
              type: notification.type,
              channels: channels.get(notification.id) ?? { realtime: false, push: false },
            },
            now,
            correlationId,
          ),
        ),
      );
    }
    return { created, duplicates, invalid, inactive, optedOut };
  }
}
