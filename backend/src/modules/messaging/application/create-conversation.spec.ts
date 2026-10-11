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

  // Q6, owner GROUP A ruling (2026-10-11): a student may start a DM with
  // another student — and with no one else. An assistant still starts nothing.
  it('lets a student start a direct conversation with another student, once, from either side', async () => {
    const student = h.person(Roles.student, 'طالب');
    const peer = h.person(Roles.student, 'زميل');

    const created = expectOk(await start(student, peer.userId));
    expect(created.created).toBe(true);
    expect(created.conversation).toMatchObject({
      type: 'DIRECT',
      title: 'زميل',
      counterpartUserId: peer.userId,
      memberCount: 2,
      canPost: true,
      canManageMembers: false,
    });

    const reverse = expectOk(await start(peer, student.userId));
    expect(reverse).toMatchObject({
      created: false,
      conversation: { id: created.conversation.id },
    });
    expect(reverse.conversation.title).toBe('طالب');
  });

  // Owner GROUP A ruling (Q6, 2026-10-11): a student may also start a DM with an
  // eligible teacher — a holder of `academic.teach` who is not an administrator.
  // Teacher AND assistant teacher both qualify; the owner/admin do not (they hold
  // `users.manage`), nor does a supervisor (no `academic.teach`).
  it('lets a student start a direct conversation with an eligible teacher (and an assistant teacher)', async () => {
    const student = h.person(Roles.student, 'طالب');
    const teacher = h.person(Roles.teacher, 'الأستاذ');
    const assistant = h.person(Roles.assistantTeacher, 'المساعد');

    const toTeacher = expectOk(await start(student, teacher.userId));
    expect(toTeacher.created).toBe(true);
    expect(toTeacher.conversation).toMatchObject({
      type: 'DIRECT',
      title: 'الأستاذ',
      counterpartUserId: teacher.userId,
      memberCount: 2,
    });
    // Canonical from the teacher's side too (a broad starter reaching back).
    expect(expectOk(await start(teacher, student.userId))).toMatchObject({
      created: false,
      conversation: { id: toTeacher.conversation.id },
    });

    // An assistant teacher is an eligible teacher as well (holds `academic.teach`
    // and is not an administrator) — the student may start one, even though the
    // assistant may not initiate one themselves.
    const toAssistant = expectOk(await start(student, assistant.userId));
    expect(toAssistant.created).toBe(true);
    expect(toAssistant.conversation).toMatchObject({
      type: 'DIRECT',
      counterpartUserId: assistant.userId,
    });
  });

  // The student grants reach peers and teachers only: a supervisor (no
  // `academic.teach`) and the administrators (owner, admin — they hold
  // `users.manage`) are refused, and reported exactly like an id that does not
  // exist, so a student cannot probe for who is an administrator.
  it('refuses a student a DM with a supervisor, an admin, the owner, or an unknown account', async () => {
    const student = h.person(Roles.student);
    for (const who of [Roles.supervisor, Roles.admin, Roles.owner]) {
      const target = h.person(who);
      expect(expectErr(await start(student, target.userId)).code).toBe(
        'messaging.participant_not_eligible',
      );
    }
    expect(expectErr(await start(student, 'no-such-account')).code).toBe(
      'messaging.participant_not_eligible',
    );
  });

  it('refuses a student a DM with an inactive teacher, like any ineligible account', async () => {
    const student = h.person(Roles.student);
    const teacher = h.person(Roles.teacher);
    h.directory.deactivate(teacher.userId);
    expect(expectErr(await start(student, teacher.userId)).code).toBe(
      'messaging.participant_not_eligible',
    );
  });

  // A student may message a teacher, but that is not a window into the teacher's
  // other conversations: a different student remains a non-member.
  it('keeps a student↔teacher DM to its two members; a third student is refused', async () => {
    const student = h.person(Roles.student);
    const teacher = h.person(Roles.teacher);
    const other = h.person(Roles.student);
    const dm = expectOk(await start(student, teacher.userId)).conversation;
    expect(
      expectErr(await h.getConversation.execute({ principal: other, conversationId: dm.id })).code,
    ).toBe('messaging.conversation_not_found');
  });

  it('refuses an assistant the right to start one at all', async () => {
    const assistant = h.person(Roles.assistantTeacher);
    const student = h.person(Roles.student);
    expect(expectErr(await start(assistant, student.userId)).code).toBe(
      'identity.permission_denied',
    );
  });

  // The membership gate holds for a peer DM: the two students are in it; a
  // third student — a peer, but not a member — is refused read and send alike,
  // told only what a conversation that does not exist would tell them (Q22/Q23).
  // Starting a peer DM grants no window into anyone else's.
  it('keeps a student peer DM to its two members; a third student is refused as if it did not exist', async () => {
    const a = h.person(Roles.student, 'أ');
    const b = h.person(Roles.student, 'ب');
    const c = h.person(Roles.student, 'ج');

    const dm = expectOk(await start(a, b.userId)).conversation;

    expect(
      expectOk(await h.getConversation.execute({ principal: a, conversationId: dm.id })).id,
    ).toBe(dm.id);
    expect(
      expectOk(await h.getConversation.execute({ principal: b, conversationId: dm.id })).id,
    ).toBe(dm.id);

    expect(
      expectErr(await h.getConversation.execute({ principal: c, conversationId: dm.id })).code,
    ).toBe('messaging.conversation_not_found');
    expect(
      expectErr(
        await h.sendText.execute({
          principal: c,
          conversationId: dm.id,
          clientMessageId: 'c-intrusion-0001',
          body: 'hi',
          meta: META,
        }),
      ).code,
    ).toBe('messaging.conversation_not_found');
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
