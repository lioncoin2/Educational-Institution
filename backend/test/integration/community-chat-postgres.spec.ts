import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { Principal } from '../../src/shared';
import { DrizzleCommunityReadModel } from '../../src/modules/communities/infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from '../../src/modules/communities/infrastructure/drizzle-community-repository';
import { Roles } from '../../src/modules/identity/domain/role';
import type { CommunityMemberState } from '../../src/modules/messaging/domain/community-chat';
import type { ConversationId } from '../../src/modules/messaging/domain/conversation';
import { textDraft } from '../../src/modules/messaging/domain/message';
import { DrizzleMessagingReadModel } from '../../src/modules/messaging/infrastructure/drizzle-messaging-read-model';
import { DrizzleMessagingRepository } from '../../src/modules/messaging/infrastructure/drizzle-messaging-repository';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { communitiesHarness, type CommunitiesHarness } from '../support/communities-harness';
import { communityChatStoreContract } from '../support/community-chat-contract-suite';
import { expectErr, expectOk } from '../support/identity-harness';
import { META, messagingHarness, type MessagingHarness } from '../support/messaging-harness';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

const ids = new UuidIdGenerator();
const AT = new Date('2026-09-23T10:00:00.000Z');

/** Postgres error code and constraint, whether the driver error arrives bare or wrapped. */
async function pgError(work: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    return cause as { code?: string; constraint?: string };
  }
  throw new Error('expected the database to refuse this');
}

