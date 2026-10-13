import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';

describe('user notification settings use cases', () => {
  let h: NotificationsHarness;
  let ali: Principal;
  let sara: Principal;

  beforeEach(async () => {
    h = await notificationsHarness();
    ali = h.messaging.person('STUDENT', 'علي');
    sara = h.messaging.person('STUDENT', 'سارة');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('starts at the defaults: no timezone, inherit', async () => {
    expect(expectOk(await h.getSettings.execute({ principal: ali }))).toEqual({
      timezone: null,
      quietHoursMode: 'INHERIT',
      quietHoursStart: null,
      quietHoursEnd: null,
    });
  });

  it('sets a timezone, leaving quiet hours inherited', async () => {
    const view = expectOk(
      await h.updateSettings.execute({ principal: ali, timezone: 'Asia/Baghdad' }),
    );
    expect(view).toEqual({
      timezone: 'Asia/Baghdad',
      quietHoursMode: 'INHERIT',
      quietHoursStart: null,
      quietHoursEnd: null,
    });
  });

  it('sets a custom window', async () => {
    const view = expectOk(
      await h.updateSettings.execute({
        principal: ali,
        quietHoursMode: 'CUSTOM',
        quietHoursStart: '22:00',
        quietHoursEnd: '06:00',
      }),
    );
    expect(view).toMatchObject({
      quietHoursMode: 'CUSTOM',
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
    });
  });

  it('disables quiet hours for the user', async () => {
    const view = expectOk(
      await h.updateSettings.execute({ principal: ali, quietHoursMode: 'DISABLED' }),
    );
    expect(view).toMatchObject({
      quietHoursMode: 'DISABLED',
      quietHoursStart: null,
      quietHoursEnd: null,
    });
  });

  it('is a PATCH: a timezone set earlier survives a later quiet-hours change', async () => {
    expectOk(await h.updateSettings.execute({ principal: ali, timezone: 'UTC' }));
    const view = expectOk(
      await h.updateSettings.execute({ principal: ali, quietHoursMode: 'DISABLED' }),
    );
    expect(view.timezone).toBe('UTC');
    expect(view.quietHoursMode).toBe('DISABLED');
  });

  it('clears the timezone with an explicit null', async () => {
    expectOk(await h.updateSettings.execute({ principal: ali, timezone: 'UTC' }));
    const view = expectOk(await h.updateSettings.execute({ principal: ali, timezone: null }));
    expect(view.timezone).toBeNull();
  });

  it('rejects a change that says nothing', async () => {
    expect(expectErr(await h.updateSettings.execute({ principal: ali }))).toMatchObject({
      code: 'notifications.settings_empty',
    });
  });

  it('rejects an invalid timezone', async () => {
    expect(
      expectErr(await h.updateSettings.execute({ principal: ali, timezone: 'Mars/Phobos' })),
    ).toMatchObject({ code: 'notifications.timezone_invalid' });
  });

  it('rejects a custom mode with no window', async () => {
    expect(
      expectErr(await h.updateSettings.execute({ principal: ali, quietHoursMode: 'CUSTOM' })),
    ).toMatchObject({ code: 'notifications.quiet_hours_window_required' });
  });

  it('rejects a custom window that is not two distinct times', async () => {
    expect(
      expectErr(
        await h.updateSettings.execute({
          principal: ali,
          quietHoursMode: 'CUSTOM',
          quietHoursStart: '22:00',
          quietHoursEnd: '22:00',
        }),
      ),
    ).toMatchObject({ code: 'notifications.quiet_hours_window_invalid' });
  });

  it('rejects a window on a non-custom mode', async () => {
    expect(
      expectErr(
        await h.updateSettings.execute({
          principal: ali,
          quietHoursMode: 'INHERIT',
          quietHoursStart: '22:00',
          quietHoursEnd: '06:00',
        }),
      ),
    ).toMatchObject({ code: 'notifications.quiet_hours_window_unexpected' });
  });

  it('keeps each person to their own settings', async () => {
    expectOk(await h.updateSettings.execute({ principal: ali, timezone: 'Asia/Baghdad' }));
    expect(expectOk(await h.getSettings.execute({ principal: sara }))).toMatchObject({
      timezone: null,
    });
  });
});
