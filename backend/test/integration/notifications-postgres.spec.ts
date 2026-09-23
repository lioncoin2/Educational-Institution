import { sql } from 'drizzle-orm';

import { asId, type Principal } from '../../src/shared';
import type { NotificationRequest } from '../../src/modules/notifications/domain/notification';
import { DrizzleDeviceRepository } from '../../src/modules/notifications/infrastructure/drizzle-device-repository';
import { DrizzleNotificationRepository } from '../../src/modules/notifications/infrastructure/drizzle-notification-repository';
import { DrizzlePreferenceRepository } from '../../src/modules/notifications/infrastructure/drizzle-preference-repository';
import { expectOk } from '../support/identity-harness';
import {
  apnsToken,
  fcmToken,
  messageRequest,
  notificationsHarness,
  type NotificationsHarness,
} from '../support/notifications-harness';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

/**
 * Notifications on Postgres: the guarantees the database is trusted with —
 * one row per fact and recipient under concurrency, keyset pages over
 * thousands of rows on the index built for them, a capped count, chunked
 * "mark all", one owner per push token — each asserted against the real
 * engine, through the real adapters.
 */
describeWithPostgres('notifications on Postgres', () => {
  let scratch: ScratchDatabase;
  let h: NotificationsHarness;
  let ali: Principal;
  let sara: Principal;

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  beforeAll(async () => {
    scratch = await scratchDatabase();
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.db.execute(
      sql`truncate notifications, notification_preferences, notification_devices`,
    );
    h = await notificationsHarness({
      notifications: new DrizzleNotificationRepository(scratch.db),
      preferences: new DrizzlePreferenceRepository(scratch.db),
      devices: new DrizzleDeviceRepository(scratch.db),
    });
    ali = h.messaging.person('STUDENT', 'علي');
    sara = h.messaging.person('STUDENT', 'سارة');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  describe('the schema the migration built', () => {
    it('has every constraint and index the design relies on, by name', async () => {
      const constraints = await rows<{ conname: string }>(sql`
        select conname from pg_constraint
        where conrelid in ('notifications'::regclass, 'notification_preferences'::regclass,
                           'notification_devices'::regclass)`);
      expect(constraints.map((c) => c.conname)).toEqual(
        expect.arrayContaining([
          'notifications_dedupe_unique',
          'notifications_template_keys_shape',
          'notifications_params_is_object',
          'notifications_target_has_kind',
          'notifications_read_after_created',
          'notification_preferences_user_id_category_pk',
          'notification_devices_token_unique',
          'notification_devices_apns_is_ios',
        ]),
      );
      const indexes = await rows<{ indexname: string; indexdef: string }>(sql`
        select indexname, indexdef from pg_indexes
        where tablename in ('notifications', 'notification_devices')`);
      const unread = indexes.find((i) => i.indexname === 'notifications_recipient_unread_idx');
      expect(unread?.indexdef).toContain('WHERE (read_at IS NULL)');
      expect(indexes.map((i) => i.indexname)).toEqual(
        expect.arrayContaining([
          'notifications_recipient_created_idx',
          'notification_devices_user_enabled_idx',
        ]),
      );
    });

    it('holds no foreign key into another module’s tables', async () => {
      const foreign = await rows<{ conname: string }>(sql`
        select conname from pg_constraint
        where contype = 'f'
          and conrelid in ('notifications'::regclass, 'notification_preferences'::regclass,
                           'notification_devices'::regclass)`);
      expect(foreign).toEqual([]);
    });

    it('refuses what the domain would never write — even without the adapter', async () => {
      /** The name of the constraint a statement violates, or null if it succeeded. */
      const violated = async (statement: ReturnType<typeof sql>): Promise<string | null> => {
        try {
          await scratch.db.execute(statement);
          return null;
        } catch (error) {
          for (let e: unknown = error; e !== undefined && e !== null;) {
            const candidate = e as { constraint?: string; cause?: unknown };
            if (typeof candidate.constraint === 'string') return candidate.constraint;
            e = candidate.cause;
          }
          throw error;
        }
      };
      const columns = sql.raw(
        '(id, recipient_user_id, type, category, title_key, body_key, params, target, dedupe_key, created_at, read_at)',
      );
      expect(
        await violated(sql`insert into notifications ${columns} values ('r1', 'u', 'MESSAGE_RECEIVED',
          'MESSAGES', 'Hello {name}', 'notification.a.body', '{}', '{"kind":"conversation"}', 'k', now(), null)`),
      ).toBe('notifications_template_keys_shape');
      expect(
        await violated(sql`insert into notifications ${columns} values ('r2', 'u', 'MESSAGE_RECEIVED',
          'MESSAGES', 'notification.a.title', 'notification.a.body', '[1,2]', '{"kind":"conversation"}', 'k', now(), null)`),
      ).toBe('notifications_params_is_object');
      expect(
        await violated(sql`insert into notifications ${columns} values ('r3', 'u', 'MESSAGE_RECEIVED',
          'MESSAGES', 'notification.a.title', 'notification.a.body', '{}', '"https://evil.example"', 'k', now(), null)`),
      ).toBe('notifications_target_has_kind');
      expect(
        await violated(sql`insert into notifications ${columns} values ('r4', 'u', 'MESSAGE_RECEIVED',
          'MESSAGES', 'notification.a.title', 'notification.a.body', '{}', '{"kind":"conversation"}', 'k',
          now(), now() - interval '1 day')`),
      ).toBe('notifications_read_after_created');
      expect(
        await violated(sql`insert into notification_devices
          (id, user_id, platform, provider, token, created_at, last_seen_at)
          values ('d1', 'u', 'ANDROID', 'APNS', ${'a'.repeat(64)}, now(), now())`),
      ).toBe('notification_devices_apns_is_ios');
    });
  });

  describe('one notification per fact, decided by the database', () => {
    it('stores exactly one row when the same fact arrives twenty times at once', async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]),
        ),
      );
      expect(outcomes.reduce((sum, o) => sum + o.created.length, 0)).toBe(1);
      const [count] = await rows<{ n: number }>(
        sql`select count(*)::int as n from notifications where recipient_user_id = ${ali.userId}`,
      );
      expect(count?.n).toBe(1);
      expect(h.eventsNamed('notifications.notification.created')).toHaveLength(1);
    });

    it('translates one messaging fact delivered twice concurrently into one row per recipient', async () => {
      const teacher = h.messaging.person('TEACHER', 'الأستاذ');
      const group = await h.messaging.group(teacher, [ali, sara]);
      await h.settle();
      h.translator.onModuleDestroy();
      await h.messaging.text(teacher, group.id, 'تنبيه');
      const fact = h.messaging.events.published.filter(
        (e) => e.name === 'messaging.message.sent',
      )[0];
      if (fact === undefined) throw new Error('no message.sent');
      await Promise.all([
        h.translator.translate(fact),
        h.translator.translate(fact),
        h.translator.translate(fact),
      ]);
      const perRecipient = await rows<{ recipient_user_id: string; n: number }>(sql`
        select recipient_user_id, count(*)::int as n from notifications
        where type = 'MESSAGE_RECEIVED' group by recipient_user_id order by 1`);
      expect(perRecipient.map((r) => r.n)).toEqual([1, 1]);
    });
  });

  describe('the inbox at volume', () => {
    /** `count` notifications for `who`, stored in batches — as a busy term would leave them. */
    async function fill(who: Principal, count: number, prefix: string): Promise<void> {
      for (let start = 0; start < count; start += 1000) {
        const batch: NotificationRequest[] = [];
        for (let i = start; i < Math.min(count, start + 1000); i++) {
          batch.push(messageRequest(who.userId, `${prefix}-${i}`));
        }
        await h.dispatcher.dispatch(batch);
        h.clock.advance(1);
      }
    }

    it('walks thousands of rows with keyset cursors — each once, newest first, on the index', async () => {
      await fill(ali, 3500, 'a');
      await fill(sara, 1500, 's');
      await scratch.db.execute(sql`analyze notifications`);

      const seen: string[] = [];
      let cursor: string | undefined;
      let previous: { at: number; id: string } | null = null;
      do {
        const page = expectOk(await h.list.execute({ principal: ali, cursor, limit: 50 }));
        for (const item of page.items) {
          const at = item.createdAt.getTime();
          if (previous !== null) {
            expect(at < previous.at || (at === previous.at && item.id < previous.id)).toBe(true);
          }
          previous = { at, id: item.id };
          seen.push(item.id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toHaveLength(3500);
      expect(new Set(seen).size).toBe(3500);

      const plan = JSON.stringify(
        (
          await scratch.db.execute(sql`
            explain (format json)
            select * from notifications
            where recipient_user_id = ${ali.userId}
              and (created_at, id) < (now(), 'zzz')
            order by created_at desc, id desc
            limit 51`)
        ).rows,
      );
      expect(plan).toContain('notifications_recipient_created_idx');
      expect(plan).not.toContain('Seq Scan');
    }, 120_000);

    it('counts unread up to the cap, from the partial index of unread rows', async () => {
      await fill(ali, 1200, 'a');
      await scratch.db.execute(sql`analyze notifications`);
      expect(await h.unread(ali)).toEqual({ count: 99, capped: true });
      // On a table this small the planner may rightly read the first pages
      // instead; what matters is that the index for this query exists and
      // serves it — so ask for the plan with sequential scans priced out.
      const plan = await scratch.db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        return JSON.stringify(
          (
            await tx.execute(sql`
              explain (format json)
              select count(*) from (select 1 from notifications
                where recipient_user_id = ${ali.userId} and read_at is null limit 100) capped`)
          ).rows,
        );
      });
      expect(plan).toContain('notifications_recipient_unread_idx');
      expect(plan).toContain('"Plan Rows":100');
    }, 60_000);

    it('marks all read in chunks, up to the boundary, alongside a concurrent single read', async () => {
      await fill(ali, 2500, 'a');
      const [boundary] = await h.inbox(ali);
      await fill(ali, 3, 'late');
      const [late] = await h.inbox(ali);

      const [all] = await Promise.all([
        h.markAllRead.execute({ principal: ali, throughId: boundary?.id }),
        h.markRead.execute({ principal: ali, notificationId: late?.id ?? '' }),
      ]);
      expect(expectOk(all)).toEqual({ markedRead: 2500, complete: true });
      // The three that arrived after the boundary stay unread, but one was read by hand.
      expect(await h.unread(ali)).toEqual({ count: 2, capped: false });
      const [bad] = await rows<{ n: number }>(
        sql`select count(*)::int as n from notifications where read_at < created_at`,
      );
      expect(bad?.n).toBe(0);
    }, 60_000);
  });

  describe('preferences', () => {
    it('keep one row per person and category, and change it in place', async () => {
      expectOk(
        await h.updatePreferences.execute({ principal: ali, category: 'MESSAGES', push: false }),
      );
      expectOk(
        await h.updatePreferences.execute({
          principal: ali,
          category: 'MESSAGES',
          realtime: false,
        }),
      );
      expect(
        await rows(
          sql`select user_id, category, in_app, realtime, push from notification_preferences`,
        ),
      ).toEqual([
        { user_id: ali.userId, category: 'MESSAGES', in_app: true, realtime: false, push: false },
      ]);
      await h.dispatcher.dispatch([messageRequest(ali.userId, 'm-1')]);
      expect(h.eventsNamed('notifications.notification.created')[0]?.payload).toMatchObject({
        channels: { realtime: false, push: false },
      });
    });
  });

  describe('devices', () => {
    it('keeps several per person, moves a token to its latest owner, and disables a dead one', async () => {
      const phone = await h.device(ali, fcmToken(1));
      await h.device(ali, fcmToken(2), 'WEB');
      expectOk(
        await h.registerDevice.execute({
          principal: ali,
          platform: 'IOS',
          provider: 'APNS',
          token: apnsToken(7).toUpperCase(),
          meta: {},
        }),
      );
      expect((await h.devices.enabledForUsers([ali.userId])).map((d) => d.platform).sort()).toEqual(
        ['ANDROID', 'IOS', 'WEB'],
      );
      const [apns] = await rows<{ token: string }>(
        sql`select token from notification_devices where provider = 'APNS'`,
      );
      expect(apns?.token).toBe(apnsToken(7)); // normalized: one token, one row

      const moved = await h.device(sara, fcmToken(1));
      expect(moved).toBe(phone);
      const [owner] = await rows<{ user_id: string }>(
        sql`select user_id from notification_devices where id = ${phone}`,
      );
      expect(owner?.user_id).toBe(sara.userId);

      await h.devices.disable(asId<'NotificationDevice'>(phone), h.clock.now());
      expect((await h.devices.enabledForUsers([sara.userId])).map((d) => d.id)).toEqual([]);
      // Registered again by its owner, it is live again, under the same id.
      expect(await h.device(sara, fcmToken(1))).toBe(phone);
      expect((await h.devices.enabledForUsers([sara.userId])).map((d) => d.id)).toEqual([phone]);
    });

    it('registers one token concurrently from two accounts into exactly one row', async () => {
      await Promise.all([h.device(ali, fcmToken(9)), h.device(sara, fcmToken(9))]);
      const [count] = await rows<{ n: number }>(
        sql`select count(*)::int as n from notification_devices where token = ${fcmToken(9)}`,
      );
      expect(count?.n).toBe(1);
    });
  });
});
