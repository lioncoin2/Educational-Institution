import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';

describe('institution notification settings use cases', () => {
  let h: NotificationsHarness;
  let admin: Principal;

  beforeEach(async () => {
    h = await notificationsHarness();
    admin = h.messaging.person('TEACHER', 'المشرف');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('reports no policy until one is set', async () => {
    expect(expectOk(await h.getInstitutionSettings.execute())).toBeNull();
  });

  it('stores and reads back a window and its timezone', async () => {
    const saved = expectOk(
      await h.updateInstitutionSettings.execute({
        principal: admin,
        enabled: true,
        start: '21:00',
        end: '07:00',
        timezone: 'Asia/Baghdad',
      }),
    );
    expect(saved).toEqual({
      enabled: true,
      start: '21:00',
      end: '07:00',
      timezone: 'Asia/Baghdad',
    });
    expect(expectOk(await h.getInstitutionSettings.execute())).toEqual(saved);
  });

  it('keeps the window and timezone even when disabled', async () => {
    const saved = expectOk(
      await h.updateInstitutionSettings.execute({
        principal: admin,
        enabled: false,
        start: '22:00',
        end: '06:00',
        timezone: 'UTC',
      }),
    );
    expect(saved).toMatchObject({ enabled: false, start: '22:00', end: '06:00', timezone: 'UTC' });
  });

  it('rejects a window that is not two distinct HH:MM times', async () => {
    expect(
      expectErr(
        await h.updateInstitutionSettings.execute({
          principal: admin,
          enabled: true,
          start: '21:00',
          end: '21:00',
          timezone: 'UTC',
        }),
      ),
    ).toMatchObject({ kind: 'validation', code: 'notifications.quiet_hours_window_invalid' });
  });

  it('rejects a timezone that is not an IANA zone', async () => {
    expect(
      expectErr(
        await h.updateInstitutionSettings.execute({
          principal: admin,
          enabled: true,
          start: '21:00',
          end: '07:00',
          timezone: '+03:00',
        }),
      ),
    ).toMatchObject({ kind: 'validation', code: 'notifications.timezone_invalid' });
  });

  it('accepts an overnight window', async () => {
    const saved = expectOk(
      await h.updateInstitutionSettings.execute({
        principal: admin,
        enabled: true,
        start: '23:30',
        end: '05:30',
        timezone: 'Asia/Baghdad',
      }),
    );
    expect(saved).toMatchObject({ start: '23:30', end: '05:30' });
  });
});
