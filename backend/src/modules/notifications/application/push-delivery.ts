import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  EVENT_SUBSCRIBER,
  type AuditLog,
  type Clock,
  type DomainEvent,
  type EventSubscriber,
  type Unsubscribe,
} from '../../../shared';
import { NotificationEvents, type NotificationCreated } from '../contracts/events';
import type { Device } from '../domain/device';
import type { Notification } from '../domain/notification';
import {
  DEVICE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  type DeviceRepository,
  type NotificationRepository,
} from '../domain/ports';
import {
  PUSH_PROVIDER,
  PushRetryPolicy,
  pushMessageFor,
  retryDelayMs,
  type PushDevice,
  type PushMessage,
  type PushOutcome,
  type PushProvider,
} from '../domain/push';
import { DEVICE_RESOURCE, NotificationAuditActions } from './notification-settings';

/** DI token: retry pacing and parallelism, so tests can run it in milliseconds. */
export const PUSH_DELIVERY_SETTINGS = Symbol('PUSH_DELIVERY_SETTINGS');

export interface PushDeliverySettings {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Sends in flight at once. */
  readonly concurrency: number;
}

export const DEFAULT_PUSH_DELIVERY_SETTINGS: PushDeliverySettings = Object.freeze({
  ...PushRetryPolicy,
  concurrency: 16,
});

/** Notifications per lookup of notifications and of their recipients' devices. */
const BATCH = 1000;

/**
 * Push: stored notifications, sent to their recipients' registered devices
 * through the configured `PushProvider`.
 *
 * It subscribes to `notifications.notification.created` — so it only ever
 * sends a notification that is already stored, and exactly once per stored
 * notification however often its source fact was delivered. What it sends is
 * decided by `pushMessageFor` (no names, no content on a lock screen).
 *
 * Each outcome, as the provider adapter classifies it:
 *
 *   delivered       done
 *   retryable       tried again after a backoff, up to `maxAttempts`, then given up
 *   invalid_token   the device is disabled — push skips it from now on
 *   rejected        logged, never retried: the same message would fail the same way
 *
 * Nothing here can touch the notification itself: a push that fails, or a
 * provider that is down, leaves it in the inbox, where the app finds it.
 * Retries are in memory — a restart forgets them — which is acceptable for a
 * best-effort channel; a durable queue is the outbox's job (events.md).
 *
 * Logs name the device id, platform, provider, notification id and type —
 * never a token, never the notification's parameters.
 */
