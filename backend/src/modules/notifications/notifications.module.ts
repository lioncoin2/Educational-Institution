import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { IdentityModule } from '../identity/identity.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsController } from './api/notifications.controller';
import { RegisterDeviceUseCase, UnregisterDeviceUseCase } from './application/devices.use-cases';
import {
  CountUnreadNotificationsUseCase,
  ListNotificationsUseCase,
  MarkAllNotificationsReadUseCase,
  MarkNotificationReadUseCase,
} from './application/inbox.use-cases';
import { MessagingNotificationTranslator } from './application/messaging-notification.translator';
import { NotificationDispatcher } from './application/notification-dispatcher';
import { NotificationReaderService } from './application/notification-reader.service';
import {
  GetNotificationPreferencesUseCase,
  UpdateNotificationPreferencesUseCase,
} from './application/preferences.use-cases';
import {
  DEFAULT_PUSH_DELIVERY_SETTINGS,
  PUSH_DELIVERY_SETTINGS,
  PushDelivery,
} from './application/push-delivery';
import { NOTIFICATION_READER } from './contracts/notification-reader';
import {
  DEVICE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  PREFERENCE_REPOSITORY,
  type DeviceRepository,
  type NotificationRepository,
  type PreferenceRepository,
} from './domain/ports';
import { PUSH_PROVIDER } from './domain/push';
import { DrizzleDeviceRepository } from './infrastructure/drizzle-device-repository';
import { DrizzleNotificationRepository } from './infrastructure/drizzle-notification-repository';
import { DrizzlePreferenceRepository } from './infrastructure/drizzle-preference-repository';
import {
  InMemoryDeviceRepository,
  InMemoryNotificationRepository,
  InMemoryPreferenceRepository,
} from './infrastructure/in-memory-notification-stores';
import { LoggingPushProvider } from './infrastructure/logging-push-provider';

/**
 * Notifications — a person's inbox, and delivery of what lands in it.
 *
 *   business event (messaging's, today)
 *     → MessagingNotificationTranslator  who, and what kind of notification
 *     → NotificationDispatcher           active account? wanted? new? → stored once
 *     → notifications.notification.created
 *         → realtime (another module): live to the recipient's connections
 *         → PushDelivery: to the recipient's devices, through PUSH_PROVIDER
 *
 * It depends on identity's contracts (who is active, what an account is
 * called) and messaging's (its events; who may read a conversation). Nothing
 * depends on it but realtime, through `NOTIFICATION_READER`. The push
 * provider is chosen here: in V1, a logging adapter — no push SDK is
 * installed (docs/architecture/notifications.md, "Push").
 */
@Module({
  imports: [IdentityModule, MessagingModule],
  controllers: [NotificationsController],
  providers: [
    {
      provide: NOTIFICATION_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: AppConfig, db: Database) =>
        (config.database.configured
          ? new DrizzleNotificationRepository(db)
          : new InMemoryNotificationRepository()) satisfies NotificationRepository,
    },
    {
      provide: PREFERENCE_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: AppConfig, db: Database) =>
        (config.database.configured
          ? new DrizzlePreferenceRepository(db)
          : new InMemoryPreferenceRepository()) satisfies PreferenceRepository,
    },
    {
      provide: DEVICE_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: AppConfig, db: Database) =>
        (config.database.configured
          ? new DrizzleDeviceRepository(db)
          : new InMemoryDeviceRepository()) satisfies DeviceRepository,
    },
    // The one line a real push provider changes.
    { provide: PUSH_PROVIDER, useClass: LoggingPushProvider },
    { provide: PUSH_DELIVERY_SETTINGS, useValue: DEFAULT_PUSH_DELIVERY_SETTINGS },

    NotificationDispatcher,
    MessagingNotificationTranslator,
    PushDelivery,
    ListNotificationsUseCase,
    CountUnreadNotificationsUseCase,
    MarkNotificationReadUseCase,
    MarkAllNotificationsReadUseCase,
    GetNotificationPreferencesUseCase,
    UpdateNotificationPreferencesUseCase,
    RegisterDeviceUseCase,
    UnregisterDeviceUseCase,
    { provide: NOTIFICATION_READER, useClass: NotificationReaderService },
  ],
  exports: [NOTIFICATION_READER],
})
export class NotificationsModule {}
