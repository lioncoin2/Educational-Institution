import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  EVENT_SUBSCRIBER,
  type DomainEvent,
  type EventSubscriber,
  type Unsubscribe,
} from '../../../shared';
import {
  NOTIFICATION_READER,
  NOTIFICATION_READER_MAX_IDS,
  NotificationEvents,
  type AllNotificationsRead,
  type NotificationCreated,
  type NotificationRead,
  type NotificationReader,
} from '../../notifications/contracts';
import { ConnectionManager } from './connection-manager';
import {
  notificationCreatedFrame,
  notificationReadFrame,
  notificationsReadFrame,
} from './envelopes';

/**
 * Notifications, delivered live to their recipient's connections — the same
 * connections, on the same `ConnectionManager`, as messaging's events. There
 * is one socket per client, never a second one for notifications.
 *
 *   notification.created   to the recipient only, if their preferences allow
 *                          realtime and they are connected here
 *   notification.read      to the recipient's connections: a notification
 *   notification.read_all  was read on one of their devices
 *
 * A notification is personal, so there is no audience to compute and nothing
 * is ever sent by role, organisation, permission or channel: the recipient is
 * the one account the stored notification names, read back from the database
 * — not taken from the event.
 *
 * Realtime stores nothing and decides nothing about notifications. They are
 * stored before anything reaches this class; if it is down, or the recipient
 * is offline, they are in the inbox when the app next asks.
 *
 * Creations are gathered for one turn of the event loop and rendered with one
 * read, so a page of a thousand recipients costs one query, only for those
 * connected here.
 */
@Injectable()
export class NotificationRealtimeRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRealtimeRelay.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly pending = new Set<string>();
  private scheduled = false;
  private delivering: Promise<void> = Promise.resolve();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(NOTIFICATION_READER) private readonly reader: NotificationReader,
    private readonly connections: ConnectionManager,
  ) {}

  onModuleInit(): void {
    for (const name of [
      NotificationEvents.created,
      NotificationEvents.read,
      NotificationEvents.allRead,
    ]) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  schedule(event: DomainEvent): void {
    switch (event.name) {
      case NotificationEvents.created: {
        const payload = createdPayload(event);
        if (payload === null) return this.malformed(event);
        if (!payload.channels.realtime) return;
        if (!this.connections.isOnline(payload.recipientUserId)) return;
        this.pending.add(payload.notificationId);
        if (this.scheduled) return;
        this.scheduled = true;
        setImmediate(() => {
          this.scheduled = false;
          this.delivering = this.delivering
            .then(() => this.deliverPending())
            .catch((error: unknown) =>
              this.logger.error({ err: error }, 'realtime notification delivery failed'),
            );
        });
        return;
      }
      case NotificationEvents.read: {
        const payload = readPayload(event);
        if (payload === null) return this.malformed(event);
        this.connections.sendToUser(
          payload.recipientUserId,
          notificationReadFrame({ notificationId: payload.notificationId, readAt: payload.readAt }),
        );
        return;
      }
      case NotificationEvents.allRead: {
        const payload = allReadPayload(event);
        if (payload === null) return this.malformed(event);
        this.connections.sendToUser(
          payload.recipientUserId,
          notificationsReadFrame({
            throughCreatedAt: payload.throughCreatedAt,
            throughId: payload.throughId,
            readAt: payload.readAt,
          }),
        );
        return;
      }
    }
  }

  /** Resolves once everything scheduled so far has been delivered — for tests and shutdown. */
  async idle(): Promise<void> {
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.delivering;
      if (!this.scheduled && this.pending.size === 0) return;
    }
  }

  private async deliverPending(): Promise<void> {
    while (this.pending.size > 0) {
      const ids = [...this.pending].slice(0, NOTIFICATION_READER_MAX_IDS);
      for (const id of ids) this.pending.delete(id);
      for (const view of await this.reader.forDelivery(ids)) {
        this.connections.sendToUser(view.recipientUserId, notificationCreatedFrame(view));
      }
    }
  }

  private malformed(event: DomainEvent): void {
    this.logger.warn({ event: event.name }, 'ignoring a malformed notification event');
  }
}

// Events cross a module boundary: their shape is checked, not assumed.

type Fields<T> = Partial<Record<keyof T, unknown>>;

function fieldsOf<T>(event: DomainEvent, name: string): Fields<T> | null {
  const payload = event.payload;
  if (event.name !== name || payload === null || typeof payload !== 'object') return null;
  return payload;
}

function createdPayload(event: DomainEvent): NotificationCreated['payload'] | null {
  const p = fieldsOf<NotificationCreated['payload']>(event, NotificationEvents.created);
  if (
    p === null ||
    typeof p.notificationId !== 'string' ||
    typeof p.recipientUserId !== 'string' ||
    p.channels === null ||
    typeof p.channels !== 'object' ||
    typeof (p.channels as { realtime?: unknown }).realtime !== 'boolean'
  ) {
    return null;
  }
  return p as NotificationCreated['payload'];
}

function readPayload(event: DomainEvent): NotificationRead['payload'] | null {
  const p = fieldsOf<NotificationRead['payload']>(event, NotificationEvents.read);
  if (
    p === null ||
    typeof p.recipientUserId !== 'string' ||
    typeof p.notificationId !== 'string' ||
    typeof p.readAt !== 'string'
  ) {
    return null;
  }
  return p as NotificationRead['payload'];
}

function allReadPayload(event: DomainEvent): AllNotificationsRead['payload'] | null {
  const p = fieldsOf<AllNotificationsRead['payload']>(event, NotificationEvents.allRead);
  if (
    p === null ||
    typeof p.recipientUserId !== 'string' ||
    typeof p.throughCreatedAt !== 'string' ||
    (p.throughId !== null && typeof p.throughId !== 'string') ||
    typeof p.readAt !== 'string'
  ) {
    return null;
  }
  return p as AllNotificationsRead['payload'];
}
