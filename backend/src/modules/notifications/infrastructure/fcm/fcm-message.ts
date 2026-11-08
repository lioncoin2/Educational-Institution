import type { NotificationType } from '../../contracts/vocabulary';
import { NOTIFICATION_CATALOG } from '../../domain/catalog';
import type { PushDevice, PushMessage } from '../../domain/push';

/**
 * The Android notification channel of a type: one per category, by the
 * category's lower-case name. The app creates exactly these channels, so a
 * person can silence one kind of notification in the system settings.
 */
export function channelIdOf(type: NotificationType): string {
  return NOTIFICATION_CATALOG[type].category.toLowerCase();
}

/**
 * A template key as the Android string resource the app ships for it:
 * `notification.message_received.title` → `notification_message_received_title`.
 */
export function androidResourceName(key: string): string {
  return key.replace(/\./g, '_');
}

/** How long FCM holds a push for an unreachable phone: a live room goes stale fast. */
function ttlOf(type: NotificationType): string {
  return NOTIFICATION_CATALOG[type].category === 'LIVE' ? '900s' : '86400s';
}

/**
 * The FCM HTTP v1 send request for one device (ADR 0058).
 *
 * KEYS ONLY: the system renders the title and body from string resources the
 * app ships, in the phone's language — the server sends no sentence. There is
 * deliberately no top-level `notification` object and no literal title or
 * body: FCM prefers a literal over a localization key. `tag` is the thread, so
 * a newer push replaces the older one in the tray instead of piling up. The
 * data carries only ids, for the app to open the right screen on a tap.
 */
export function fcmSendRequest(
  device: PushDevice,
  message: PushMessage,
  options: { readonly validateOnly?: boolean } = {},
): Record<string, unknown> {
  return {
    ...(options.validateOnly === true ? { validate_only: true } : {}),
    message: {
      token: device.token,
      data: {
        notificationId: message.notificationId,
        type: message.type,
        target: JSON.stringify(message.target),
      },
      android: {
        priority: 'HIGH',
        ttl: ttlOf(message.type),
        notification: {
          title_loc_key: androidResourceName(message.titleKey),
          body_loc_key: androidResourceName(message.bodyKey),
          ...(message.bodyArgs.length > 0 ? { body_loc_args: [...message.bodyArgs] } : {}),
          channel_id: channelIdOf(message.type),
          tag: message.threadKey,
          default_sound: true,
        },
      },
    },
  };
}
