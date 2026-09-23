import { expectOk } from '../../../../test/support/identity-harness';
import {
  messageRequest,
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';
import { NotificationEvents } from '../contracts/events';
import { NotificationLimits } from '../domain/notification-policy';
import type { NotificationRepository } from '../domain/ports';
import { MarkAllNotificationsReadUseCase } from './inbox.use-cases';

describe('the inbox', () => {
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

  /** `count` notifications for `who`, one second apart, oldest first. */
  async function receive(who: Principal, count: number, prefix = 'm'): Promise<void> {
    for (let i = 0; i < count; i++) {
      await h.dispatcher.dispatch([messageRequest(who.userId, `${prefix}-${i}`)]);
      h.clock.advance(1);
    }
  }

  describe('isolation', () => {
    it('lists, counts and marks only its owner’s notifications', async () => {
      await receive(ali, 2);
      await receive(sara, 1, 's');
      const [alisNewest] = await h.inbox(ali);
      const id = alisNewest?.id ?? '';

      expect(await h.inbox(sara)).toHaveLength(1);
      expect(await h.unread(sara)).toEqual({ count: 1, capped: false });
      // Another person's notification is, to Sara, one that does not exist.
      const read = await h.markRead.execute({ principal: sara, notificationId: id });
      expect(read.ok ? null : read.error.code).toBe('notifications.notification_not_found');
      const all = await h.markAllRead.execute({ principal: sara, throughId: id });
      expect(all.ok ? null : all.error.code).toBe('notifications.notification_not_found');
      expect(await h.unread(ali)).toEqual({ count: 2, capped: false });
    });
  });

  describe('unread count', () => {
    it('counts what is unread', async () => {
      expect(await h.unread(ali)).toEqual({ count: 0, capped: false });
      await receive(ali, 3);
      expect(await h.unread(ali)).toEqual({ count: 3, capped: false });
    });

    it('stops at 99 and says so — the badge shows "99+"', async () => {
      await receive(ali, 99);
      expect(await h.unread(ali)).toEqual({ count: 99, capped: false });
      await receive(ali, 1, 'extra');
      expect(await h.unread(ali)).toEqual({ count: 99, capped: true });
      await receive(ali, 50, 'more');
      expect(await h.unread(ali)).toEqual({ count: 99, capped: true });
    });

    it('never counts past the cap, however large the backlog', async () => {
      const count = jest.spyOn(h.notifications, 'countUnread');
      await h.unread(ali);
      expect(count).toHaveBeenCalledWith(ali.userId, NotificationLimits.unreadCountCap + 1);
    });
  });

  describe('marking one read', () => {
    it('stamps it read, lowers the count, and tells the owner’s other devices', async () => {
      await receive(ali, 2);
      const [newest] = await h.inbox(ali);
      h.clock.advance(60);
      const read = expectOk(
        await h.markRead.execute({ principal: ali, notificationId: newest?.id ?? '' }),
      );
      expect(read.readAt).toEqual(h.clock.now());
      expect(await h.unread(ali)).toEqual({ count: 1, capped: false });
      expect(h.eventsNamed(NotificationEvents.read).map((e) => e.payload)).toEqual([
        {
          recipientUserId: ali.userId,
          notificationId: newest?.id,
          readAt: h.clock.now().toISOString(),
        },
      ]);
    });

    it('is idempotent: again changes nothing and announces nothing', async () => {
      await receive(ali, 1);
      const [only] = await h.inbox(ali);
      const first = expectOk(
        await h.markRead.execute({ principal: ali, notificationId: only?.id ?? '' }),
      );
      h.clock.advance(300);
      const second = expectOk(
        await h.markRead.execute({ principal: ali, notificationId: only?.id ?? '' }),
      );
      expect(second.readAt).toEqual(first.readAt);
      expect(h.eventsNamed(NotificationEvents.read)).toHaveLength(1);
    });
  });

  describe('marking all read', () => {
    it('reads everything up to the one the person was looking at — nothing newer', async () => {
      await receive(ali, 5);
      const [seenNewest] = await h.inbox(ali);
      await receive(ali, 2, 'late'); // arrived while the person was reading
      const result = expectOk(
        await h.markAllRead.execute({ principal: ali, throughId: seenNewest?.id }),
      );
      expect(result).toEqual({ markedRead: 5, complete: true });
      expect(await h.unread(ali)).toEqual({ count: 2, capped: false });
      const [event] = h.eventsNamed(NotificationEvents.allRead);
      expect(event?.payload).toMatchObject({
        recipientUserId: ali.userId,
        throughId: seenNewest?.id,
        count: 5,
      });
    });

    it('without a boundary, reads everything created until now', async () => {
      await receive(ali, 4);
      expect(expectOk(await h.markAllRead.execute({ principal: ali }))).toEqual({
        markedRead: 4,
        complete: true,
      });
      expect(await h.unread(ali)).toEqual({ count: 0, capped: false });
      // Again: nothing left, nothing announced.
      expect(expectOk(await h.markAllRead.execute({ principal: ali }))).toEqual({
        markedRead: 0,
        complete: true,
      });
      expect(h.eventsNamed(NotificationEvents.allRead)).toHaveLength(1);
    });

    it('updates in bounded chunks, never one unbounded statement', async () => {
      for (let i = 0; i < 2500; i++) {
        await h.dispatcher.dispatch([messageRequest(ali.userId, `bulk-${i}`)]);
      }
      const chunks = jest.spyOn(h.notifications, 'markReadThrough');
      const result = expectOk(await h.markAllRead.execute({ principal: ali }));
      expect(result).toEqual({ markedRead: 2500, complete: true });
      expect(chunks.mock.calls.map((call) => call[3])).toEqual([1000, 1000, 1000]);
    });

    it('stops after its chunk limit and says the job is not complete', async () => {
      const endless = {
        find: async () => null,
        markReadThrough: async (_u: string, _t: unknown, _a: Date, limit: number) => limit,
      } as unknown as NotificationRepository;
      const useCase = new MarkAllNotificationsReadUseCase(endless, h.events, h.clock);
      expect(expectOk(await useCase.execute({ principal: ali }))).toEqual({
        markedRead: NotificationLimits.markAllChunk * NotificationLimits.markAllMaxChunks,
        complete: false,
      });
    });
  });

  describe('pages', () => {
    it('walks the whole inbox newest first, each notification exactly once', async () => {
      await receive(ali, 47);
      const seen: string[] = [];
      const times: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = expectOk(await h.list.execute({ principal: ali, cursor, limit: 10 }));
        seen.push(...page.items.map((n) => n.id));
        times.push(...page.items.map((n) => n.createdAt.getTime()));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(5);
      expect(new Set(seen).size).toBe(47);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('orders notifications of the same instant by id, the same way on every page', async () => {
      const batch = Array.from({ length: 12 }, (_, i) => messageRequest(ali.userId, `same-${i}`));
      await h.dispatcher.dispatch(batch); // one instant for all twelve
      const walked: string[] = [];
      let cursor: string | undefined;
      do {
        const page = expectOk(await h.list.execute({ principal: ali, cursor, limit: 5 }));
        walked.push(...page.items.map((n) => n.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(walked).toEqual([...walked].sort().reverse());
      const oneGo = expectOk(await h.list.execute({ principal: ali, limit: 50 }));
      expect(oneGo.items.map((n) => n.id)).toEqual(walked);
    });

    it('bounds a page, and refuses a cursor it did not make', async () => {
      await receive(ali, 3);
      const page = expectOk(await h.list.execute({ principal: ali, limit: 1000 }));
      expect(page.items.length).toBeLessThanOrEqual(NotificationLimits.maxPageSize);
      const forged = await h.list.execute({ principal: ali, cursor: 'not-a-cursor' });
      expect(forged.ok ? null : forged.error.code).toBe('notifications.cursor_invalid');
    });

    it('serves an empty inbox as an empty page', async () => {
      expect(expectOk(await h.list.execute({ principal: ali }))).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });
});
