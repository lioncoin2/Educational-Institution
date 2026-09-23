import { expectOk } from '../../../../test/support/identity-harness';
import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';

describe('notification preferences', () => {
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

  it('start with every channel on, for the categories that have notifications — and only those', async () => {
    expect(expectOk(await h.getPreferences.execute({ principal: ali }))).toEqual([
      { category: 'MESSAGES', inApp: true, realtime: true, push: true },
    ]);
  });

  it('change the channels named, keep the rest, and stay changed', async () => {
    expect(
      expectOk(
        await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', push: false }),
      ),
    ).toEqual([{ category: 'MESSAGES', inApp: true, realtime: true, push: false }]);
    expectOk(
      await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', realtime: false }),
    );
    expect(expectOk(await h.getPreferences.execute({ principal: ali }))).toEqual([
      { category: 'MESSAGES', inApp: true, realtime: false, push: false },
    ]);
  });

  it('keep the delivery choices while the center is off, so turning it back on restores them', async () => {
    expectOk(
      await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', push: false }),
    );
    expectOk(
      await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', inApp: false }),
    );
    expect(
      expectOk(
        await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', inApp: true }),
      ),
    ).toEqual([{ category: 'MESSAGES', inApp: true, realtime: true, push: false }]);
  });

  it('are one person’s own: changing mine leaves everyone else’s alone', async () => {
    expectOk(
      await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', inApp: false }),
    );
    expect(expectOk(await h.getPreferences.execute({ principal: sara }))).toEqual([
      { category: 'MESSAGES', inApp: true, realtime: true, push: true },
    ]);
  });

  it('refuse a category with no notifications yet, and a change that changes nothing', async () => {
    const reserved = await h.updatePreferences.execute({
      principal: ali,
      category: 'ASSIGNMENTS',
      push: false,
    });
    expect(reserved.ok ? null : reserved.error.code).toBe('notifications.category_unknown');
    const empty = await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES' });
    expect(empty.ok ? null : empty.error.code).toBe('notifications.preferences_empty');
  });

  it('are not audited — they grant nothing to anyone', async () => {
    expectOk(
      await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', push: false }),
    );
    expect(h.audit.entries).toEqual([]);
  });
});
