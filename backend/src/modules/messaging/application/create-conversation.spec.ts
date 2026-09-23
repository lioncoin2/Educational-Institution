import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  messagingHarness,
  type MessagingHarness,
} from '../../../../test/support/messaging-harness';
import { Roles } from '../../identity/domain/role';
import { MessagingEvents } from '../contracts/events';
import { MAX_PARTICIPANTS_PER_REQUEST } from '../domain/messaging-policy';
import { CONVERSATIONS_CREATED_PER_USER, MessagingAudit } from './messaging-settings';

describe('starting a direct conversation', () => {
  let h: MessagingHarness;
  beforeEach(async () => {
    h = await messagingHarness();
  });
  afterEach(() => h.cleanup());

  const start = (principal: ReturnType<MessagingHarness['person']>, counterpartUserId: string) =>
    h.startDirect.execute({ principal, counterpartUserId, meta: META });

  it('creates it once and returns the same conversation to every later request, from either side', async () => {
    const teacher = h.person(Roles.teacher, 'أستاذ أحمد');
    const supervisor = h.person(Roles.supervisor, 'مشرف');

    const first = expectOk(await start(teacher, supervisor.userId));
    expect(first.created).toBe(true);
    expect(first.conversation).toMatchObject({
      type: 'DIRECT',
      title: 'مشرف', // the other person's name, as the viewer sees it
      counterpartUserId: supervisor.userId,
      memberCount: 2,
      myRole: 'MEMBER',
      canPost: true,
      canManageMembers: false,
    });

    const again = expectOk(await start(teacher, supervisor.userId));
    const reverse = expectOk(await start(supervisor, teacher.userId));
    expect(again).toMatchObject({ created: false, conversation: { id: first.conversation.id } });
    expect(reverse).toMatchObject({ created: false, conversation: { id: first.conversation.id } });
    expect(reverse.conversation.title).toBe('أستاذ أحمد');
  });

  it('records the creation once — audit and event — and nothing for a repeat', async () => {
    const teacher = h.person(Roles.teacher);
    const student = h.person(Roles.student);
    const { conversation } = expectOk(await start(teacher, student.userId));
    await start(teacher, student.userId);

    expect(h.audit.actions()).toEqual([MessagingAudit.conversationCreated]);
    expect(h.audit.last(MessagingAudit.conversationCreated)).toMatchObject({
      actorUserId: teacher.userId,
      resourceId: conversation.id,
      metadata: { type: 'DIRECT', participantCount: 2 },
    });
    expect(h.events.published.map((event) => event.name)).toEqual([
      MessagingEvents.conversationCreated,
    ]);
  });

  // Q6, provisional: students take part; they do not initiate.
  it('refuses a student — and an assistant — the right to start one', async () => {
    const teacher = h.person(Roles.teacher);
    for (const role of [Roles.student, Roles.assistantTeacher]) {
      const person = h.person(role);
      expect(expectErr(await start(person, teacher.userId)).code).toBe(
        'identity.permission_denied',
      );
    }
  });

  it('refuses oneself, an unknown account, and an inactive one — alike', async () => {
    const teacher = h.person(Roles.teacher);
    const gone = h.person(Roles.student);
    h.directory.deactivate(gone.userId);

    expect(expectErr(await start(teacher, teacher.userId)).code).toBe('messaging.direct_with_self');
    expect(expectErr(await start(teacher, 'no-such-account')).code).toBe(
      'messaging.participant_not_eligible',
    );
    expect(expectErr(await start(teacher, gone.userId)).code).toBe(
      'messaging.participant_not_eligible',
    );
  });

  it('limits how many conversations one person may start', async () => {
    const teacher = h.person(Roles.teacher);
    for (let i = 0; i < CONVERSATIONS_CREATED_PER_USER.limit; i++) {
      expectOk(await start(teacher, h.person(Roles.student).userId));
    }
    expect(expectErr(await start(teacher, h.person(Roles.student).userId))).toMatchObject({
      kind: 'rate_limited',
      code: 'messaging.too_many_conversations',
    });
  });
});

