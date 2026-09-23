import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module';
import { MessageSentNotifier } from './application/message-sent.notifier';
import { NotificationDispatcher } from './application/notification-dispatcher';
import { NOTIFICATION_SENDER } from './contracts';
import { NOTIFICATION_DELIVERY } from './domain/ports';
import { LoggingNotificationDelivery } from './infrastructure/logging-notification-delivery';

/**
 * Notifications — reaching people. It subscribes to the facts other modules
 * publish (messaging's, today) and exposes `NOTIFICATION_SENDER` for direct
 * requests. The delivery adapter is chosen here; no push provider is
 * configured in V1.
 */
@Module({
  imports: [MessagingModule],
  providers: [
    { provide: NOTIFICATION_DELIVERY, useClass: LoggingNotificationDelivery },
    NotificationDispatcher,
    { provide: NOTIFICATION_SENDER, useExisting: NotificationDispatcher },
    MessageSentNotifier,
  ],
  exports: [NOTIFICATION_SENDER],
})
export class NotificationsModule {}