@Injectable()
export class PushDelivery implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDelivery.name);
  private unsubscribe: Unsubscribe | null = null;
  private readonly pending = new Set<string>();
  private scheduled = false;
  private flushing: Promise<void> = Promise.resolve();
  private readonly retries = new Map<NodeJS.Timeout, () => void>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUSH_DELIVERY_SETTINGS) private readonly settings: PushDeliverySettings,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.subscriber.subscribe(NotificationEvents.created, (event) =>
      this.schedule(event),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [timer, settle] of this.retries) {
      clearTimeout(timer);
      settle();
    }
    this.retries.clear();
  }

  /**
   * Notes a new notification for push, and returns at once. Everything noted
   * in one turn of the event loop — a whole page of recipients — is sent from
   * one lookup of notifications and one of devices.
   */
  schedule(event: DomainEvent): void {
    const payload = createdPayload(event);
    if (payload === null || !payload.channels.push) return;
    this.pending.add(payload.notificationId);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.flushing = this.flushing
        .then(() => this.flush())
        .catch((error: unknown) => this.logger.error({ err: error }, 'push delivery failed'));
      this.track(this.flushing);
    });
  }

  /** Resolves once everything noted so far — retries included — is settled. For tests and shutdown. */
  async idle(): Promise<void> {
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.inFlight.size === 0 && this.pending.size === 0 && !this.scheduled) return;
      await Promise.all([...this.inFlight]);
    }
  }

  private async flush(): Promise<void> {
    while (this.pending.size > 0) {
      const ids = [...this.pending].slice(0, BATCH);
      for (const id of ids) this.pending.delete(id);
      const notifications = (await this.notifications.findByIds(ids)).filter(
        // Read on another device before push got to it: nothing to announce.
        (notification) => notification.readAt === null,
      );
      if (notifications.length === 0) continue;
      const devices = await this.devices.enabledForUsers([
        ...new Set(notifications.map((notification) => notification.recipientUserId)),
      ]);
      const byUser = new Map<string, Device[]>();
      for (const device of devices) {
        byUser.set(device.userId, [...(byUser.get(device.userId) ?? []), device]);
      }
      const sends: (() => Promise<void>)[] = [];
      for (const notification of notifications) {
        const message = pushMessageFor(notification);
        for (const device of byUser.get(notification.recipientUserId) ?? []) {
          sends.push(() => this.send(device, notification, message, 1));
        }
      }
      await inParallel(sends, this.settings.concurrency);
    }
  }

  private async send(
    device: Device,
    notification: Notification,
    message: PushMessage,
    attempt: number,
  ): Promise<void> {
    let outcome: PushOutcome;
    try {
      outcome = await this.provider.send(pushDevice(device), message);
    } catch (error) {
      // An adapter that throws has not classified the failure: treat it as
      // transient, which the attempt limit bounds.
      outcome = { kind: 'retryable', reason: error instanceof Error ? error.name : 'error' };
    }
    const context = {
      deviceId: device.id,
      platform: device.platform,
      provider: device.provider,
      notificationId: notification.id,
      type: notification.type,
      attempt,
    };
    switch (outcome.kind) {
      case 'delivered':
        return;
      case 'rejected':
        this.logger.warn({ ...context, reason: outcome.reason }, 'push rejected; not retried');
        return;
      case 'invalid_token':
        await this.devices.disable(device.id, this.clock.now());
        await this.audit.record({
          actorUserId: null,
          action: NotificationAuditActions.deviceDisabled,
          resourceType: DEVICE_RESOURCE,
          resourceId: device.id,
          at: this.clock.now(),
          metadata: {
            userId: device.userId,
            platform: device.platform,
            provider: device.provider,
            reason: 'invalid_token',
          },
        });
        this.logger.warn(
          { ...context, reason: outcome.reason },
          'push token invalid; device disabled',
        );
        return;
      case 'retryable': {
        if (attempt >= this.settings.maxAttempts) {
          this.logger.warn({ ...context, reason: outcome.reason }, 'push failed; giving up');
          return;
        }
        const delay = retryDelayMs(attempt, outcome.retryAfterSeconds, this.settings);
        this.logger.debug({ ...context, reason: outcome.reason, delay }, 'push failed; retrying');
        this.track(
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.retries.delete(timer);
              this.send(device, notification, message, attempt + 1)
                .catch((error: unknown) =>
                  this.logger.error({ ...context, err: error }, 'push retry failed'),
                )
                .finally(resolve);
            }, delay);
            timer.unref();
            this.retries.set(timer, resolve);
          }),
        );
        return;
      }
    }
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }
}

/** What a provider may know of a device: its address, not its owner. */
function pushDevice(device: Device): PushDevice {
  return {
    id: device.id,
    platform: device.platform,
    provider: device.provider,
    token: device.token,
  };
}

/** Runs `tasks` with at most `limit` in flight. */
async function inParallel(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      if (task !== undefined) await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function createdPayload(event: DomainEvent): NotificationCreated['payload'] | null {
  const p = event.payload as Partial<Record<keyof NotificationCreated['payload'], unknown>> | null;
  if (
    event.name !== NotificationEvents.created ||
    p === null ||
    typeof p !== 'object' ||
    typeof p.notificationId !== 'string' ||
    typeof p.recipientUserId !== 'string' ||
    p.channels === null ||
    typeof p.channels !== 'object' ||
    typeof (p.channels as { push?: unknown }).push !== 'boolean'
  ) {
    return null;
  }
  return p as NotificationCreated['payload'];
}
