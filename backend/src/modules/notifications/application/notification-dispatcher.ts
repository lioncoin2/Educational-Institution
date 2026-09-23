import { Inject, Injectable } from '@nestjs/common';

import {
  MAX_RECIPIENTS_PER_REQUEST,
  type NotificationRequest,
  type NotificationSender,
} from '../contracts';
import { NOTIFICATION_DELIVERY, type NotificationDelivery } from '../domain/ports';

/**
 * The single exit. It knows templates and recipients — never why something
 * happened. Preferences, mute and quiet hours will filter here, so every
 * source of notifications obeys them without knowing they exist.
 */
@Injectable()
export class NotificationDispatcher implements NotificationSender {
  constructor(@Inject(NOTIFICATION_DELIVERY) private readonly delivery: NotificationDelivery) {}

  async send(request: NotificationRequest): Promise<void> {
    const recipients = [...new Set(request.recipientUserIds)];
    if (recipients.length === 0) return;
    if (recipients.length > MAX_RECIPIENTS_PER_REQUEST) {
      throw new RangeError(
        `A notification request names at most ${MAX_RECIPIENTS_PER_REQUEST} recipients.`,
      );
    }
    await this.delivery.deliver({
      recipientUserIds: recipients,
      template: request.template,
      params: request.params,
      collapseKey: request.collapseKey ?? null,
    });
  }
}
