import { InProcessEventBus } from '../../src/platform/events/event-bus';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { InMemoryRateLimiter } from '../../src/platform/rate-limit/in-memory-rate-limiter';
import type { DomainEvent, EventPublisher, Principal } from '../../src/shared';
import {
  RegisterDeviceUseCase,
  UnregisterDeviceUseCase,
} from '../../src/modules/notifications/application/devices.use-cases';
import {
  CountUnreadNotificationsUseCase,
  ListNotificationsUseCase,
  MarkAllNotificationsReadUseCase,
  MarkNotificationReadUseCase,
} from '../../src/modules/notifications/application/inbox.use-cases';
import { MessagingNotificationTranslator } from '../../src/modules/notifications/application/messaging-notification.translator';
import { NotificationDispatcher } from '../../src/modules/notifications/application/notification-dispatcher';
import { NotificationReaderService } from '../../src/modules/notifications/application/notification-reader.service';
import {
  GetNotificationPreferencesUseCase,
  UpdateNotificationPreferencesUseCase,
} from '../../src/modules/notifications/application/preferences.use-cases';
import {
  PushDelivery,
  type PushDeliverySettings,
} from '../../src/modules/notifications/application/push-delivery';
import type { NotificationView } from '../../src/modules/notifications/application/views';
import type { NotificationRequest } from '../../src/modules/notifications/domain/notification';
import type {
  DeviceRepository,
  NotificationRepository,
  PreferenceRepository,
} from '../../src/modules/notifications/domain/ports';
import type {
  PushDevice,
  PushMessage,
  PushOutcome,
  PushProvider,
} from '../../src/modules/notifications/domain/push';
import {
  InMemoryDeviceRepository,
  InMemoryNotificationRepository,
  InMemoryPreferenceRepository,
} from '../../src/modules/notifications/infrastructure/in-memory-notification-stores';
import { RecordingAuditLog, RecordingEvents, expectOk } from './identity-harness';
import { META, messagingHarness } from './messaging-harness';

/**
 * A push provider that records every call and answers as scripted: by default
 * "delivered"; `answer(token, …)` scripts one device's outcomes in order (the
 * last repeats), and `throwFor(token)` makes it fail without classifying.
 */
export class FakePushProvider implements PushProvider {
  readonly sent: { readonly device: PushDevice; readonly message: PushMessage }[] = [];
  readonly registered: Omit<PushDevice, 'id'>[] = [];
  readonly unregistered: PushDevice[] = [];
  refuseRegistration = false;
  private readonly scripts = new Map<string, PushOutcome[]>();
  private readonly throwing = new Set<string>();

  answer(token: string, ...outcomes: PushOutcome[]): void {
    this.scripts.set(token, outcomes);
  }

  throwFor(token: string): void {
    this.throwing.add(token);
  }

  async registerDevice(device: Omit<PushDevice, 'id'>): Promise<{ readonly accepted: boolean }> {
    this.registered.push(device);
    return { accepted: !this.refuseRegistration };
  }

  async unregisterDevice(device: PushDevice): Promise<void> {
    this.unregistered.push(device);
  }

  async send(device: PushDevice, message: PushMessage): Promise<PushOutcome> {
    this.sent.push({ device, message });
    if (this.throwing.has(device.token)) throw new Error('provider exploded');
    const script = this.scripts.get(device.token);
    if (script === undefined || script.length === 0) return { kind: 'delivered' };
    return script.length === 1 ? script[0] : (script.shift() as PushOutcome);
  }

  sendsTo(token: string): number {
    return this.sent.filter((send) => send.device.token === token).length;
  }
}

/** Fast retries, so a test of three attempts takes milliseconds. */
export const FAST_PUSH: PushDeliverySettings = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 5,
  concurrency: 4,
};

/** A plausible FCM registration token, distinct per `n`. */
export function fcmToken(n: number | string): string {
  return `fcm-token-${String(n).padStart(4, '0')}:APA91b${'x'.repeat(40)}`;
}

/** A plausible APNs device token (64 hex characters). */
export function apnsToken(n: number): string {
  return n.toString(16).padStart(64, 'a');
}

/**
 * The notifications application layer, wired by hand over the REAL messaging
 * application layer: messaging's use cases publish to an in-process bus,
 * exactly as in the running server, and the translator, the push delivery and
 * (in the realtime suites) the realtime relay subscribe to it. Every adapter
 * is in memory unless one is passed in — the Postgres suite passes Drizzle's.
 */
