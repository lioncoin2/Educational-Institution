import { expectOk } from '../../../../test/support/identity-harness';
import {
  messageRequest,
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';
import { NotificationEvents, type NotificationCreated } from '../contracts/events';
import type { NotificationRequest } from '../domain/notification';

/** 'HH:MM' for a minute-of-day, wrapping across midnight. */
function hhmm(totalMinutes: number): string {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A community-membership notification — a target with no conversation to mute. */
function communityRequest(recipientUserId: string, communityId: string): NotificationRequest {
  return {
    recipientUserId,
    type: 'COMMUNITY_MEMBER_ADDED',
    titleKey: 'notification.community_member_added.title',
    bodyKey: 'notification.community_member_added.body',
    params: {},
    target: { kind: 'community', communityId },
    dedupeKey: `community:${communityId}:member_added:user:${recipientUserId}`,
  };
}

describe('push suppression (quiet hours and mutes)', () => {
  let h: NotificationsHarness;
  let ali: Principal;
  let sara: Principal;
  let nowUtcMinutes: number;

  beforeEach(async () => {
    h = await notificationsHarness();
    ali = h.messaging.person('STUDENT', 'علي');
    sara = h.messaging.person('STUDENT', 'سارة');
    const now = h.clock.now();
    nowUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  const created = () => h.eventsNamed(NotificationEvents.created) as NotificationCreated[];
  const channelsFor = (userId: string) =>
    created().find((event) => event.payload.recipientUserId === userId)?.payload.channels;

  // A window (in UTC) that definitely contains the clock's current instant, and
  // one that definitely does not — so these tests are deterministic whatever
  // the harness clock reads.
  const windowAroundNow = () => ({
    start: hhmm(nowUtcMinutes - 60),
    end: hhmm(nowUtcMinutes + 60),
  });
  const windowAwayFromNow = () => ({
    start: hhmm(nowUtcMinutes + 120),
    end: hhmm(nowUtcMinutes + 240),
  });

  describe('quiet hours', () => {
    it('holds push inside the window — the record is stored and realtime is untouched', async () => {
      const { start, end } = windowAroundNow();
      expectOk(
        await h.updateSettings.execute({
          principal: ali,
          timezone: 'UTC',
          quietHoursMode: 'CUSTOM',
          quietHoursStart: start,
          quietHoursEnd: end,
        }),
      );
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);

      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: false });
      expect(await h.inbox(ali)).toHaveLength(1); // stored regardless
    });

    it('allows push outside the window', async () => {
      const { start, end } = windowAwayFromNow();
      expectOk(
        await h.updateSettings.execute({
          principal: ali,
          timezone: 'UTC',
          quietHoursMode: 'CUSTOM',
          quietHoursStart: start,
          quietHoursEnd: end,
        }),
      );
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: true });
    });

    it('applies the institution window to a user who inherits, falling back to the institution timezone', async () => {
      const { start, end } = windowAroundNow();
      expectOk(
        await h.updateInstitutionSettings.execute({
          principal: sara, // any principal; the use case trusts the route guard
          enabled: true,
          start,
          end,
          timezone: 'UTC',
        }),
      );
      // ali has set nothing: default INHERIT, no timezone → uses the institution's.
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: false });
      expect(await h.inbox(ali)).toHaveLength(1);
    });

    it('lets a user override the institution window off (full override)', async () => {
      const { start, end } = windowAroundNow();
      expectOk(
        await h.updateInstitutionSettings.execute({
          principal: sara,
          enabled: true,
          start,
          end,
          timezone: 'UTC',
        }),
      );
      expectOk(await h.updateSettings.execute({ principal: ali, quietHoursMode: 'DISABLED' }));
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: true });
    });

    it('does not suppress push for a category the user already turned push off for — it stays off, not doubled', async () => {
      const { start, end } = windowAroundNow();
      expectOk(
        await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', push: false }),
      );
      expectOk(
        await h.updateSettings.execute({
          principal: ali,
          timezone: 'UTC',
          quietHoursMode: 'CUSTOM',
          quietHoursStart: start,
          quietHoursEnd: end,
        }),
      );
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: false });
      expect(await h.inbox(ali)).toHaveLength(1);
    });
  });

  describe('conversation mute', () => {
    it('holds push for the muted conversation — the record is stored and realtime is untouched', async () => {
      expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1', 'c-1')]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: false });
      expect(await h.inbox(ali)).toHaveLength(1);
    });

    it('is scoped to the one conversation', async () => {
      expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-2', 'c-2')]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: true });
    });

    it('restores push when unmuted', async () => {
      expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
      expectOk(await h.unmute.execute({ principal: ali, conversationId: 'c-1' }));
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1', 'c-1')]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: true });
    });

    it('is scoped to the one person', async () => {
      expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
      await h.dispatcher.dispatch([
        messageRequest(ali.userId, 'm-1', 'c-1'),
        messageRequest(sara.userId, 'm-1', 'c-1'),
      ]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: false });
      expect(channelsFor(sara.userId)).toEqual({ realtime: true, push: true });
    });

    it('never changes a notification that carries no conversation id', async () => {
      // ali mutes a conversation whose id collides with a community id; the
      // community-membership notification is not a conversation, so push stays.
      expectOk(await h.mute.execute({ principal: ali, conversationId: 'g-1' }));
      await h.dispatcher.dispatch([communityRequest(ali.userId, 'g-1')]);
      expect(channelsFor(ali.userId)).toEqual({ realtime: true, push: true });
      expect(await h.inbox(ali)).toHaveLength(1);
    });
  });
});
