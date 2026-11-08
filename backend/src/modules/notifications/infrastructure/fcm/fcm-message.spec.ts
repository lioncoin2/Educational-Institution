import { asId } from '../../../../shared';
import { NOTIFICATION_TYPES, type NotificationType } from '../../contracts/vocabulary';
import {
  ACTIVE_CATEGORIES,
  NOTIFICATION_CATALOG,
  privateBodyKeyOf,
  titleKeyOf,
} from '../../domain/catalog';
import type { NotificationTarget } from '../../contracts/targets';
import { pushMessageFor, type PushDevice } from '../../domain/push';
import { androidResourceName, channelIdOf, fcmSendRequest } from './fcm-message';

const DEVICE: PushDevice = {
  id: 'device-1',
  platform: 'ANDROID',
  provider: 'FCM',
  token: 'fcm-token-0001:APA91bxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
};

function messageOf(type: NotificationType, target: NotificationTarget) {
  return pushMessageFor({
    id: asId<'Notification'>('n-1'),
    recipientUserId: 'u-1',
    type,
    category: NOTIFICATION_CATALOG[type].category,
    titleKey: titleKeyOf(type),
    bodyKey: `notification.${type.toLowerCase()}.body`,
    params: { senderDisplayName: 'أحمد', messagePreview: 'سرّ' },
    target,
    dedupeKey: 'k',
    createdAt: new Date('2026-11-08T08:00:00.000Z'),
    readAt: null,
  });
}

describe('the FCM send request', () => {
  it('carries keys, a channel, a thread tag and ids — no sentence, no name, no content', () => {
    const request = fcmSendRequest(
      DEVICE,
      messageOf('MESSAGE_RECEIVED', { kind: 'conversation', conversationId: 'c-1' }),
    );
    expect(request).toEqual({
      message: {
        token: DEVICE.token,
        data: {
          notificationId: 'n-1',
          type: 'MESSAGE_RECEIVED',
          target: '{"kind":"conversation","conversationId":"c-1"}',
        },
        android: {
          priority: 'HIGH',
          ttl: '86400s',
          notification: {
            title_loc_key: 'notification_message_received_title',
            body_loc_key: 'notification_message_received_body_private',
            channel_id: 'messages',
            tag: 'conversation:c-1',
            default_sound: true,
          },
        },
      },
    });
    const wire = JSON.stringify(request);
    expect(wire).not.toContain('أحمد');
    expect(wire).not.toContain('سرّ');
  });

  // FCM shows a non-empty literal title or body INSTEAD of a localization key,
  // and a top-level notification object makes the message a display message
  // with no Android keys at all: the request must carry neither.
  it('has no top-level notification and no literal title or body anywhere', () => {
    const request = fcmSendRequest(
      DEVICE,
      messageOf('TASK_REMINDER', { kind: 'assigned_task', taskId: 't-1' }),
    ) as {
      message: Record<string, unknown> & { android: { notification: Record<string, unknown> } };
    };
    expect(request.message.notification).toBeUndefined();
    expect(Object.keys(request.message.android.notification)).not.toEqual(
      expect.arrayContaining(['title']),
    );
    expect(request.message.android.notification.title).toBeUndefined();
    expect(request.message.android.notification.body).toBeUndefined();
  });

  it('lets a live room push go stale in fifteen minutes, everything else in a day', () => {
    const live = fcmSendRequest(
      DEVICE,
      messageOf('LIVE_SPEAKER_GRANTED', { kind: 'live_room', liveSessionId: 's-1' }),
    ) as { message: { android: { ttl: string } } };
    expect(live.message.android.ttl).toBe('900s');
  });

  it('asks FCM only to check, when validating', () => {
    const request = fcmSendRequest(
      DEVICE,
      messageOf('MESSAGE_RECEIVED', { kind: 'conversation', conversationId: 'c-1' }),
      { validateOnly: true },
    );
    expect(request.validate_only).toBe(true);
  });

  // The app ships a string resource per key and a channel per category; these
  // are the names it must ship (its completeness test reads the same catalog).
  it('names, for every type that may be pushed, a string resource and a channel the app can ship', () => {
    for (const type of NOTIFICATION_TYPES) {
      for (const key of [titleKeyOf(type), privateBodyKeyOf(type)]) {
        expect(androidResourceName(key)).toMatch(/^notification_[a-z0-9_]+$/);
      }
      expect(channelIdOf(type)).toMatch(/^[a-z]+$/);
    }
    expect(
      [
        ...new Set(
          NOTIFICATION_TYPES.filter((t) => NOTIFICATION_CATALOG[t].active).map(channelIdOf),
        ),
      ].sort(),
    ).toEqual(ACTIVE_CATEGORIES.map((category) => category.toLowerCase()).sort());
  });
});
