import type { Principal } from '../../../shared';
import { META, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { LiveEvents } from '../contracts/events';

/**
 * A live session's own chat (owner decision F, ADR 0047), over the REAL
 * Communities authorization: every participant reads and — by default —
 * posts; a moderator locks it, and then only moderators post, refused at the
 * write; it is the session's, never the community's conversation, and never
 * another session's.
 */
describe('live session chat (ADR 0047)', () => {
  let h: LiveHarness;
  let owner: Principal; // the community's owner (a TEACHER): moderates every session
  let student: Principal;
  let other: Principal;
  let communityId: string;
  let sessionId: string;
  let keys = 0;

  const key = () => `chat-key-${String((keys += 1)).padStart(6, '0')}`;
  const post = (who: Principal, body: string, clientMessageId = key(), session = sessionId) =>
    h.postChat.execute({ principal: who, sessionId: session, clientMessageId, body, meta: META });
  const read = (who: Principal, session = sessionId, before?: string, limit?: number) =>
    h.listChat.execute({ principal: who, sessionId: session, before, limit });
  const lock = (who: Principal, locked: boolean, session = sessionId) =>
    h.chatLock.execute({ principal: who, sessionId: session, locked, meta: META });
  const code = (result: { ok: boolean; error?: { code: string } }) =>
    result.ok ? 'ok' : result.error?.code;
  const bodies = async (who: Principal) => {
    const page = await read(who);
    if (!page.ok) throw new Error(page.error.code);
    return page.value.items.map((item) => item.body);
  };

  beforeEach(async () => {
    h = liveHarness();
    keys = 0;
    const community = await h.community('teacher-1', 'student-1', 'student-2');
    communityId = community.id;
    owner = community.owner;
    [student, other] = community.students as [Principal, Principal];
    sessionId = (await h.startSession(owner, communityId)).id;
  });

  describe('by default', () => {
    it('lets every participant post and read, newest first, with the sender’s name', async () => {
      expect((await post(student, 'السلام عليكم')).ok).toBe(true);
      h.clock.advance(1);
      expect((await post(owner, 'وعليكم السلام')).ok).toBe(true);
      expect(await bodies(other)).toEqual(['وعليكم السلام', 'السلام عليكم']);
      const page = await read(other);
      expect(page.ok && page.value).toMatchObject({
        locked: false,
        lockVersion: 0,
        canPost: true,
        canModerate: false,
        items: [{ senderId: 'teacher-1', senderDisplayName: 'teacher-1' }, {}],
      });
    });

    it('lands a retried post once (200 with the stored one); a reused key is 409', async () => {
      const first = await post(student, 'مرة واحدة', 'retry-key-000001');
      const again = await post(student, 'مرة واحدة', 'retry-key-000001');
      expect(first.ok && first.value.created).toBe(true);
      expect(again.ok && again.value).toMatchObject({ created: false });
      expect(again.ok && first.ok && again.value.message.id).toBe(
        first.ok ? first.value.message.id : null,
      );
      expect(code(await post(student, 'نص آخر', 'retry-key-000001'))).toBe(
        'live.chat_client_message_id_reused',
      );
      expect(await bodies(owner)).toEqual(['مرة واحدة']);
    });

    it('bounds the text and the key (422) and keeps line breaks, never control characters', async () => {
      expect(code(await post(student, '   '))).toBe('live.chat_body_required');
      expect(code(await post(student, 'x'.repeat(501)))).toBe('live.chat_body_too_long');
      expect(code(await post(student, 'ok', 'bad key!'))).toBe(
        'live.chat_client_message_id_invalid',
      );
      expect((await post(student, 'سطر\nثانٍ‮')).ok).toBe(true);
      expect(await bodies(owner)).toEqual(['سطر\nثانٍ']);
    });

    it('announces a post with ids only, and audits nothing — a person’s own act', async () => {
      const before = h.audits().length;
      await post(student, 'نص لا يخرج في الحدث');
      const events = h.journal.events.filter((event) => event.name === LiveEvents.chatPosted);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({
        sessionId,
        communityId,
        messageId: expect.any(String),
        senderId: 'student-1',
        position: expect.any(Number),
      });
      expect(JSON.stringify(events)).not.toContain('نص لا يخرج');
      expect(h.audits()).toHaveLength(before);
    });

    it('pages back through a long chat without repeating a message', async () => {
      for (let i = 1; i <= 7; i++) await post(student, `m${i}`);
      const first = await read(owner, sessionId, undefined, 3);
      if (!first.ok) throw new Error(first.error.code);
      expect(first.value.items.map((m) => m.body)).toEqual(['m7', 'm6', 'm5']);
      const second = await read(owner, sessionId, first.value.nextCursor ?? undefined, 3);
      const third = second.ok
        ? await read(owner, sessionId, second.value.nextCursor ?? undefined, 3)
        : second;
      expect(second.ok && second.value.items.map((m) => m.body)).toEqual(['m4', 'm3', 'm2']);
      expect(third.ok && third.value).toMatchObject({ nextCursor: null, items: [{ body: 'm1' }] });
      expect(code(await read(owner, sessionId, 'not-a-cursor'))).toBe('live.cursor_invalid');
    });
  });

  describe('the lock', () => {
    it('lets a moderator close it: participants are refused, moderators still post', async () => {
      const locked = await lock(owner, true);
      expect(locked.ok && locked.value).toEqual({ changed: true, locked: true, lockVersion: 1 });
      expect(code(await post(student, 'ممنوع الآن'))).toBe('live.chat_locked');
      expect((await post(owner, 'تنبيه من المشرف')).ok).toBe(true);
      const seen = await read(student);
      expect(seen.ok && seen.value).toMatchObject({ locked: true, lockVersion: 1, canPost: false });
      expect(await bodies(student)).toEqual(['تنبيه من المشرف']);
    });

    it('re-opens it; a repeat changes, audits and announces nothing', async () => {
      await lock(owner, true);
      const repeat = await lock(owner, true);
      expect(repeat.ok && repeat.value).toEqual({ changed: false, locked: true, lockVersion: 1 });
      const reopened = await lock(owner, false);
      expect(reopened.ok && reopened.value).toEqual({
        changed: true,
        locked: false,
        lockVersion: 2,
      });
      expect((await post(student, 'عاد الكلام')).ok).toBe(true);
      expect(h.audits().filter((a) => a.startsWith('live.chat.'))).toEqual([
        'live.chat.locked',
        'live.chat.unlocked',
      ]);
      const changes = h.journal.events.filter((e) => e.name === LiveEvents.chatLockChanged);
      expect(changes.map((e) => e.payload)).toEqual([
        { sessionId, communityId, locked: true, lockVersion: 1, changedBy: 'teacher-1' },
        { sessionId, communityId, locked: false, lockVersion: 2, changedBy: 'teacher-1' },
      ]);
    });

    it('is a moderator’s: a delegated live moderator may, a plain participant may not', async () => {
      const deputy = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
      expect((await lock(deputy, true)).ok).toBe(true);
      expect((await post(deputy, 'من المشرف المفوَّض')).ok).toBe(true);
      // A student lacks identity's live.moderate at all; a teacher member without
      // the community grant is refused by Communities.
      expect(code(await lock(student, false))).toBe('identity.permission_denied');
      const teacher = await h.member(communityId, owner, 'teacher-3', ['TEACHER']);
      expect(code(await lock(teacher, false))).toBe('live.not_a_moderator');
      expect(code(await post(teacher, 'لا يزال مقفلًا'))).toBe('live.chat_locked');
    });

    it('starts open for every new session — a lock never carries over', async () => {
      await lock(owner, true);
      await h.end.execute({ principal: owner, sessionId, meta: META });
      const next = (await h.startSession(owner, communityId)).id;
      const page = await read(student, next);
      expect(page.ok && page.value).toMatchObject({ locked: false, lockVersion: 0, items: [] });
      expect((await post(student, 'جلسة جديدة', key(), next)).ok).toBe(true);
    });
  });

  describe('scope and lifecycle', () => {
    it('keeps a non-member out with the 404 an unknown session is', async () => {
      const outsider = h.person('teacher-9', ['TEACHER']);
      expect(code(await read(outsider))).toBe('live.session_not_found');
      expect(code(await post(outsider, 'من الخارج'))).toBe('live.session_not_found');
      expect(code(await lock(outsider, true))).toBe('live.session_not_found');
    });

    it('isolates sessions: another community’s session shares nothing', async () => {
      const elsewhere = await h.community('teacher-5', 'student-5');
      const foreign = (await h.startSession(elsewhere.owner, elsewhere.id)).id;
      await post(student, 'في جلستنا');
      await post(elsewhere.students[0], 'في جلستهم', key(), foreign);
      expect(await bodies(owner)).toEqual(['في جلستنا']);
      const theirs = await read(elsewhere.owner, foreign);
      expect(theirs.ok && theirs.value.items.map((m) => m.body)).toEqual(['في جلستهم']);
      // Neither side reaches into the other.
      expect(code(await read(student, foreign))).toBe('live.session_not_found');
      expect(code(await lock(owner, true, foreign))).toBe('live.session_not_found');
      expect(await h.chat.find(sessionId, theirs.ok ? (theirs.value.items[0]?.id ?? '') : '')).toBe(
        null,
      );
    });

    it('closes posting and locking when the session ends; the chat stays readable', async () => {
      await post(student, 'قبل النهاية');
      await h.end.execute({ principal: owner, sessionId, meta: META });
      expect(code(await post(student, 'بعد النهاية'))).toBe('live.session_not_live');
      expect(code(await post(owner, 'بعد النهاية'))).toBe('live.session_not_live');
      expect(code(await lock(owner, true))).toBe('live.session_not_live');
      const page = await read(student);
      expect(page.ok && page.value).toMatchObject({
        canPost: false,
        canModerate: false,
        items: [{ body: 'قبل النهاية' }],
      });
    });

    it('drops a removed member at once: no read, no post', async () => {
      await post(student, 'قبل الإزالة');
      await h.remove(communityId, owner, 'student-1');
      expect(code(await read(student))).toBe('live.session_not_found');
      expect(code(await post(student, 'بعد الإزالة'))).toBe('live.session_not_found');
      expect(await bodies(owner)).toEqual(['قبل الإزالة']);
    });

    it('shows a late joiner the history and the lock as they stand', async () => {
      await post(student, 'أول رسالة');
      await lock(owner, true);
      const late = await h.member(communityId, owner, 'student-7');
      const page = await read(late);
      expect(page.ok && page.value).toMatchObject({
        locked: true,
        lockVersion: 1,
        canPost: false,
        items: [{ body: 'أول رسالة' }],
      });
    });

    it('is never the community’s conversation: nothing here writes messaging', async () => {
      await post(student, 'دردشة البث فقط');
      // Live's own store holds it; the community chat (messaging) is not a
      // dependency of Live at all — enforced by the live boundaries spec.
      const page = await h.chat.page(sessionId, { beforePosition: null, limit: 10 });
      expect(page.map((m) => m.body)).toEqual(['دردشة البث فقط']);
    });
  });
});