describeWithPostgres('community chats on Postgres', () => {
  let scratch: ScratchDatabase;
  let repository: DrizzleMessagingRepository;
  let readModel: DrizzleMessagingReadModel;

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  beforeAll(async () => {
    scratch = await scratchDatabase();
    repository = new DrizzleMessagingRepository(scratch.db);
    readModel = new DrizzleMessagingReadModel(scratch.db);
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  communityChatStoreContract('Drizzle', () => ({ repository, readModel }));

  describe('the schema migration 0012 built', () => {
    it('has every constraint and index the design names', async () => {
      const constraints = await rows<{ name: string }>(sql`
        select conname as name from pg_constraint
         where conrelid in ('conversations'::regclass, 'conversation_participants'::regclass)
         order by 1`);
      expect(constraints.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'conversations_community_chat_shape',
          'conversations_title_shape',
          'conversation_participants_source_shape',
        ]),
      );
      const indexes = await rows<{ name: string; definition: string }>(sql`
        select indexname as name, indexdef as definition from pg_indexes
         where indexname in ('conversations_community_unique', 'conversation_participants_current_idx')
         order by 1`);
      expect(indexes).toEqual([
        {
          name: 'conversation_participants_current_idx',
          definition: expect.stringMatching(
            /\(conversation_id, user_id\) WHERE \(left_at IS NULL\)$/u,
          ) as string,
        },
        {
          name: 'conversations_community_unique',
          definition: expect.stringMatching(
            /UNIQUE INDEX .*\(community_id\) WHERE \(community_id IS NOT NULL\)$/u,
          ) as string,
        },
      ]);
    });

    it('refuses what the invariants rule out, whatever the code does', async () => {
      const insert = (values: ReturnType<typeof sql>) =>
        scratch.db.execute(sql`
          insert into conversations (id, type, title, created_by, created_at, direct_user_low,
                                     direct_user_high, community_id, projected_membership_version)
          values ${values}`);
      // C1: linked exactly when projected.
      expect(
        await pgError(
          insert(sql`(${ids.next()}, 'CHANNEL', null, 'x', now(), null, null, 'c-a', null)`),
        ),
      ).toMatchObject({ code: '23514', constraint: 'conversations_community_chat_shape' });
      // C2: never a DM.
      expect(
        await pgError(insert(sql`(${ids.next()}, 'DIRECT', null, 'x', now(), 'a', 'b', 'c-b', 0)`)),
      ).toMatchObject({ code: '23514', constraint: 'conversations_community_chat_shape' });
      // C4: untitled.
      expect(
        await pgError(
          insert(sql`(${ids.next()}, 'CHANNEL', 'Named', 'x', now(), null, null, 'c-c', 0)`),
        ),
      ).toMatchObject({ code: '23514', constraint: 'conversations_title_shape' });
      // …while a channel messaging owns still needs its title.
      expect(
        await pgError(
          insert(sql`(${ids.next()}, 'CHANNEL', null, 'x', now(), null, null, null, null)`),
        ),
      ).toMatchObject({ code: '23514', constraint: 'conversations_title_shape' });
      // C3: one chat per community.
      await insert(sql`(${ids.next()}, 'CHANNEL', null, 'x', now(), null, null, 'c-d', 0)`);
      expect(
        await pgError(
          insert(sql`(${ids.next()}, 'CHANNEL', null, 'x', now(), null, null, 'c-d', 0)`),
        ),
      ).toMatchObject({ code: '23505', constraint: 'conversations_community_unique' });

      // C7: a projected row carries all its provenance, is a MEMBER, and was added by nobody.
      const chat = await repository.materializeCommunityChat({
        id: ids.next<'Conversation'>(),
        communityId: `c-${ids.next()}`,
        at: AT,
      });
      const participant = (values: ReturnType<typeof sql>) =>
        scratch.db.execute(sql`
          insert into conversation_participants (conversation_id, user_id, role, joined_at,
                                                 added_by, source_version, source_membership_id,
                                                 source_joined_at)
          values ${values}`);
      for (const bad of [
        sql`(${chat.id}, 'u-1', 'OWNER', now(), null, 1, 'm', now())`,
        sql`(${chat.id}, 'u-2', 'MEMBER', now(), 'someone', 1, 'm', now())`,
        sql`(${chat.id}, 'u-3', 'MEMBER', now(), null, 0, 'm', now())`,
        sql`(${chat.id}, 'u-4', 'MEMBER', now(), null, 1, null, now())`,
      ]) {
        expect(await pgError(participant(bad))).toMatchObject({
          code: '23514',
          constraint: 'conversation_participants_source_shape',
        });
      }
    });
  });

  describe('materialization', () => {
    it('gives twenty simultaneous materializations of one community exactly one conversation', async () => {
      const communityId = `c-${ids.next()}`;
      const made = await Promise.all(
        Array.from({ length: 20 }, () =>
          repository.materializeCommunityChat({
            id: ids.next<'Conversation'>(),
            communityId,
            at: AT,
          }),
        ),
      );
      expect(new Set(made.map((chat) => chat.id)).size).toBe(1);
      const [count] = await rows<{ count: number }>(
        sql`select count(*)::int as count from conversations where community_id = ${communityId}`,
      );
      expect(count?.count).toBe(1);
    });
  });

  describe('the apply, under concurrency', () => {
    const state = (
      userId: string,
      version: number,
      active: boolean,
      stint = 1,
    ): CommunityMemberState => ({
      userId,
      membershipId: `${userId}-s${stint}`,
      active,
      joinedAt: AT,
      version,
    });

    const chat = () =>
      repository.materializeCommunityChat({
        id: ids.next<'Conversation'>(),
        communityId: `c-${ids.next()}`,
        at: AT,
      });

    const counts = async (conversationId: string) =>
      (
        await rows<{ member_count: number; current: number; projected: number }>(sql`
          select c.member_count, c.projected_membership_version::int as projected,
                 (select count(*)::int from conversation_participants p
                   where p.conversation_id = c.id and p.left_at is null) as current
            from conversations c where c.id = ${conversationId}`)
      )[0];

    it('leaves the projected version at 50 when an apply for 10→20 arrives after it (regression)', async () => {
      const conversation = await chat();
      await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [state('u-50', 50, true)],
        advance: { from: 0, to: 50 },
        at: AT,
      });
      const late = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [state('u-15', 15, true)],
        advance: { from: 10, to: 20 },
        at: AT,
      });
      expect(late).toMatchObject({ kind: 'applied', projectedVersion: 50, joined: 1 });
      expect(await counts(conversation.id)).toEqual({ member_count: 2, current: 2, projected: 50 });
    });

    it('never lowers the version across 1,000 concurrent applies, and keeps member_count exact', async () => {
      const conversation = await chat();
      const users = Array.from({ length: 40 }, (_, i) => `u-${i.toString().padStart(2, '0')}`);
      let seed = 7;
      const next = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      let highest = 0;
      let observedDrop = false;
      let polling = true;
      const poller = (async () => {
        let last = 0;
        while (polling) {
          const [row] = await rows<{ projected: number }>(sql`
            select projected_membership_version::int as projected from conversations
             where id = ${conversation.id}`);
          if ((row?.projected ?? 0) < last) observedDrop = true;
          last = Math.max(last, row?.projected ?? 0);
        }
      })();

      for (let round = 0; round < 100; round++) {
        await Promise.all(
          Array.from({ length: 10 }, () => {
            const from = Math.floor(next() * (highest + 30));
            const picked = users.filter(() => next() < 0.3);
            return repository.applyCommunityMembership({
              conversationId: conversation.id,
              states: picked.map((userId) =>
                state(userId, 1 + Math.floor(next() * 1000), next() < 0.6),
              ),
              advance: { from, to: from + Math.floor(next() * 40) },
              at: AT,
            });
          }),
        );
        const now = await counts(conversation.id);
        expect(now?.projected ?? 0).toBeGreaterThanOrEqual(highest);
        highest = now?.projected ?? 0;
        expect(now?.member_count).toBe(now?.current);
      }
      polling = false;
      await poller;
      expect(observedDrop).toBe(false);
      expect(highest).toBeGreaterThan(0);
    }, 120_000);

    it('gives two appliers of the same range exactly the state one applier gives', async () => {
      const states = Array.from({ length: 200 }, (_, i) =>
        state(`p-${i.toString().padStart(3, '0')}`, i + 1, i % 3 !== 0),
      );
      const twice = await chat();
      const once = await chat();
      const results = await Promise.all([
        repository.applyCommunityMembership({
          conversationId: twice.id,
          states,
          advance: { from: 0, to: 200 },
          at: AT,
        }),
        repository.applyCommunityMembership({
          conversationId: twice.id,
          states,
          advance: { from: 0, to: 200 },
          at: AT,
        }),
      ]);
      await repository.applyCommunityMembership({
        conversationId: once.id,
        states,
        advance: { from: 0, to: 200 },
        at: AT,
      });
      // The second applier found every row at its version and changed nothing.
      expect(
        results.map((result) => (result.kind === 'applied' ? result.joined : -1)).sort(),
      ).toEqual([0, 133]);
      const dump = async (conversationId: string) =>
        rows(sql`
          select user_id, role, left_at is null as current, added_by, last_read_sequence,
                 hidden_through_sequence, source_version, source_membership_id
            from conversation_participants where conversation_id = ${conversationId}
           order by user_id`);
      expect(await dump(twice.id)).toEqual(await dump(once.id));
      expect(await counts(twice.id)).toEqual(await counts(once.id));
    });
  });

  describe('through the use cases, over both modules’ Postgres adapters', () => {
    let h: MessagingHarness;
    let communities: CommunitiesHarness;
    let admin: Principal;

    const truncate = () =>
      scratch.db.execute(sql`
        truncate table message_attachments, messages, conversation_participants, conversations,
                       communities_capability_grants, community_invitations, community_members,
                       communities
        restart identity cascade`);

    async function harness(): Promise<MessagingHarness> {
      return messagingHarness({ repository, readModel, communities });
    }

    async function projected(conversationId: string): Promise<string[]> {
      return (
        await rows<{ user_id: string }>(sql`
          select user_id from conversation_participants
           where conversation_id = ${conversationId} and left_at is null order by user_id`)
      ).map((row) => row.user_id);
    }

    async function authority(communityId: string): Promise<string[]> {
      return (
        await rows<{ user_id: string }>(sql`
          select user_id from community_members
           where community_id = ${communityId} and status = 'ACTIVE' order by user_id`)
      ).map((row) => row.user_id);
    }

    async function headVersion(communityId: string): Promise<number> {
      const [head] = await communities.membership.heads([communityId]);
      return head?.membershipVersion ?? -1;
    }

    beforeEach(async () => {
      await truncate();
      communities = communitiesHarness({
        store: new DrizzleCommunityRepository(scratch.db),
        readModel: new DrizzleCommunityReadModel(scratch.db),
      });
      h = await harness();
      admin = h.person(Roles.admin, 'المشرفة');
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await h.cleanup();
    });

    describe('a removal racing a send (S2)', () => {
      let member: Principal;
      let communityId: string;
      let chatId: string;
      let keys = 0;

      const send = () =>
        h.sendText.execute({
          principal: member,
          conversationId: chatId,
          clientMessageId: `race-key-${(keys += 1).toString().padStart(6, '0')}`,
          body: 'في الطريق',
          meta: META,
        });

      const remove = async () =>
        expectOk(
          await communities.remove.execute({
            principal: admin,
            communityId,
            userId: member.userId,
            meta: META,
          }),
        );

      /** Stops the next send between its permits and its append, until opened. */
      function pauseNextAppend(): { readonly reached: Promise<void>; open(): void } {
        let open = () => {};
        let reach = () => {};
        const gate = new Promise<void>((resolve) => (open = resolve));
        const reached = new Promise<void>((resolve) => (reach = resolve));
        const original = repository.appendMessage.bind(repository);
        jest.spyOn(repository, 'appendMessage').mockImplementationOnce(async (draft) => {
          reach();
          await gate;
          return original(draft);
        });
        return { reached, open };
      }

      const storedFrom = async (userId: string) =>
        (
          await rows<{ sequence: number }>(sql`
            select sequence::int from messages
             where conversation_id = ${chatId} and sender_id = ${userId} order by sequence`)
        ).map((row) => row.sequence);

      beforeEach(async () => {
        member = h.person(Roles.teacher, 'المعلمة');
        communityId = await h.community(admin, [member]);
        await h.communities.delegate(admin, communityId, member.userId, 'community.chat.post');
        await h.deliverCommunityEvents();
        chatId = (await h.openCommunityChat(admin, communityId)).id;
      });

      it('A: permits read first, append first — the message lands, ordered before the projected removal', async () => {
        const paused = pauseNextAppend();
        const sending = send();
        await paused.reached; // both permits are held; the append has not run
        await remove(); // Communities commits the removal now
        paused.open();
        const sent = expectOk(await sending);
        await h.deliverCommunityEvents(); // the projected removal comes after, under the same lock

        expect(await storedFrom(member.userId)).toEqual([sent.message.sequence]);
        const [row] = await rows<{ current: boolean }>(sql`
          select left_at is null as current from conversation_participants
           where conversation_id = ${chatId} and user_id = ${member.userId}`);
        expect(row?.current).toBe(false);
        expect(expectErr(await send()).code).toBe('messaging.conversation_not_found');
      });

      it('B: permits read first, the removal applied first — the lock refuses the append', async () => {
        const paused = pauseNextAppend();
        const sending = send();
        await paused.reached;
        await remove();
        await h.deliverCommunityEvents(); // the apply takes the conversation lock first
        paused.open();
        expect(expectErr(await sending).code).toBe('messaging.conversation_not_found');
        expect(await storedFrom(member.userId)).toEqual([]);
      });

      it('C: the removal committed first — refused at the permit, before the projection hears of it', async () => {
        await remove();
        expect(expectErr(await send()).code).toBe('messaging.conversation_not_found');
        expect(await storedFrom(member.userId)).toEqual([]);
        // The projection still said "member": the permit alone decided.
        await h.sync.idle();
        expect(await projected(chatId)).not.toContain(member.userId);
      });

      it('stays safe under 50 rounds of real concurrency: no permit read after the commit is ever granted', async () => {
        const original = communities.authorization.authorize.bind(communities.authorization);
        let tick = 0;
        let permits: { started: number; granted: boolean }[] = [];
        jest
          .spyOn(communities.authorization, 'authorize')
          .mockImplementation(async (principal, community, act) => {
            const started = (tick += 1);
            const answer = await original(principal, community, act);
            if (principal.userId === member.userId) permits.push({ started, granted: answer.ok });
            return answer;
          });
        let seed = 11;
        const delay = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return Math.floor((seed / 2 ** 32) * 24);
        };

        for (let round = 0; round < 50; round++) {
          if (round > 0) {
            communities.clock.advance(600);
            h.clock.advance(60);
            await communities.addPeople(admin, communityId, member.userId);
            await h.communities.delegate(admin, communityId, member.userId, 'community.chat.post');
            await h.deliverCommunityEvents();
          }
          permits = [];
          let committed = Number.POSITIVE_INFINITY;
          const [sent] = await Promise.all([
            new Promise<void>((resolve) => setTimeout(resolve, delay())).then(send),
            (async () => {
              await remove();
              committed = tick += 1;
              await h.deliverCommunityEvents();
            })(),
          ]);
          // A permit asked for after the removal committed is never granted…
          expect(permits.filter((p) => p.started > committed && p.granted)).toEqual([]);
          // …so an accepted send rests only on permits read before it.
          if (sent.ok) {
            expect(permits.every((p) => p.started < committed)).toBe(true);
          } else {
            expect(['messaging.conversation_not_found', 'messaging.posting_not_allowed']).toContain(
              expectErr(sent).code,
            );
          }
          // Once applied, the lock refuses them whatever they hold.
          const draft = textDraft({
            id: ids.next<'Message'>(),
            conversationId: chatId as ConversationId,
            senderId: member.userId,
            clientMessageId: `direct-${round.toString().padStart(4, '0')}`,
            replyToMessageId: null,
            body: 'straight to the store',
            at: h.clock.now(),
          });
          if (!draft.ok) throw new Error(draft.error.code);
          expect(await repository.appendMessage(draft.value)).toEqual({ kind: 'not_participant' });
        }
      }, 180_000);
    });

    it('converges whatever happens to the wake-ups: reordered, duplicated or dropped', async () => {
      const people = Array.from({ length: 12 }, () => h.person(Roles.student));
      const communityId = await h.community(admin);
      for (let i = 0; i < people.length; i += 4) {
        await communities.addPeople(
          admin,
          communityId,
          ...people.slice(i, i + 4).map((person) => person.userId),
        );
      }
      expectOk(
        await communities.remove.execute({
          principal: admin,
          communityId,
          userId: people[0].userId,
          meta: META,
        }),
      );
      expectOk(
        await communities.leave.execute({
          principal: people[1],
          communityId,
          meta: META,
        }),
      );
      const events = communities.journal.events.slice().reverse();
      const delivered = events.filter((_, i) => i % 3 !== 0);
      await h.bus.publish([...delivered, ...delivered]);
      await h.sync.idle();

      const chat = await readModel.communityChat(communityId);
      expect(chat?.projectedVersion).toBe(await headVersion(communityId));
      expect(await projected(chat?.conversationId ?? '')).toEqual(await authority(communityId));
      const [row] = await rows<{ member_count: number }>(
        sql`select member_count from conversations where id = ${chat?.conversationId ?? ''}`,
      );
      expect(row?.member_count).toBe((await authority(communityId)).length);
    });

    it('coalesces 100 wake-ups arriving during one pass into at most two passes', async () => {
      const communityId = await h.community(admin, [h.person(Roles.student)]);
      const wakeUp = communities.journal.events.find(
        (event) => event.name === 'communities.member.added',
      );
      if (wakeUp === undefined) throw new Error('expected a member.added event');
      const before = h.sync.passes;
      await Promise.all(Array.from({ length: 100 }, () => h.bus.publish([wakeUp])));
      await h.sync.idle();
      expect(h.sync.passes - before).toBeLessThanOrEqual(2);
      expect((await readModel.communityChat(communityId))?.projectedVersion).toBe(
        await headVersion(communityId),
      );
    });

    it('lets a restarted process’s sweeper materialize and converge what the old one never heard', async () => {
      const members = [h.person(Roles.student), h.person(Roles.teacher)];
      const communityId = await h.community(admin, members);
      // The process dies before any wake-up is handled: no chat, nothing projected.
      await h.cleanup();
      expect(await readModel.communityChat(communityId)).toBeNull();

      h = await harness();
      const report = await h.sweeper.tick();
      expect(report?.behind).toBeGreaterThanOrEqual(1);
      await h.sync.idle();
      const chat = await readModel.communityChat(communityId);
      expect(chat?.projectedVersion).toBe(await headVersion(communityId));
      expect(await projected(chat?.conversationId ?? '')).toEqual(await authority(communityId));
    });

    it('narrows recipients to Communities’ ACTIVE members while the projection lags', async () => {
      const [stays, goes] = [h.person(Roles.student), h.person(Roles.student)];
      const communityId = await h.community(admin, [stays, goes]);
      await h.deliverCommunityEvents();
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      expectOk(
        await communities.remove.execute({
          principal: admin,
          communityId,
          userId: goes.userId,
          meta: META,
        }),
      );
      expect(await projected(chatId)).toContain(goes.userId);
      for (const readersOnly of [undefined, true]) {
        const page = await h.recipients.list(chatId, { limit: 1000, readersOnly });
        expect([...page.userIds].sort()).toEqual([admin.userId, stays.userId].sort());
      }
      await h.sync.idle();
      expect(await projected(chatId)).not.toContain(goes.userId);
    });

    it('rebuilds a projection left ahead by an authority restore — tombstones, no audit, a warning', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const [kept, lost, later] = [
        h.person(Roles.student),
        h.person(Roles.student),
        h.person(Roles.student),
      ];
      const communityId = await h.community(admin, [kept]);
      await h.deliverCommunityEvents();
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      const restoredTo = await headVersion(communityId);
      await communities.addPeople(admin, communityId, lost.userId);
      await h.deliverCommunityEvents();
      expect(await projected(chatId)).toContain(lost.userId);

      // Communities is restored from a backup taken before `lost` joined.
      await scratch.db.execute(sql`
        delete from community_members where community_id = ${communityId} and user_id = ${lost.userId}`);
      await scratch.db.execute(sql`
        update communities set membership_version = ${restoredTo}, member_count = member_count - 1
         where id = ${communityId}`);
      // Meanwhile access is already right: the authority is asked every time.
      expect(
        expectErr(await h.getConversation.execute({ principal: lost, conversationId: chatId }))
          .code,
      ).toBe('messaging.conversation_not_found');
      expect((await h.recipients.list(chatId, { limit: 1000 })).userIds).not.toContain(lost.userId);

      const report = await h.sweeper.tick();
      expect(report).toMatchObject({ ahead: 1 });
      await h.sync.idle();
      expect((await readModel.communityChat(communityId))?.projectedVersion).toBe(restoredTo);
      expect(await projected(chatId)).toEqual(await authority(communityId));
      const [tombstone] = await rows<{ source_version: number; current: boolean }>(sql`
        select source_version::int, left_at is null as current from conversation_participants
         where conversation_id = ${chatId} and user_id = ${lost.userId}`);
      expect(tombstone).toEqual({ source_version: restoredTo, current: false });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ communityId, head: restoredTo }),
        'community chat projection rebuilt from Communities',
      );
      expect(h.audit.entries).toEqual([]);

      // The versions Communities hands out next — reused numbers — apply again.
      await communities.addPeople(admin, communityId, later.userId, lost.userId);
      await h.deliverCommunityEvents();
      expect(await projected(chatId)).toEqual(await authority(communityId));
      expect(await projected(chatId)).toEqual(expect.arrayContaining([later.userId, lost.userId]));
    });

    it('repairs rows that diverge at equal versions when asked to', async () => {
      const member = h.person(Roles.student);
      const communityId = await h.community(admin, [member]);
      await h.deliverCommunityEvents();
      const chatId = (await h.openCommunityChat(admin, communityId)).id;
      await scratch.db.execute(sql`
        update conversation_participants set left_at = joined_at
         where conversation_id = ${chatId} and user_id = ${member.userId}`);
      await scratch.db.execute(sql`
        update conversations set member_count = member_count - 1 where id = ${chatId}`);
      expect(await projected(chatId)).not.toContain(member.userId);

      const report = await h.reconciler.reconcile(communityId);
      expect(report).toMatchObject({ rewritten: 1, head: await headVersion(communityId) });
      expect(await projected(chatId)).toEqual(await authority(communityId));
    });
  });
});