export async function notificationsHarness(
  options: {
    readonly notifications?: NotificationRepository;
    readonly preferences?: PreferenceRepository;
    readonly devices?: DeviceRepository;
    readonly push?: FakePushProvider;
  } = {},
) {
  const messaging = await messagingHarness();
  const clock = messaging.clock;
  const failures: { event: string; error: unknown }[] = [];
  const bus = new InProcessEventBus((event, error) => failures.push({ event: event.name, error }));

  // Messaging's use cases publish to its recording publisher; forward to the bus.
  const recordMessaging = messaging.events.publish.bind(messaging.events);
  messaging.events.publish = async (events: readonly DomainEvent[]) => {
    await recordMessaging(events);
    await bus.publish(events);
  };

  // Notifications' own events: recorded, then onto the same bus.
  const published = new RecordingEvents();
  const events: EventPublisher = {
    async publish(batch) {
      await published.publish(batch);
      await bus.publish(batch);
    },
  };

  const notifications = options.notifications ?? new InMemoryNotificationRepository();
  const preferences = options.preferences ?? new InMemoryPreferenceRepository();
  const devices = options.devices ?? new InMemoryDeviceRepository();
  const push = options.push ?? new FakePushProvider();
  const audit = new RecordingAuditLog();
  const limiter = new InMemoryRateLimiter(clock);
  const ids = new UuidIdGenerator();

  const dispatcher = new NotificationDispatcher(
    notifications,
    preferences,
    messaging.directory,
    events,
    clock,
    ids,
  );
  const translator = new MessagingNotificationTranslator(
    bus,
    messaging.recipients,
    messaging.directory,
    dispatcher,
  );
  translator.onModuleInit();
  const pushDelivery = new PushDelivery(bus, notifications, devices, push, audit, clock, FAST_PUSH);
  pushDelivery.onModuleInit();

  const h = {
    messaging,
    clock,
    bus,
    failures,
    published,
    events,
    notifications,
    preferences,
    devices,
    push,
    audit,
    limiter,
    dispatcher,
    translator,
    pushDelivery,
    reader: new NotificationReaderService(notifications),
    list: new ListNotificationsUseCase(notifications),
    countUnread: new CountUnreadNotificationsUseCase(notifications),
    markRead: new MarkNotificationReadUseCase(notifications, events, clock),
    markAllRead: new MarkAllNotificationsReadUseCase(notifications, events, clock),
    getPreferences: new GetNotificationPreferencesUseCase(preferences),
    updatePreferences: new UpdateNotificationPreferencesUseCase(preferences, clock),
    registerDevice: new RegisterDeviceUseCase(devices, push, limiter, audit, clock, ids),
    unregisterDevice: new UnregisterDeviceUseCase(devices, push, audit, clock),

    /** Resolves once every fact published so far is translated, stored and pushed. */
    async settle(): Promise<void> {
      await translator.idle();
      await pushDelivery.idle();
    },

    /** Everything in `principal`'s inbox, newest first — every page. */
    async inbox(principal: Principal): Promise<NotificationView[]> {
      const all: NotificationView[] = [];
      let cursor: string | undefined;
      do {
        const page = expectOk(await h.list.execute({ principal, cursor, limit: 50 }));
        all.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return all;
    },

    async unread(principal: Principal): Promise<{ count: number; capped: boolean }> {
      return expectOk(await h.countUnread.execute({ principal }));
    },

    /** Registers a device for `principal` and returns its id. */
    async device(principal: Principal, token: string, platform = 'ANDROID'): Promise<string> {
      return expectOk(
        await h.registerDevice.execute({
          principal,
          platform,
          provider: 'FCM',
          token,
          meta: META,
        }),
      ).id;
    },

    /** Notification events of one name, as published. */
    eventsNamed(name: string): DomainEvent[] {
      return published.published.filter((event) => event.name === name);
    },

    async cleanup(): Promise<void> {
      translator.onModuleDestroy();
      pushDelivery.onModuleDestroy();
      await messaging.cleanup();
    },
  };
  return h;
}

export type NotificationsHarness = Awaited<ReturnType<typeof notificationsHarness>>;

/** A request as a translator would build it — for dispatcher-level tests. */
export function messageRequest(
  recipientUserId: string,
  messageId: string,
  conversationId = 'c-1',
): NotificationRequest {
  return {
    recipientUserId,
    type: 'MESSAGE_RECEIVED',
    titleKey: 'notification.message_received.title',
    bodyKey: 'notification.message_received.body',
    params: { senderDisplayName: 'أحمد', messageType: 'TEXT', conversationType: 'GROUP' },
    target: { kind: 'conversation', conversationId },
    dedupeKey: `message:${messageId}:user:${recipientUserId}`,
  };
}
