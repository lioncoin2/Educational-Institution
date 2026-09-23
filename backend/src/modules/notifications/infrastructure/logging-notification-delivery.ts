import { Logger } from '@nestjs/common';

import type { NotificationDelivery, OutboundNotification } from '../domain/ports';

/**
 * PLACEHOLDER delivery: records that a notification would have gone out.
 * No push provider exists yet (FCM/APNs are not chosen — Q24), and none is
 * imported anywhere; the real adapter replaces this class and nothing else.
 *
 * It logs the template and the recipient COUNT — never recipient ids in bulk,
 * never parameters that could one day carry more than ids.
 */
export class LoggingNotificationDelivery implements NotificationDelivery {
  private readonly logger = new Logger('Notifications');

  async deliver(notification: OutboundNotification): Promise<void> {
    this.logger.debug(
      {
        template: notification.template,
        recipients: notification.recipientUserIds.length,
        collapseKey: notification.collapseKey,
      },
      'notification (not delivered: no provider configured)',
    );
  }
}
