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
import type { SessionReference } from '../../identity/contracts/access-tokens';
import {
  ACTIVE_SESSIONS,
  ACTIVE_SESSIONS_MAX_BATCH,
  type ActiveSessions,
} from '../../identity/contracts/active-sessions';
import { MessagingEvents, type MessageRead } from '../../messaging/contracts';
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
  threadKeyOf,
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
  /**
   * At most one push per person and thread (a conversation, a task, a live
   * room) in this window — until the person reads the conversation, which
   * opens it again. The inbox still receives every notification.
   */
  readonly threadWindowMs: number;
}

export const DEFAULT_PUSH_DELIVERY_SETTINGS: PushDeliverySettings = Object.freeze({
  ...PushRetryPolicy,
  // A provider's HTTP API answers a send in tens of milliseconds: at this
  // width a community of a thousand is announced in seconds.
  concurrency: 64,
  // Long enough to fold a burst into one buzz; short enough that a reply to
  // someone who just put the phone down still reaches them.
  threadWindowMs: 15_000,
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
 * Only to devices whose session is still live (ADR 0058). Identity is asked, a
 * page at a time, which of the devices' sessions have not ended; a device whose
 * session ended — however it ended — is forgotten (audited), and one registered
 * before sessions were recorded is skipped until the app registers it again.
 * If identity cannot answer, nothing of that page is sent: a push to a phone
 * its owner signed out of is worse than a missing one, which the inbox makes up.
 *
 * At most one push per person and thread in `threadWindowMs`: a burst in a
 * busy conversation buzzes once, and the inbox carries the rest. Reading the
 * conversation (`messaging.message.read`) ends the window for that person, so
 * the next message after a read always buzzes.
 *
 * A retry goes only where the first send could have: before it, the
 * notification must still be unread and the device's session still live.
 *
 * Each outcome, as the provider adapter classifies it:
 *
 *   delivered       done
 *   retryable       tried again after a backoff, up to `maxAttempts`, then given
 *                   up; never sooner than the provider's `retryAfterSeconds`, and
 *                   not at all if it asks for longer than a retry is held
 *   invalid_token   the device is disabled — push skips it from now on
 *   rejected        never retried: the same message would fail the same way (the
 *                   adapter says why, once in a while — not once per send)
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
  private unsubscribeReads: Unsubscribe | null = null;
  private readonly pending = new Set<string>();
  private scheduled = false;
  private flushing: Promise<void> = Promise.resolve();
  private readonly retries = new Map<NodeJS.Timeout, () => void>();
  private readonly inFlight = new Set<Promise<void>>();
  /** recipient + thread → when it was last pushed (epoch ms), within the window. */
  private readonly lastPushed = new Map<string, number>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    @Inject(ACTIVE_SESSIONS) private readonly sessions: ActiveSessions,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUSH_DELIVERY_SETTINGS) private readonly settings: PushDeliverySettings,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.subscriber.subscribe(NotificationEvents.created, (event) =>
      this.schedule(event),
    );
    this.unsubscribeReads = this.subscriber.subscribe(MessagingEvents.messageRead, (event) =>
      this.noteRead(event),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeReads?.();
    this.unsubscribeReads = null;
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

  /**
   * The person read a conversation: its next message buzzes again, however
   * soon — they may have put the phone down to wait for the answer.
   */
  noteRead(event: DomainEvent): void {
    const read = readPayload(event);
    if (read === null) return;
    this.lastPushed.delete(
      `${read.userId}\u0000${threadKeyOf({ kind: 'conversation', conversationId: read.conversationId })}`,
    );
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
      const devices = await this.inLiveSessions(
        await this.devices.enabledForUsers([
          ...new Set(notifications.map((notification) => notification.recipientUserId)),
        ]),
      );
      const byUser = new Map<string, Device[]>();
      for (const device of devices) {
        byUser.set(device.userId, [...(byUser.get(device.userId) ?? []), device]);
      }
      const now = this.clock.now().getTime();
      this.forgetQuietThreads(now);
      const sends: (() => Promise<void>)[] = [];
      for (const notification of notifications) {
        const targets = byUser.get(notification.recipientUserId);
        if (targets === undefined) continue;
        const message = pushMessageFor(notification);
        const thread = `${notification.recipientUserId}\u0000${message.threadKey}`;
        // This thread buzzed this person a moment ago; the inbox has the rest.
        if (this.lastPushed.has(thread)) continue;
        this.lastPushed.set(thread, now);
        for (const device of targets) {
          sends.push(() => this.send(device, notification, message, 1));
        }
      }
      await inParallel(sends, this.settings.concurrency);
    }
  }

  /**
   * The devices among `devices` whose session is live. A device whose session
   * ended is forgotten on the way; one with no session is skipped. When
   * identity cannot answer: none.
   */
  private async inLiveSessions(devices: readonly Device[]): Promise<readonly Device[]> {
    const bound = devices.filter((device) => device.sessionId !== null);
    if (bound.length === 0) return [];
    const refs = new Map<string, SessionReference>();
    for (const device of bound) {
      const ref = { userId: device.userId, sessionId: device.sessionId ?? '' };
      refs.set(referenceKey(ref), ref);
    }
    const live = new Set<string>();
    try {
      for (let at = 0; at < refs.size; at += ACTIVE_SESSIONS_MAX_BATCH) {
        const page = [...refs.values()].slice(at, at + ACTIVE_SESSIONS_MAX_BATCH);
        for (const ref of await this.sessions.activeAmong(page)) live.add(referenceKey(ref));
      }
    } catch (error) {
      this.logger.error(
        { err: error, devices: bound.length },
        'session lookup failed; push withheld for this page',
      );
      return [];
    }
    const isLive = (device: Device) =>
      live.has(referenceKey({ userId: device.userId, sessionId: device.sessionId ?? '' }));
    await inParallel(
      bound.filter((device) => !isLive(device)).map((device) => () => this.forgetEnded(device)),
      this.settings.concurrency,
    );
    return bound.filter(isLive);
  }

  /**
   * Whether a retry may still go: a minute or two after the first send, the
   * notification may have been read, or the session ended. Fails closed.
   */
  private async stillWanted(device: Device, notification: Notification): Promise<boolean> {
    if (device.sessionId === null) return false;
    try {
      const [current] = await this.notifications.findByIds([notification.id]);
      if (current === undefined || current.readAt !== null) return false;
      const live = await this.sessions.activeAmong([
        { userId: device.userId, sessionId: device.sessionId },
      ]);
      if (live.length > 0) return true;
      await this.forgetEnded(device);
      return false;
    } catch (error) {
      this.logger.warn(
        { err: error, deviceId: device.id, notificationId: notification.id },
        'push retry withheld: could not re-check it',
      );
      return false;
    }
  }

  /** A device whose session ended: forgotten — unless registered again meanwhile. */
  private async forgetEnded(device: Device): Promise<void> {
    try {
      if (!(await this.devices.removeIfSession(device.id, device.sessionId))) return;
      await this.provider.unregisterDevice(pushDevice(device));
      await this.audit.record({
        actorUserId: null,
        action: NotificationAuditActions.deviceSessionEnded,
        resourceType: DEVICE_RESOURCE,
        resourceId: device.id,
        at: this.clock.now(),
        metadata: {
          userId: device.userId,
          platform: device.platform,
          provider: device.provider,
          reason: 'session_ended',
        },
      });
    } catch (error) {
      // It receives nothing either way; the next page tries again.
      this.logger.warn(
        { err: error, deviceId: device.id },
        'could not forget a device whose session ended',
      );
    }
  }

  private forgetQuietThreads(now: number): void {
    for (const [thread, at] of this.lastPushed) {
      if (now - at >= this.settings.threadWindowMs) this.lastPushed.delete(thread);
    }
  }

  private async send(
    device: Device,
    notification: Notification,
    message: PushMessage,
    attempt: number,
  ): Promise<void> {
    if (attempt > 1 && !(await this.stillWanted(device, notification))) return;
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
        // The adapter logs why, once in a while; a misconfiguration must not
        // write a line per device.
        this.logger.debug({ ...context, reason: outcome.reason }, 'push rejected; not retried');
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
        if (delay === null) {
          this.logger.warn(
            { ...context, reason: outcome.reason, retryAfterSeconds: outcome.retryAfterSeconds },
            'push throttled for longer than a retry is held; giving up',
          );
          return;
        }
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

/** A NUL cannot occur in an id, so the key is unambiguous. */
function referenceKey(ref: SessionReference): string {
  return `${ref.sessionId}\u0000${ref.userId}`;
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

function readPayload(event: DomainEvent): MessageRead['payload'] | null {
  const p = event.payload as Partial<Record<keyof MessageRead['payload'], unknown>> | null;
  if (
    event.name !== MessagingEvents.messageRead ||
    p === null ||
    typeof p !== 'object' ||
    typeof p.conversationId !== 'string' ||
    typeof p.userId !== 'string'
  ) {
    return null;
  }
  return p as MessageRead['payload'];
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
