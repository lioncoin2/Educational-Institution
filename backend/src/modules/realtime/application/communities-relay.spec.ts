import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { META, type CommunitiesHarness } from '../../../../test/support/communities-harness';
import { expectOk } from '../../../../test/support/identity-harness';
import { messagingHarness } from '../../../../test/support/messaging-harness';
import {
  communitiesRealtimeHarness,
  type CommunitiesRealtimeHarness,
  type FakeLink,
  type Frame,
} from '../../../../test/support/realtime-harness';
import { domainEvent, type DomainEvent, type Principal } from '../../../shared';
import { CommunityEvents } from '../../communities/contracts/events';
import type { ConversationId } from '../../messaging/domain/conversation';

/** The community frames a device received, in order. */
const community = (link: FakeLink): Frame[] =>
  link.frames.filter((frame) => frame.type.startsWith('community.'));
const types = (link: FakeLink) => community(link).map((frame) => frame.type);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An access frame's id: the recipient, and a digest of the fact that changed their access. */
const accessId = (communityId: string, userId: string, fact: string) =>
  `community.access.changed:${communityId}:${userId}:${createHash('sha256').update(fact).digest('hex').slice(0, 20)}`;

/**
 * Communities' facts over the realtime pipeline (communities-live-attendance.md
 * §16; the P5 brief's A–K): the REAL Communities use cases change the store
 * and publish through the journal, an in-process bus hands the events to the
 * relay, and the relay asks Communities' membership contract and identity's
 * directory at delivery time. Only the sockets are fake.
 */
