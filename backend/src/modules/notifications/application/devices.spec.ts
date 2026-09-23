import { Logger } from '@nestjs/common';

import { expectOk } from '../../../../test/support/identity-harness';
import { META } from '../../../../test/support/messaging-harness';
import {
  apnsToken,
  fcmToken,
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';
import { toDeviceResponse } from '../api/responses';
import { NotificationLimits } from '../domain/notification-policy';
import { DEVICE_REGISTRATIONS_PER_USER, NotificationAuditActions } from './notification-settings';

describe('push devices', () => {
  let h: NotificationsHarness;
  let teacher: Principal;
  let ali: Principal;
  let sara: Principal;

  beforeEach(async () => {
    h = await notificationsHarness();
    teacher = h.messaging.person('TEACHER', 'الأستاذ أحمد');
    ali = h.messaging.person('STUDENT', 'علي');
    sara = h.messaging.person('STUDENT', 'سارة');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await h.cleanup();
  });

  const register = (principal: Principal, token: string, platform = 'ANDROID', provider = 'FCM') =>
    h.registerDevice.execute({ principal, platform, provider, token, meta: META });

  it('registers the caller’s own device — and answers without its token', async () => {
    const device = expectOk(await register(ali, fcmToken(1)));
    expect(device).toEqual({
      id: expect.any(String),
      platform: 'ANDROID',
      provider: 'FCM',
      createdAt: h.clock.now(),
      lastSeenAt: h.clock.now(),
    });
    expect(JSON.stringify(toDeviceResponse(device))).not.toContain(fcmToken(1));
    expect(h.push.registered).toEqual([
      { platform: 'ANDROID', provider: 'FCM', token: fcmToken(1) },
    ]);
  });

  it('records the registration in the audit trail — never the token', async () => {
    const device = expectOk(await register(ali, fcmToken(1)));
    expect(h.audit.last(NotificationAuditActions.deviceRegistered)).toEqual({
      actorUserId: ali.userId,
      action: 'notifications.device.registered',
      resourceType: 'notifications.device',
      resourceId: device.id,
      at: h.clock.now(),
      correlationId: META.correlationId,
      metadata: { platform: 'ANDROID', provider: 'FCM' },
    });
    expect(JSON.stringify(h.audit.entries)).not.toContain(fcmToken(1));
  });

  it('never writes a token to the log', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'debug', 'warn', 'error', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const id = await h.device(ali, fcmToken(1));
    h.push.answer(fcmToken(1), { kind: 'invalid_token', reason: 'UNREGISTERED' });
    await h.messaging.direct(teacher, ali); // a notification to push
    await h.settle();
    expectOk(await h.unregisterDevice.execute({ principal: ali, deviceId: id, meta: META }));
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(fcmToken(1));
  });

  it('keeps several devices per person, each receiving push', async () => {
    await h.device(ali, fcmToken(1), 'ANDROID');
    await h.device(ali, fcmToken(2), 'WEB');
    expectOk(await register(ali, apnsToken(3), 'IOS', 'APNS'));
    await h.messaging.direct(teacher, ali);
    await h.settle();
    expect(h.push.sent.map((send) => send.device.platform).sort()).toEqual([
      'ANDROID',
      'IOS',
      'WEB',
    ]);
  });

  it('refreshes a device registered again: same id, seen again, not duplicated', async () => {
    const first = expectOk(await register(ali, fcmToken(1)));
    h.clock.advance(3600);
    const again = expectOk(await register(ali, fcmToken(1)));
    expect(again.id).toBe(first.id);
    expect(again.lastSeenAt).toEqual(h.clock.now());
    expect(await h.devices.enabledForUsers([ali.userId])).toHaveLength(1);
  });

  // A token names an installation; whoever signs in on it now owns it — so a
  // shared tablet stops showing the previous student's notifications.
  it('moves a token to whoever registers it last, and says whose it was', async () => {
    const alis = expectOk(await register(ali, fcmToken(1)));
    const saras = expectOk(await register(sara, fcmToken(1)));
    expect(saras.id).toBe(alis.id);
    expect(await h.devices.enabledForUsers([ali.userId])).toEqual([]);
    expect(h.audit.last(NotificationAuditActions.deviceRegistered)?.metadata).toEqual({
      platform: 'ANDROID',
      provider: 'FCM',
      movedFromUserId: ali.userId,
    });

    await h.messaging.direct(teacher, ali); // Ali is notified…
    await h.settle();
    expect(h.push.sent).toEqual([]); // …but Ali no longer receives push on Sara's device.
  });

  it('lets nobody unregister another person’s device — it does not exist to them', async () => {
    const id = await h.device(ali, fcmToken(1));
    const attempt = await h.unregisterDevice.execute({ principal: sara, deviceId: id, meta: META });
    expect(attempt.ok ? null : attempt.error.code).toBe('notifications.device_not_found');
    expect(await h.devices.enabledForUsers([ali.userId])).toHaveLength(1);
  });

  it('forgets a device its owner unregisters — the app does so on sign-out', async () => {
    const id = await h.device(ali, fcmToken(1));
    expectOk(await h.unregisterDevice.execute({ principal: ali, deviceId: id, meta: META }));
    expect(await h.devices.enabledForUsers([ali.userId])).toEqual([]);
    expect(h.push.unregistered.map((device) => device.id)).toEqual([id]);
    expect(h.audit.actions()).toContain('notifications.device.unregistered');

    await h.messaging.direct(teacher, ali);
    await h.settle();
    expect(h.push.sent).toEqual([]);
  });

  it('keeps at most ten devices, forgetting the one seen least recently', async () => {
    const ids: string[] = [];
    for (let i = 0; i < NotificationLimits.maxActiveDevicesPerUser + 1; i++) {
      ids.push(await h.device(ali, fcmToken(i)));
      h.clock.advance(60);
    }
    const kept = await h.devices.enabledForUsers([ali.userId]);
    expect(kept).toHaveLength(NotificationLimits.maxActiveDevicesPerUser);
    expect(kept.map((device) => device.id)).not.toContain(ids[0]);
    expect(h.audit.last(NotificationAuditActions.deviceEvicted)?.resourceId).toBe(ids[0]);
  });

  it('refuses what is not a token, and a device the provider rejects', async () => {
    const bad = await register(ali, 'not a token', 'ANDROID', 'FCM');
    expect(bad.ok ? null : bad.error.code).toBe('notifications.device_invalid');
    const apnsOnAndroid = await register(ali, apnsToken(1), 'ANDROID', 'APNS');
    expect(apnsOnAndroid.ok ? null : apnsOnAndroid.error.code).toBe('notifications.device_invalid');
    h.push.refuseRegistration = true;
    const refused = await register(ali, fcmToken(9));
    expect(refused.ok ? null : refused.error.code).toBe('notifications.device_rejected');
    expect(await h.devices.enabledForUsers([ali.userId])).toEqual([]);
  });

  it('limits how often one account registers', async () => {
    for (let i = 0; i < DEVICE_REGISTRATIONS_PER_USER.limit; i++) {
      expectOk(await register(ali, fcmToken(1)));
    }
    const limited = await register(ali, fcmToken(1));
    expect(limited.ok ? null : limited.error.code).toBe('notifications.too_many_registrations');
  });
});