describe('creating groups and channels', () => {
  let h: MessagingHarness;
  beforeEach(async () => {
    h = await messagingHarness();
  });
  afterEach(() => h.cleanup());

  it('creates a group its creator owns and every member may write in', async () => {
    const teacher = h.person(Roles.teacher);
    const students = [h.person(Roles.student), h.person(Roles.student)];
    const group = await h.group(teacher, students, '  حلقة   الفجر ');

    expect(group).toMatchObject({
      type: 'GROUP',
      title: 'حلقة الفجر',
      memberCount: 3,
      myRole: 'OWNER',
      canPost: true,
      canManageMembers: true,
      unreadCount: 0,
      lastMessage: null,
    });
    const studentView = expectOk(
      await h.getConversation.execute({ principal: students[0], conversationId: group.id }),
    );
    expect(studentView).toMatchObject({ myRole: 'MEMBER', canPost: true, canManageMembers: false });
  });

  it('refuses a group to anyone without messaging.create_group', async () => {
    const student = h.person(Roles.student);
    const result = await h.createGroup.execute({
      principal: student,
      title: 'Our group',
      memberIds: [],
      meta: META,
    });
    expect(expectErr(result).code).toBe('identity.permission_denied');
  });

  it('names every ineligible person, and creates nothing', async () => {
    const teacher = h.person(Roles.teacher);
    const ok = h.person(Roles.student);
    const suspended = h.person(Roles.student);
    h.directory.deactivate(suspended.userId);

    const result = await h.createGroup.execute({
      principal: teacher,
      title: 'Halaqa',
      memberIds: [ok.userId, suspended.userId, 'unknown-account'],
      meta: META,
    });
    const error = expectErr(result) as { code: string; details?: { userIds: string[] } };
    expect(error.code).toBe('messaging.participant_not_eligible');
    expect(error.details?.userIds).toEqual([suspended.userId, 'unknown-account']);
    expect(expectOk(await h.listConversations.execute({ principal: teacher })).items).toEqual([]);
  });

  it('bounds how many people one request may add', async () => {
    const teacher = h.person(Roles.teacher);
    const memberIds = Array.from(
      { length: MAX_PARTICIPANTS_PER_REQUEST + 1 },
      () => h.person(Roles.student).userId,
    );
    const result = await h.createGroup.execute({
      principal: teacher,
      title: 'Too many',
      memberIds,
      meta: META,
    });
    expect(expectErr(result).code).toBe('messaging.too_many_in_request');
  });

  it('creates a channel with publishers, readers, and an owner', async () => {
    const admin = h.person(Roles.admin);
    const teacher = h.person(Roles.teacher);
    const student = h.person(Roles.student);
    const channel = expectOk(
      await h.createChannel.execute({
        principal: admin,
        title: 'إعلانات المعهد',
        memberIds: [student.userId, teacher.userId],
        publisherIds: [teacher.userId],
        meta: META,
      }),
    );
    expect(channel).toMatchObject({ type: 'CHANNEL', memberCount: 3, myRole: 'OWNER' });

    const roles = Object.fromEntries(
      expectOk(
        await h.listParticipants.execute({ principal: admin, conversationId: channel.id }),
      ).items.map((p) => [p.userId, p.role]),
    );
    expect(roles).toEqual({
      [admin.userId]: 'OWNER',
      [teacher.userId]: 'PUBLISHER',
      [student.userId]: 'MEMBER',
    });
  });

  it('refuses a channel to a teacher (provisional), and a publisher who cannot send', async () => {
    const teacher = h.person(Roles.teacher);
    expect(
      expectErr(
        await h.createChannel.execute({
          principal: teacher,
          title: 'Mine',
          memberIds: [],
          publisherIds: [],
          meta: META,
        }),
      ).code,
    ).toBe('identity.permission_denied');

    const admin = h.person(Roles.admin);
    const readOnly = h.person(Roles.student);
    h.directory.add(readOnly.userId, [], { displayName: 'no roles' });
    const result = await h.createChannel.execute({
      principal: admin,
      title: 'News',
      memberIds: [],
      publisherIds: [readOnly.userId],
      meta: META,
    });
    expect(expectErr(result).code).toBe('messaging.participant_not_eligible');
  });

  it('validates the title', async () => {
    const teacher = h.person(Roles.teacher);
    const result = await h.createGroup.execute({
      principal: teacher,
      title: '   ',
      memberIds: [],
      meta: META,
    });
    expect(expectErr(result).code).toBe('messaging.title_required');
  });
});