describe('Communities events, delivered in real time', () => {
  let h: CommunitiesRealtimeHarness;
  let c: CommunitiesHarness;
  let owner: Principal;
  let teacher: Principal;
  let student: Principal;
  let other: Principal;
  let outsider: Principal;
  let overseer: Principal;
  let communityId: string;
  let at: string;

  beforeEach(async () => {
    h = communitiesRealtimeHarness();
    c = h.communities;
    owner = c.person('owner-1', ['ADMIN']);
    teacher = c.person('teacher-1', ['TEACHER']);
    student = c.person('student-1', ['STUDENT']);
    other = c.person('student-2', ['STUDENT']);
    outsider = c.person('outsider-1', ['STUDENT']);
    // communities.manage: may view any community over HTTP, and holds no stint.
    overseer = c.person('overseer-1', ['ADMIN']);
    communityId = await c.community(owner);
    at = c.clock.now().toISOString();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    h.cleanup();
  });

  const join = (...people: Principal[]) =>
    c.addPeople(owner, communityId, ...people.map((person) => person.userId));

  const move = async (to: 'LOCKED' | 'OPEN', by: Principal = owner) => {
    expectOk(await c.status.execute({ principal: by, communityId, to, meta: META }));
  };

  const remove = async (person: Principal) => {
    expectOk(
      await c.remove.execute({ principal: owner, communityId, userId: person.userId, meta: META }),
    );
  };

  /** The events Communities published so far with this name, oldest first. */
  const published = (name: string): DomainEvent[] =>
    c.journal.events.filter((event) => event.name === name);

  const last = (name: string): DomainEvent => {
    const events = published(name);
    const event = events[events.length - 1];
    if (event === undefined) throw new Error(`nothing published as ${name}`);
    return event;
  };

  describe('A — an active member', () => {
    it('is told of their own addition, then of a lock and an unlock, and of their own access', async () => {
      const t = h.connect(teacher.userId);
      await join(teacher);
      await h.settle();
      await move('LOCKED');
      await h.settle();
      await move('OPEN');
      await h.settle();
      c.clock.advance(1);
      const [grantId] = await c.delegate(
        owner,
        communityId,
        teacher.userId,
        'community.members.view',
      );
      await h.settle();

      expect(community(t)).toEqual([
        {
          type: 'community.member.added',
          eventId: `community.member.added:${communityId}:${teacher.userId}:2`,
          occurredAt: at,
          communityId,
          userId: teacher.userId,
          version: 1,
        },
        {
          type: 'community.locked',
          eventId: `community.locked:${communityId}:2`,
          occurredAt: at,
          communityId,
          lifecycleVersion: 2,
          version: 1,
        },
        {
          type: 'community.unlocked',
          eventId: `community.unlocked:${communityId}:3`,
          occurredAt: at,
          communityId,
          lifecycleVersion: 3,
          version: 1,
        },
        {
          type: 'community.access.changed',
          eventId: accessId(communityId, teacher.userId, `granted:${grantId}`),
          occurredAt: c.clock.now().toISOString(),
          communityId,
          version: 1,
        },
      ]);
    });

    it('reaches each of a member’s devices, and a dead device never stops the others', async () => {
      await join(student);
      const phone = h.connect(student.userId);
      const tablet = h.connect(student.userId);
      const dead = h.connect(student.userId);
      dead.healthy = false;

      await move('LOCKED');
      await h.settle();

      for (const device of [phone, tablet]) expect(types(device)).toEqual(['community.locked']);
      expect(dead.frames).toEqual([]);
      expect(dead.closed?.code).toBe(1011);
    });

    it('tells a creator of their own new community as an addition — there is no created frame', async () => {
      const o = h.connect(owner.userId);
      const created = await c.community(owner, 'حلقة الحفظ');
      expectOk(await c.invite.execute({ principal: owner, communityId: created, meta: META }));
      await h.settle();

      expect(community(o)).toEqual([
        expect.objectContaining({ type: 'community.member.added', communityId: created }),
      ]);
      expect(JSON.stringify(o.frames)).not.toMatch(/created|invitation|حلقة/);
    });
  });

  describe('B — a removed member', () => {
    it.each([
      ['were removed', 'removed'],
      ['left', 'left'],
    ] as const)(
      'is told once that they %s, and then nothing about the community',
      async (_how, reason) => {
        await join(student, other);
        const s = h.connect(student.userId);
        const o = h.connect(other.userId);

        if (reason === 'removed') await remove(student);
        else expectOk(await c.leave.execute({ principal: student, communityId, meta: META }));
        await h.settle();
        await move('LOCKED');
        await h.settle();
        await move('OPEN');
        await h.settle();

        expect(community(s)).toEqual([
          {
            type: 'community.member.removed',
            eventId: `community.member.removed:${communityId}:${student.userId}:4`,
            occurredAt: at,
            communityId,
            userId: student.userId,
            reason,
            version: 1,
          },
        ]);
        // The others were not told about it — and still hear the lifecycle.
        expect(types(o)).toEqual(['community.locked', 'community.unlocked']);
      },
    );
  });

  describe('C, D — a non-member, and an overseer with no stint', () => {
    it('receives nothing of the community — whatever ids they know', async () => {
      await join(student, teacher);
      const stranger = h.connect(outsider.userId);
      const oversight = h.connect(overseer.userId);
      const insider = h.connect(teacher.userId);
      // The overseer can read the community over HTTP (oversight)…
      expectOk(await c.get.execute({ principal: overseer, communityId, meta: META }));

      await move('LOCKED');
      await h.settle();
      await c.delegate(owner, communityId, teacher.userId, 'community.lock');
      await move('OPEN', overseer);
      await remove(student);
      await h.settle();
      // …and events naming them, as if they belonged, change nothing.
      for (const userId of [outsider.userId, overseer.userId]) {
        await h.relay.relay(
          domainEvent(
            CommunityEvents.memberAdded,
            communityId,
            {
              communityId,
              userId,
              membershipId: 'a-stint-they-guessed',
              source: 'ADDED',
              addedBy: owner.userId,
              invitationId: null,
              membershipVersion: 99,
            },
            new Date(),
          ),
        );
        await h.relay.relay(
          domainEvent(
            CommunityEvents.capabilityGranted,
            communityId,
            {
              communityId,
              grantId: 'g-guessed',
              membershipId: 'a-stint-they-guessed',
              userId,
              capability: 'community.lock',
              grantedBy: owner.userId,
            },
            new Date(),
          ),
        );
      }

      expect(stranger.frames).toEqual([]);
      expect(oversight.frames).toEqual([]);
      // The pipeline was live all along: a member heard every one of those facts.
      expect(types(insider)).toEqual([
        'community.locked',
        'community.access.changed',
        'community.unlocked',
      ]);
    });
  });

  describe('E — messaging’s projection', () => {
    it('is never read: a stale projected participant row grants no community frame', async () => {
      const m = await messagingHarness({ communities: c });
      try {
        const chair = m.person('ADMIN');
        const learner = m.person('STUDENT');
        const chatCommunity = await m.community(chair, [learner]);
        await m.deliverCommunityEvents();
        const chat = await m.openCommunityChat(chair, chatCommunity);
        const learnerDevice = h.connect(learner.userId);
        const chairDevice = h.connect(chair.userId);

        // Communities removes the learner; messaging is not told (no wake-up delivered).
        expectOk(
          await c.remove.execute({
            principal: chair,
            communityId: chatCommunity,
            userId: learner.userId,
            meta: META,
          }),
        );
        const projected = await m.readModel.listMemberIds(chat.id as ConversationId, {
          limit: 10,
        });
        expect(projected.userIds).toContain(learner.userId);

        expectOk(
          await c.status.execute({
            principal: chair,
            communityId: chatCommunity,
            to: 'LOCKED',
            meta: META,
          }),
        );
        await h.settle();

        expect(types(learnerDevice)).toEqual(['community.member.removed']);
        expect(types(chairDevice)).toEqual(['community.locked']);
      } finally {
        await m.cleanup();
      }
    });
  });

  describe('F — audiences come from Communities at delivery time', () => {
    it('drops a stale added published after the removal, and delivers the removal', async () => {
      await join(student);
      await remove(student);
      const s = h.connect(student.userId);

      // Out of order: the removal first, then the addition it overtook.
      await h.relay.relay(last(CommunityEvents.memberRemoved));
      await h.relay.relay(last(CommunityEvents.memberAdded));

      expect(types(s)).toEqual(['community.member.removed']);
    });

    it('drops an older stint’s added and removed after a rejoin — and tells the current one', async () => {
      await join(student);
      await remove(student);
      await join(student);
      const s = h.connect(student.userId);
      const [firstAdded, secondAdded] = published(CommunityEvents.memberAdded).filter(
        (event) => (event.payload as { userId: string }).userId === student.userId,
      );

      await h.relay.relay(firstAdded);
      await h.relay.relay(last(CommunityEvents.memberRemoved));
      await h.relay.relay(secondAdded);

      expect(community(s)).toEqual([
        expect.objectContaining({
          type: 'community.member.added',
          eventId: `community.member.added:${communityId}:${student.userId}:4`,
        }),
      ]);
    });

    it('drops a lock published after the unlock that overtook it', async () => {
      await join(student);
      await move('LOCKED');
      await move('OPEN');
      const s = h.connect(student.userId);

      await h.relay.relay(last(CommunityEvents.communityUnlocked));
      await h.relay.relay(last(CommunityEvents.communityLocked));

      expect(community(s)).toEqual([
        expect.objectContaining({ type: 'community.unlocked', lifecycleVersion: 3 }),
      ]);
    });

    it('drops every lifecycle frame of a community Communities does not know', async () => {
      const s = h.connect(student.userId);
      await h.relay.relay(
        domainEvent(
          CommunityEvents.communityLocked,
          'no-such-community',
          { communityId: 'no-such-community', lockedBy: null, lifecycleVersion: 2 },
          new Date(),
        ),
      );
      expect(s.frames).toEqual([]);
    });
  });

  describe('G — access changes', () => {
    it('go to the grantee alone, with nothing but the community’s id', async () => {
      await join(teacher, student);
      const t = h.connect(teacher.userId);
      const s = h.connect(student.userId);
      const o = h.connect(owner.userId);

      const [grantId] = await c.delegate(owner, communityId, teacher.userId, 'community.lock');
      await h.settle();
      c.clock.advance(1);
      expectOk(await c.revokeGrant.execute({ principal: owner, communityId, grantId, meta: META }));
      await h.settle();

      const frames = community(t);
      expect(frames.map((frame) => Object.keys(frame).sort())).toEqual([
        ['communityId', 'eventId', 'occurredAt', 'type', 'version'],
        ['communityId', 'eventId', 'occurredAt', 'type', 'version'],
      ]);
      expect(frames.map((frame) => frame.type)).toEqual([
        'community.access.changed',
        'community.access.changed',
      ]);
      // Two facts, two ids.
      expect(new Set(frames.map((frame) => frame.eventId)).size).toBe(2);
      // Neither which capability, nor which grant, nor who granted it.
      const wire = JSON.stringify(t.frames);
      for (const secret of ['community.lock"', grantId, owner.userId, 'grant']) {
        expect(wire).not.toContain(secret);
      }
      expect(community(s)).toEqual([]);
      expect(community(o)).toEqual([]);
    });

    it('never widen an audience: a delegate hears nothing of others joining or leaving', async () => {
      await join(teacher, student);
      await c.delegate(
        owner,
        communityId,
        teacher.userId,
        'community.members.view',
        'community.members.invite',
        'community.members.remove',
      );
      const t = h.connect(teacher.userId);
      const newcomer = c.person('newcomer-1', ['STUDENT']);

      expectOk(
        await c.add.execute({
          principal: teacher,
          communityId,
          userIds: [newcomer.userId],
          meta: META,
        }),
      );
      await h.settle();
      expectOk(
        await c.remove.execute({
          principal: teacher,
          communityId,
          userId: student.userId,
          meta: META,
        }),
      );
      await h.settle();

      expect(community(t)).toEqual([]);
    });

    it('tell both sides of an ownership transfer — each their own frame — and nobody else', async () => {
      await join(teacher, student);
      const o = h.connect(owner.userId);
      const t = h.connect(teacher.userId);
      const s = h.connect(student.userId);

      expectOk(
        await c.transfer.execute({
          principal: owner,
          communityId,
          userId: teacher.userId,
          meta: META,
        }),
      );
      await h.settle();

      const ms = c.clock.now().getTime();
      expect(community(o).map((frame) => frame.eventId)).toEqual([
        accessId(communityId, owner.userId, `transferred:from:${ms}`),
      ]);
      expect(community(t).map((frame) => frame.eventId)).toEqual([
        accessId(communityId, teacher.userId, `transferred:to:${ms}`),
      ]);
      expect(community(s)).toEqual([]);
    });

    it('name a transfer by what its recipient already knows — never by the other party', async () => {
      // After an oversight transfer the former owner is a MEMBER who can
      // neither list the roster nor read who owns the community now: the
      // frame telling them their access changed must not tell them that.
      const formerOwnerIds = async (newOwner: string): Promise<string[]> => {
        const run = communitiesRealtimeHarness();
        try {
          const rc = run.communities;
          const admin = rc.person('owner-1', ['ADMIN']);
          const boss = rc.person('overseer-1', ['ADMIN']);
          const former = rc.person('teacher-a', ['TEACHER']);
          rc.person('teacher-b', ['TEACHER']);
          rc.person('teacher-c', ['TEACHER']);
          const id = await rc.community(admin);
          await rc.addPeople(admin, id, former.userId, 'teacher-b', 'teacher-c');
          expectOk(
            await rc.transfer.execute({
              principal: admin,
              communityId: id,
              userId: former.userId,
              meta: META,
            }),
          );
          const link = run.connect(former.userId);
          expectOk(
            await rc.transfer.execute({
              principal: boss,
              communityId: id,
              userId: newOwner,
              meta: META,
            }),
          );
          await run.settle();
          return community(link).map((frame) => String(frame.eventId));
        } finally {
          run.cleanup();
        }
      };

      const toB = await formerOwnerIds('teacher-b');
      expect(toB).toHaveLength(1);
      // The same transfer to someone else, at the same moment: the same frame.
      expect(await formerOwnerIds('teacher-c')).toEqual(toB);
    });
  });

  describe('H — lock frames', () => {
    it('carry the lifecycle version only: no state, no effect, no capability', async () => {
      await join(student);
      const s = h.connect(student.userId);
      await move('LOCKED');
      await h.settle();

      const [frame] = community(s);
      expect(Object.keys(frame).sort()).toEqual([
        'communityId',
        'eventId',
        'lifecycleVersion',
        'occurredAt',
        'type',
        'version',
      ]);
      expect(JSON.stringify(s.frames)).not.toMatch(
        /LOCKED|status|effects|capabilit|chat|owner-1|حلقة/,
      );
    });
  });

  describe('J — redelivery', () => {
    it('gives the same event, relayed twice, byte-identical frames', async () => {
      await join(teacher);
      await move('LOCKED');
      await c.delegate(owner, communityId, teacher.userId, 'community.members.view');
      const t = h.connect(teacher.userId);

      for (const name of [
        CommunityEvents.memberAdded,
        CommunityEvents.communityLocked,
        CommunityEvents.capabilityGranted,
      ]) {
        await h.relay.relay(last(name));
        await h.relay.relay(last(name));
      }

      expect(t.raw).toHaveLength(6);
      for (let i = 0; i < 6; i += 2) expect(t.raw[i + 1]).toBe(t.raw[i]);
      expect(new Set(t.raw).size).toBe(3);
    });
  });

  describe('narrowing and cost', () => {
    it('tells nothing to a member whose account lost the view ceiling, or was suspended', async () => {
      await join(student, other);
      const s = h.connect(student.userId);
      const o = h.connect(other.userId);
      c.accounts.setPermissions(student.userId, ['messaging.read']);
      c.accounts.suspend(other.userId);

      await move('LOCKED');
      await h.settle();
      for (const event of published(CommunityEvents.memberAdded)) await h.relay.relay(event);
      await remove(student);
      await remove(other);
      await h.settle();

      expect(s.frames).toEqual([]);
      expect(o.frames).toEqual([]);
    });

    it('asks nothing — and schedules nothing — when nobody is connected', async () => {
      const relay = jest.spyOn(h.relay, 'relay');
      const asked = [
        jest.spyOn(c.membership, 'heads'),
        jest.spyOn(c.membership, 'members'),
        jest.spyOn(c.membership, 'statesOf'),
      ];

      await join(teacher, student);
      await move('LOCKED');
      await c.delegate(owner, communityId, teacher.userId, 'community.lock');
      await remove(student);
      await h.settle();

      expect(relay).not.toHaveBeenCalled();
      for (const call of asked) expect(call).not.toHaveBeenCalled();

      // Relayed by hand with nobody here: still not a single question.
      relay.mockRestore();
      const withPermission = jest.spyOn(c.accounts, 'withPermission');
      for (const event of c.journal.events) await h.relay.relay(event);
      for (const call of [...asked, withPermission]) expect(call).not.toHaveBeenCalled();
    });

    it('asks nothing about a person who is not connected here', async () => {
      await join(student);
      h.connect(owner.userId);
      const statesOf = jest.spyOn(c.membership, 'statesOf');
      const withPermission = jest.spyOn(c.accounts, 'withPermission');

      await h.relay.relay(last(CommunityEvents.memberAdded));

      expect(statesOf).not.toHaveBeenCalled();
      expect(withPermission).not.toHaveBeenCalled();
    });

    it('costs one statesOf and one withPermission for a person online; a lock one heads, one page, one withPermission', async () => {
      await join(teacher);
      await join(student);
      await move('LOCKED');
      const s = h.connect(student.userId);
      h.connect(teacher.userId);
      const calls = {
        heads: jest.spyOn(c.membership, 'heads'),
        members: jest.spyOn(c.membership, 'members'),
        statesOf: jest.spyOn(c.membership, 'statesOf'),
        withPermission: jest.spyOn(c.accounts, 'withPermission'),
      };
      const counts = () =>
        Object.fromEntries(
          Object.entries(calls).map(([name, spy]) => [name, spy.mock.calls.length]),
        );

      await h.relay.relay(last(CommunityEvents.memberAdded));
      expect(counts()).toEqual({ heads: 0, members: 0, statesOf: 1, withPermission: 1 });

      for (const spy of Object.values(calls)) spy.mockClear();
      await h.relay.relay(last(CommunityEvents.communityLocked));
      expect(counts()).toEqual({ heads: 1, members: 1, statesOf: 0, withPermission: 1 });
      expect(calls.members.mock.calls[0]?.[1]).toEqual({
        onlyUserIds: undefined,
        cursor: null,
        limit: 1000,
      });
      expect(types(s)).toEqual(['community.member.added', 'community.locked']);
    });
  });

  describe('robustness', () => {
    it('ignores a malformed event with a warning, instead of guessing', async () => {
      await join(student);
      const s = h.connect(student.userId);
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const now = new Date();

      for (const event of [
        domainEvent(CommunityEvents.memberAdded, communityId, { communityId, userId: 'x' }, now),
        domainEvent(
          CommunityEvents.memberRemoved,
          communityId,
          {
            communityId,
            userId: student.userId,
            membershipId: 'm',
            reason: 'KICKED',
            removedBy: null,
            membershipVersion: 3,
          },
          now,
        ),
        domainEvent(
          CommunityEvents.communityLocked,
          communityId,
          { communityId, lockedBy: null, lifecycleVersion: '2' },
          now,
        ),
        // About another community than the one it is ordered under.
        domainEvent(
          CommunityEvents.capabilityGranted,
          communityId,
          { communityId: 'elsewhere', userId: student.userId },
          now,
        ),
        domainEvent(
          CommunityEvents.ownershipTransferred,
          communityId,
          { communityId, fromUserId: owner.userId },
          now,
        ),
        domainEvent(CommunityEvents.communityUnlocked, communityId, null, now),
      ]) {
        await h.relay.relay(event);
      }

      expect(s.frames).toEqual([]);
      expect(warned).toHaveBeenCalledTimes(6);
      expect(warned).toHaveBeenCalledWith(
        { event: CommunityEvents.memberAdded },
        'ignoring a malformed community event',
      );
    });

    it('delivers one community’s events in the order they were published', async () => {
      const t = h.connect(teacher.userId);
      const statesOf = c.membership.statesOf.bind(c.membership);
      let first = true;
      jest.spyOn(c.membership, 'statesOf').mockImplementation(async (...args) => {
        if (first) {
          first = false;
          await delay(30); // the first is slow
        }
        return statesOf(...args);
      });

      await join(teacher);
      await c.delegate(owner, communityId, teacher.userId, 'community.members.view');
      await move('LOCKED');
      await h.settle();

      expect(types(t)).toEqual([
        'community.member.added',
        'community.access.changed',
        'community.locked',
      ]);
    });

    it('logs a failed delivery with ids only, and delivers the next event as usual', async () => {
      await join(student);
      const s = h.connect(student.userId);
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest
        .spyOn(c.membership, 'heads')
        .mockRejectedValueOnce(new Error('Communities is unavailable'));

      await move('LOCKED');
      await h.settle();
      await move('OPEN');
      await h.settle();

      expect(types(s)).toEqual(['community.unlocked']);
      expect(logged).toHaveBeenCalledTimes(1);
      const [details, message] = logged.mock.calls[0] as [Record<string, unknown>, string];
      expect(message).toBe('realtime delivery failed');
      expect(Object.keys(details).sort()).toEqual(['aggregateId', 'err', 'event']);
      expect(details).toMatchObject({
        event: CommunityEvents.communityLocked,
        aggregateId: communityId,
      });
    });

    it('stops listening when the module is destroyed', async () => {
      await join(student);
      const s = h.connect(student.userId);
      h.cleanup();
      await move('LOCKED');
      await h.settle();
      expect(s.frames).toEqual([]);
    });
  });
});
