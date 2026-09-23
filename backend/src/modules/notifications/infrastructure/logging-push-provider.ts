import { Injectable, Logger } from '@nestjs/common';

import type { PushDevice, PushMessage, PushOutcome, PushProvider } from '../domain/push';

/**
 * The push provider until a real one is chosen (open-questions.md Q24):
 * records that a push WOULD have been sent, and sends nothing. No Firebase,
 * APNs or web-push SDK is installed anywhere in this codebase; a real adapter
 * replaces this class in `notifications.module.ts` and changes nothing else.
 *
 * It logs the device id, platform, provider and notification type — never
 * the token, never the notification's parameters.
 */
@Injectable()
export class LoggingPushProvider implements PushProvider {
  private readonly logger = new Logger('PushProvider');

  async registerDevice(device: Omit<PushDevice, 'id'>): Promise<{ readonly accepted: boolean }> {
    this.logger.debug(
      { platform: device.platform, provider: device.provider },
      'push device accepted (no provider configured)',
    );
    return { accepted: true };
  }

  async unregisterDevice(device: PushDevice): Promise<void> {
    this.logger.debug(
      { deviceId: device.id, platform: device.platform, provider: device.provider },
      'push device unregistered (no provider configured)',
    );
  }

  async send(device: PushDevice, message: PushMessage): Promise<PushOutcome> {
    this.logger.debug(
      {
        deviceId: device.id,
        platform: device.platform,
        provider: device.provider,
        notificationId: message.notificationId,
        type: message.type,
      },
      'push not sent: no provider configured',
    );
    return { kind: 'delivered' };
  }
}
