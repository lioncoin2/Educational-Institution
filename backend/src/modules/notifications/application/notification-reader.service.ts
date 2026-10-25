import { Inject, Injectable } from '@nestjs/common';

import {
  NOTIFICATION_READER_MAX_IDS,
  type NotificationReader,
  type NotificationView,
} from '../contracts/notification-reader';
import { NOTIFICATION_REPOSITORY, type NotificationRepository } from '../domain/ports';
import { NotificationContextResolver } from './notification-context';
import { toNotificationView } from './views';

/**
 * The reader realtime uses to render a notification it was told about: one
 * lookup for a whole batch, rendered by the same view the HTTP inbox uses —
 * read-time context included (ADR 0046), each for its own recipient — so a
 * notification looks the same however it arrives.
 */
@Injectable()
export class NotificationReaderService implements NotificationReader {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly context: NotificationContextResolver,
  ) {}

  async forDelivery(ids: readonly string[]): Promise<readonly NotificationView[]> {
    const unique = [...new Set(ids)];
    if (unique.length > NOTIFICATION_READER_MAX_IDS) {
      throw new RangeError(`At most ${NOTIFICATION_READER_MAX_IDS} notifications per call.`);
    }
    return this.context.withContext(
      (await this.notifications.findByIds(unique)).map(toNotificationView),
    );
  }
}
