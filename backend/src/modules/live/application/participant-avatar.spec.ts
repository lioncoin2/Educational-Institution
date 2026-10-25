import type { Principal } from '../../../shared';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import type { LiveSessionView } from './views';

/**
 * A participant's picture in the live room (C15, ADR 0048): identity's
 * reference, verified and linked by Files — for exactly the people the room
 * already names to the caller, never a way to enumerate a community.
 */
describe('a live participant’s picture', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let other: Principal;
  let session: LiveSessionView;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2');
    ({ id: communityId, owner } = world);
    [student, other] = world.students as [Principal, Principal];
    session = await h.startSession(owner, communityId);
    for (const userId of ['teacher-1', 'student-1', 'student-2']) {
      h.accounts.setAvatar(userId, `asset-${userId}`);
      h.fileAssets.own(`asset-${userId}`, userId);
    }
  });

  const avatar = (principal: Principal, userId: string, sessionId = session.id) =>
    h.participantAvatar.execute({ principal, sessionId, userId });

  it('gives every viewer the host’s picture — the teacher on the stage', async () => {
    const link = await avatar(student, 'teacher-1');
    expect(link).toMatchObject({
      ok: true,
      value: {
        url: 'https://files.test/asset-teacher-1?sig=1',
        expiresAt: expect.any(Date) as Date,
      },
    });
    expect(link.ok && link.value.expiresAt.getTime() - h.clock.now().getTime()).toBe(300_000);
  });

  it('gives a caller their own picture', async () => {
    expect((await avatar(student, 'student-1')).ok).toBe(true);
  });

  it('gives a listener no other listener’s picture — the named roster is moderators’ (Q68)', async () => {
    expect(codeOf(await avatar(student, 'student-2'))).toBe('live.participant_avatar_not_found');
    expect(h.fileAssets.linksMinted).toBe(0);
  });

  it('gives a listener a presenter’s picture: the session names its presenters to everyone', async () => {
    const granted = await h.presenter.grant({
      principal: owner,
      sessionId: session.id,
      targetUserId: 'student-2',
      meta: META,
    });
    expect(granted.ok).toBe(true);
    expect((await avatar(student, 'student-2')).ok).toBe(true);
  });

  it('gives a moderator any participant’s picture, and nobody’s outside the community', async () => {
    expect((await avatar(owner, 'student-2')).ok).toBe(true);
    const outsider = h.person('student-9', ['STUDENT']);
    h.accounts.setAvatar('student-9', 'asset-student-9');
    h.fileAssets.own('asset-student-9', 'student-9');
    expect(codeOf(await avatar(owner, 'student-9'))).toBe('live.participant_avatar_not_found');
    expect(outsider.userId).toBe('student-9');
  });

  it('answers no picture — initials — for someone who has none, or whose reference went stale', async () => {
    h.accounts.setAvatar('student-1', null);
    expect(codeOf(await avatar(owner, 'student-1'))).toBe('live.participant_avatar_not_found');
    // The reference names an asset the person no longer owns (replaced or gone).
    h.fileAssets.forget('asset-teacher-1');
    expect(codeOf(await avatar(student, 'teacher-1'))).toBe('live.participant_avatar_not_found');
    // Or one that is someone else's: never minted.
    h.accounts.setAvatar('student-2', 'asset-teacher-1');
    h.fileAssets.own('asset-teacher-1', 'teacher-1');
    expect(codeOf(await avatar(owner, 'student-2'))).toBe('live.participant_avatar_not_found');
    expect(h.fileAssets.linksMinted).toBe(0);
  });

  it('refuses a non-member exactly as an unknown session, before reading anyone', async () => {
    const outsider = h.person('teacher-9', ['TEACHER']);
    const describe = jest.spyOn(h.accounts, 'describe');
    expect(await avatar(outsider, 'teacher-1')).toEqual(
      await avatar(outsider, 'teacher-1', '00000000-0000-4000-8000-00000000ffff'),
    );
    expect(codeOf(await avatar(outsider, 'teacher-1'))).toBe('live.session_not_found');
    expect(describe).not.toHaveBeenCalled();
  });

  it('refuses a malformed id before any store call, and a caller without files.read', async () => {
    const lookup = jest.spyOn(h.sessions, 'findById');
    expect(codeOf(await avatar(student, 'teacher-1', 'not a session'))).toBe(
      'live.session_not_found',
    );
    expect(codeOf(await avatar(student, 'no#such'))).toBe('live.participant_avatar_not_found');
    expect(lookup).not.toHaveBeenCalled();
    const narrowed: Principal = { ...student, permissions: new Set(['live.join']) };
    expect(codeOf(await avatar(narrowed, 'teacher-1'))).toBe('identity.permission_denied');
  });

  it('keeps an ended session’s people as visible as the session', async () => {
    await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
    expect((await avatar(student, 'teacher-1')).ok).toBe(true);
    expect(codeOf(await avatar(other, 'student-1'))).toBe('live.participant_avatar_not_found');
  });
});
