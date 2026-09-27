import type { Principal } from '../../../shared';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../identity/domain/provisional-policy';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { capabilitiesFor } from '../domain/standing';
import type { LiveSessionView } from './views';

const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
});

/**
 * The presenter slot (live.md §6, S4; Q56): one screen at a time, a session
 * moderator holding `live.speak`, for themself; a stop by the presenter needs
 * no permit, a stop by anyone else is a moderator's revocation — never of the
 * host's own grant by a delegate.
 */
describe('the presenter slot', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let moderator: Principal;
  let session: LiveSessionView;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    moderator = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    session = await h.startSession(owner, communityId);
    h.rtc.connect(h.room(session.id), 'teacher-1', LISTENER);
    h.rtc.connect(h.room(session.id), 'teacher-2', LISTENER);
    h.journal.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  const claim = (principal: Principal, sessionId = session.id) =>
    h.presenter.claim({ principal, sessionId, meta: META });
  const stop = (principal: Principal, sessionId = session.id) =>
    h.presenter.stop({ principal, sessionId, meta: META });

  it('opens the slot for a moderator holding live.speak: the screen pushed, audited, announced, 201', async () => {
    const claimed = await claim(moderator);
    if (!claimed.ok) throw new Error(claimed.error.code);
    expect(claimed.value.opened).toBe(true);
    expect(claimed.value.session).toMatchObject({
      presenterUserId: 'teacher-2',
      stateVersion: 2,
      me: { presenting: true, canPresent: true },
    });
    // The full set: the microphone by right stays, the screen is added, never its audio.
    expect(h.rtc.capabilityChanges).toEqual([
      {
        roomName: h.room(session.id),
        identity: 'teacher-2',
        capabilities: { ...LISTENER, canPublishAudio: true, canPublishScreen: true },
      },
    ]);
    expect(h.journal.order).toEqual([
      'audit:live.screen_share.started',
      'event:live.screen_share.started',
    ]);
    const [grant] = h.store.presenterGrantsOf(session.id);
    expect(h.journal.entries[0]).toMatchObject({
      actorUserId: 'teacher-2',
      metadata: {
        communityId,
        targetUserId: 'teacher-2',
        presenterGrantId: grant?.id,
        media: 'applied',
        permit: { act: 'community.live.moderate', basis: 'grant' },
      },
      correlationId: META.correlationId,
    });
    expect(h.journal.events[0]?.payload).toEqual({
      sessionId: session.id,
      communityId,
      userId: 'teacher-2',
      grantedBy: 'teacher-2',
      stateVersion: 2,
    });
  });

  it('answers a claim by the holder with 200 and nothing more, and a rival’s with 409', async () => {
    await claim(moderator);
    h.journal.clear();
    const again = await claim(moderator);
    expect(again.ok && again.value.opened).toBe(false);
    expect(h.journal.order).toEqual([]);

    expect(codeOf(await claim(owner))).toBe('live.presenter_slot_taken');
    // The owner sees the slot taken.
    const view = await h.get.execute({ principal: owner, sessionId: session.id });
    expect(view.ok && view.value.me).toMatchObject({ canPresent: false, presenting: false });
  });

  it('refuses a moderator without live.speak with 403 live.presenter_not_permitted', async () => {
    const withoutSpeak = PROVISIONAL_ROLE_PERMISSIONS.TEACHER.filter(
      (permission) => permission !== 'live.speak',
    );
    const silent: Principal = { ...moderator, permissions: new Set<string>(withoutSpeak) };
    expect(codeOf(await claim(silent))).toBe('live.presenter_not_permitted');
    expect(await h.presenters.active(session.id)).toBeNull();
  });

  it('refuses a member who does not moderate with 403, a non-member as an unknown session, and after the end with 412', async () => {
    const member = await h.member(communityId, owner, 'teacher-3', ['TEACHER']);
    expect(codeOf(await claim(member))).toBe('live.not_a_moderator');
    const outsider = h.person('teacher-9', ['TEACHER']);
    expect(await claim(outsider)).toEqual(
      await claim(outsider, '00000000-0000-4000-8000-00000000ffff'),
    );
    expect(codeOf(await claim(outsider))).toBe('live.session_not_found');
    expect(codeOf(await claim(student))).toBe('identity.permission_denied');

    await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
    expect(codeOf(await claim(owner))).toBe('live.session_not_live');
  });

  it('lets the presenter stop with no permit: the screen off, announced, not audited', async () => {
    await claim(moderator);
    h.journal.clear();
    const stopped = await stop(moderator);
    expect(stopped.ok && stopped.value).toMatchObject({
      presenterUserId: null,
      stateVersion: 3,
      me: { presenting: false },
    });
    expect(h.rtc.capabilityChanges.at(-1)?.capabilities).toEqual({
      ...LISTENER,
      canPublishAudio: true,
    });
    expect(h.journal.order).toEqual(['event:live.screen_share.stopped']);
    expect(h.journal.events[0]?.payload).toMatchObject({
      userId: 'teacher-2',
      stoppedBy: 'teacher-2',
      reason: 'stopped',
      stateVersion: 3,
    });
    expect(h.store.presenterGrantsOf(session.id)[0]).toMatchObject({ endReason: 'stopped' });
  });

  it('lets a presenter removed from the community still stop their own share', async () => {
    await claim(moderator);
    await h.remove(communityId, owner, 'teacher-2');
    const stopped = await stop(moderator);
    expect(stopped.ok && stopped.value).toMatchObject({
      presenterUserId: null,
      me: { canJoin: false, canModerate: false, presenting: false },
    });
  });

  it('lets another moderator revoke the slot: its moderation row, audited, announced', async () => {
    await claim(moderator);
    h.journal.clear();
    const revoked = await stop(owner);
    expect(revoked.ok && revoked.value.presenterUserId).toBeNull();
    expect(h.journal.order).toEqual([
      'audit:live.screen_share.revoked',
      'event:live.screen_share.stopped',
    ]);
    expect(h.journal.entries[0]).toMatchObject({
      actorUserId: 'teacher-1',
      metadata: {
        targetUserId: 'teacher-2',
        media: 'applied',
        permit: { act: 'community.live.moderate', basis: 'owner' },
      },
    });
    expect(h.journal.events[0]?.payload).toMatchObject({
      userId: 'teacher-2',
      stoppedBy: 'teacher-1',
      reason: 'revoked',
    });
    expect(h.store.moderationOf(session.id).map((action) => action.type)).toEqual([
      'start_session',
      'grant_presenter',
      'revoke_presenter',
    ]);
    expect(h.rtc.capabilityChanges.at(-1)).toMatchObject({
      identity: 'teacher-2',
      capabilities: { canPublishScreen: false },
    });
  });

  it('never lets a delegate revoke the host’s own share (Q54), and answers a stop with nothing open with 200', async () => {
    await claim(owner);
    h.journal.clear();
    expect(codeOf(await stop(moderator))).toBe('live.target_is_host');
    expect((await h.presenters.active(session.id))?.userId).toBe('teacher-1');
    expect(h.journal.order).toEqual([]);

    await stop(owner);
    h.journal.clear();
    expect((await stop(moderator)).ok).toBe(true);
    expect((await stop(owner)).ok).toBe(true);
    expect(h.journal.order).toEqual([]);
  });

  it('refuses a stop by anyone else who does not moderate', async () => {
    await claim(moderator);
    const member = await h.member(communityId, owner, 'teacher-3', ['TEACHER']);
    expect(codeOf(await stop(member))).toBe('live.not_a_moderator');
    // No ceiling to moderate anywhere reads like no standing at all: the
    // route's not-found (LiveAccess, plan §3 commit B).
    expect(codeOf(await stop(student))).toBe('live.session_not_found');
    const outsider = h.person('teacher-9', ['TEACHER']);
    expect(codeOf(await stop(outsider))).toBe('live.session_not_found');
    expect((await h.presenters.active(session.id))?.userId).toBe('teacher-2');
  });
});
