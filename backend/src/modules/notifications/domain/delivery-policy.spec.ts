import { asId } from '../../../shared';
import { validateRegistration } from './device';
import type { Notification } from './notification';
import {
  DEFAULT_CHANNEL_PREFERENCES,
  applyChange,
  effectiveChannels,
  preferencesFor,
} from './preferences';
import { PushRetryPolicy, pushMessageFor, retryDelayMs } from './push';

describe('preferences', () => {
  it('start with everything on', () => {
    expect(DEFAULT_CHANNEL_PREFERENCES).toEqual({ inApp: true, realtime: true, push: true });
    expect(preferencesFor(undefined, 'MESSAGES')).toEqual(DEFAULT_CHANNEL_PREFERENCES);
    expect(preferencesFor(new Map(), 'MESSAGES')).toEqual(DEFAULT_CHANNEL_PREFERENCES);
  });

  it('change only the channels named', () => {
    expect(applyChange(DEFAULT_CHANNEL_PREFERENCES, { push: false })).toEqual({
      inApp: true,
      realtime: true,
      push: false,
    });
  });

  it('never let turning push off take the notification center with it', () => {
    expect(effectiveChannels({ inApp: true, realtime: true, push: false })).toEqual({
      store: true,
      realtime: true,
      push: false,
    });
    expect(effectiveChannels({ inApp: true, realtime: false, push: true })).toEqual({
      store: true,
      realtime: false,
      push: true,
    });
  });

  it('deliver nothing that is not stored: the center is the record', () => {
    expect(effectiveChannels({ inApp: false, realtime: true, push: true })).toEqual({
      store: false,
      realtime: false,
      push: false,
    });
  });
});

describe('device registration', () => {
  const fcm = `fcm:${'A'.repeat(60)}`;

  it('accepts a plausible token per provider, and normalizes APNs hex', () => {
    expect(validateRegistration({ platform: 'ANDROID', provider: 'FCM', token: fcm })).toEqual({
      ok: true,
      value: { platform: 'ANDROID', provider: 'FCM', token: fcm },
    });
    const apns = 'ABCDEF0123456789'.repeat(4);
    const result = validateRegistration({ platform: 'IOS', provider: 'APNS', token: apns });
    expect(result.ok && result.value.token).toBe(apns.toLowerCase());
  });

  it('refuses what is certainly not a token', () => {
    const field = (input: { platform: string; provider: string; token: string }) => {
      const result = validateRegistration(input);
      return result.ok ? null : result.error.details?.field;
    };
    expect(field({ platform: 'ANDROID', provider: 'APNS', token: 'a'.repeat(64) })).toBe(
      'provider',
    );
    expect(field({ platform: 'IOS', provider: 'APNS', token: 'not hex at all, not at all' })).toBe(
      'token',
    );
    expect(field({ platform: 'WEB', provider: 'FCM', token: 'short' })).toBe('token');
    expect(field({ platform: 'WEB', provider: 'FCM', token: `${fcm} <script>` })).toBe('token');
    expect(field({ platform: 'WINDOWS', provider: 'FCM', token: fcm })).toBe('platform');
    expect(field({ platform: 'WEB', provider: 'PIGEON', token: fcm })).toBe('provider');
  });
});

describe('what a push says', () => {
  const notification: Notification = {
    id: asId<'Notification'>('n-1'),
    recipientUserId: 'user-1',
    type: 'MESSAGE_RECEIVED',
    category: 'MESSAGES',
    titleKey: 'notification.message_received.title',
    bodyKey: 'notification.message_received.body',
    params: { senderDisplayName: 'أحمد', messageType: 'TEXT', conversationType: 'DIRECT' },
    target: { kind: 'conversation', conversationId: 'c-1' },
    dedupeKey: 'message:m-1:user:user-1',
    createdAt: new Date('2026-09-01T08:00:00Z'),
    readAt: null,
  };

  // The lock-screen policy: the kind of thing that happened, nothing more.
  it('carries no name and no content by default — a lock screen is read by whoever holds it', () => {
    const message = pushMessageFor(notification);
    expect(message).toEqual({
      notificationId: 'n-1',
      type: 'MESSAGE_RECEIVED',
      titleKey: 'notification.message_received.title',
      bodyKey: 'notification.message_received.body_private',
      bodyArgs: [],
      target: { kind: 'conversation', conversationId: 'c-1' },
      threadKey: 'conversation:c-1',
    });
    expect(JSON.stringify(message)).not.toContain('أحمد');
  });

  it('backs off between retries, and waits at least as long as the provider asks', () => {
    expect(retryDelayMs(1)).toBe(PushRetryPolicy.baseDelayMs);
    expect(retryDelayMs(2)).toBe(PushRetryPolicy.baseDelayMs * 2);
    expect(retryDelayMs(3, 30)).toBe(30_000);
    expect(retryDelayMs(1, 60)).toBe(PushRetryPolicy.maxDelayMs);
    expect(retryDelayMs(20)).toBe(PushRetryPolicy.maxDelayMs);
  });

  it('never retries sooner than asked — asked to wait longer than a retry is held, it gives up', () => {
    expect(retryDelayMs(1, 61)).toBeNull();
    expect(retryDelayMs(1, 3600)).toBeNull();
    expect(retryDelayMs(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('ignores a retry-after that is not a positive number — an adapter mistake, not an instruction', () => {
    expect(retryDelayMs(2, 0)).toBe(PushRetryPolicy.baseDelayMs * 2);
    expect(retryDelayMs(2, -5)).toBe(PushRetryPolicy.baseDelayMs * 2);
    expect(retryDelayMs(2, Number.NaN)).toBe(PushRetryPolicy.baseDelayMs * 2);
  });
});
