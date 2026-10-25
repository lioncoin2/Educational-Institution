import type { Principal } from '../../../shared';
import {
  META,
  codeOf,
  liveHarness,
  withUnmappedStatus,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { LIVE_REACTION_KINDS } from '../domain/live-reaction';
import type { LiveSessionView } from './views';

/**
 * The live room's four reactions (C15, ADR 0049): a participant's gesture in a
 * running session, published as an ids-and-kind fact for the realtime relay,
 * stored nowhere and audited never — and refused to anyone who does not take
 * part in that very session.
 */
describe('live reactions', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    session = await h.startSession(owner, communityId);
    h.journal.clear();
  });

  const react = (principal: Principal, kind: unknown, sessionId = session.id) =>
    h.sendReaction.execute({ principal, sessionId, kind, meta: META });

  it('names exactly the four reactions the room shows', () => {
    expect(LIVE_REACTION_KINDS).toEqual(['heart', 'thumbs_up', 'clap', 'smile']);
  });

  it.each(LIVE_REACTION_KINDS)(
    'publishes a %s as one fact — no audit, nothing stored',
    async (kind) => {
      const sent = await react(student, kind);
      if (!sent.ok) throw new Error(sent.error.code);
      expect(sent.value).toEqual({ reactionId: expect.any(String) as string, kind });
      expect(h.journal.order).toEqual(['event:live.reaction.sent']);
      expect(h.journal.events[0]).toMatchObject({
        name: 'live.reaction.sent',
        aggregateId: session.id,
        payload: {
          sessionId: session.id,
          communityId,
          reactionId: sent.value.reactionId,
          kind,
          sentBy: 'student-1',
        },
      });
      expect(h.journal.entries).toEqual([]);
    },
  );

  it('lets a moderator — the host — react too', async () => {
    expect((await react(owner, 'clap')).ok).toBe(true);
  });

  it('gives every reaction its own id: a retry is another reaction, not a duplicate', async () => {
    const first = await react(student, 'heart');
    const second = await react(student, 'heart');
    expect(first.ok && second.ok && first.value.reactionId !== second.value.reactionId).toBe(true);
    expect(h.journal.order).toEqual(['event:live.reaction.sent', 'event:live.reaction.sent']);
  });

  it('refuses anything but the four kinds with 422, publishing nothing', async () => {
    for (const kind of ['', 'fire', 'HEART', 42, null, '❤️']) {
      expect(codeOf(await react(student, kind))).toBe('live.reaction_invalid');
    }
    expect(h.journal.order).toEqual([]);
  });

  it('refuses a non-member exactly as an unknown session — another community’s session included', async () => {
    const outsider = h.person('student-9', ['STUDENT']);
    expect(await react(outsider, 'heart')).toEqual(
      await react(outsider, 'heart', '00000000-0000-4000-8000-00000000ffff'),
    );
    expect(codeOf(await react(outsider, 'heart'))).toBe('live.session_not_found');
    // A member of ANOTHER community's running session reaches nothing here.
    const other = await h.community('teacher-2', 'student-9');
    await h.startSession(other.owner, other.id);
    expect(codeOf(await react(outsider, 'heart'))).toBe('live.session_not_found');
    expect(h.journal.order.filter((entry) => entry === 'event:live.reaction.sent')).toEqual([]);
  });

  it('refuses a member removed from the community at once', async () => {
    await h.remove(communityId, owner, student.userId);
    expect(codeOf(await react(student, 'smile'))).toBe('live.session_not_found');
  });

  it('refuses after the session ended with 412, and a malformed id before any read', async () => {
    const lookup = jest.spyOn(h.sessions, 'findById');
    expect(codeOf(await react(student, 'heart', 'not a session'))).toBe('live.session_not_found');
    expect(lookup).not.toHaveBeenCalled();
    await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
    h.journal.clear();
    expect(codeOf(await react(student, 'heart'))).toBe('live.session_not_live');
    expect(h.journal.order).toEqual([]);
  });

  it('answers a member the lifecycle refuses with 412 live.community_not_open', async () => {
    withUnmappedStatus(h);
    expect(codeOf(await react(student, 'heart'))).toBe('live.community_not_open');
  });

  it('refuses a role without live.join before anything is read', async () => {
    const lookup = jest.spyOn(h.sessions, 'findById');
    const narrowed: Principal = { ...student, permissions: new Set<string>() };
    expect(codeOf(await react(narrowed, 'heart'))).toBe('identity.permission_denied');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('limits reactions to thirty a minute per (session, person)', async () => {
    for (let i = 0; i < 30; i += 1) expect((await react(student, 'heart')).ok).toBe(true);
    expect(await react(student, 'heart')).toMatchObject({
      ok: false,
      error: { kind: 'rate_limited', code: 'live.too_many_reactions' },
    });
    expect((await react(h.person('student-2', ['STUDENT']), 'heart')).ok).toBe(true);
    h.clock.advance(60);
    expect((await react(student, 'heart')).ok).toBe(true);
  });
});
