import type { Principal } from '../../../shared';
import { META, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import type { CommunityAct } from '../../communities/contracts/capabilities';
import { MAX_AUDIENCE_PROBE } from '../contracts/live-audience';
import { LiveAudienceService } from './live-audience.service';

/** What a moderator's roles give, less `live.join`: they may moderate, never join as a member. */
const MODERATION_ONLY = ['communities.read', 'communities.moderate', 'live.moderate'] as const;

const UNKNOWN_SESSION = '00000000-0000-4000-8000-00000000dead';

/**
 * LIVE_AUDIENCE (live.md §13) against the REAL Communities: who may take part
 * is `permittedAmong`'s answer for `community.live.join`, plus the session's
 * moderators among them; the moderators are COMMUNITY_CAPABILITY_HOLDERS'
 * `community.live.moderate` holders plus the host while
 * `community.live.host` holds. Live copies no rule, and pages every id
 * exactly once.
 */
describe('LiveAudienceService', () => {
  let h: LiveHarness;
  let audience: LiveAudienceService;
  let communityId: string;
  let owner: Principal;
  /** Started by teacher-2, who holds `community.live.start` — and so hosts — but not moderate. */
  let sessionId: string;

  beforeEach(async () => {
    h = liveHarness();
    audience = new LiveAudienceService(h.sessions, h.authorization, h.communities.holders);
    ({ id: communityId, owner } = await h.community('teacher-1', 'student-1', 'student-2'));
    const starter = await h.delegate(communityId, owner, 'teacher-2', 'community.live.start');
    await h.delegate(communityId, owner, 'teacher-3', 'community.live.moderate');
    h.person('stranger', ['STUDENT']);
    sessionId = (await h.startSession(starter, communityId)).id;
  });

  afterEach(() => jest.restoreAllMocks());

  /** Takes `community.live.start` back from teacher-2: the host no longer hosts (Q54). */
  async function revokeHosting(): Promise<void> {
    const [grantId] = await h.grantsOf(communityId, owner, 'teacher-2', 'community.live.start');
    const revoked = await h.communities.revokeGrant.execute({
      principal: owner,
      communityId,
      grantId,
      meta: META,
    });
    if (!revoked.ok) throw new Error(revoked.error.code);
  }

  /** Every page of `moderators`, each checked against the limit; the ids in the order paged. */
  async function walk(id: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 1000; pages += 1) {
      const page = await audience.moderators(id, { cursor, limit });
      expect(page.userIds.length).toBeLessThanOrEqual(limit);
      ids.push(...page.userIds);
      cursor = page.nextCursor;
      if (cursor === null) return ids;
    }
    throw new Error('the walk never ended');
  }

  /** Communities' own answer for one act, asked directly. */
  const permitted = (act: CommunityAct, ids: readonly string[]) =>
    h.authorization.permittedAmong(communityId, ids, act);

  describe('participantsAmong', () => {
    const everyone = ['stranger', 'student-2', 'teacher-3', 'student-1', 'teacher-1', 'teacher-2'];

    it('answers who Communities permits to join, deduplicated, in the order given', async () => {
      expect(
        await audience.participantsAmong(sessionId, [
          'stranger',
          'student-1',
          'teacher-3',
          'student-1',
          'student-2',
        ]),
      ).toEqual(['student-1', 'teacher-3', 'student-2']);
      // Exactly `permittedAmong`'s answer: never a copy of the rule.
      expect(await audience.participantsAmong(sessionId, everyone)).toEqual(
        await permitted('community.live.join', everyone),
      );
    });

    it('drops a member Communities no longer lets join — a ceiling identity took away', async () => {
      h.accounts.setPermissions('student-2', ['communities.read']);
      expect(await audience.participantsAmong(sessionId, ['student-1', 'student-2'])).toEqual([
        'student-1',
      ]);
    });

    it('adds the moderators among them, who need no join permit', async () => {
      h.accounts.setPermissions('teacher-3', [...MODERATION_ONLY]);
      expect(await permitted('community.live.join', ['teacher-3'])).toEqual([]);

      expect(await audience.participantsAmong(sessionId, ['student-1', 'teacher-3'])).toEqual([
        'student-1',
        'teacher-3',
      ]);
    });

    it('adds the host while `community.live.host` holds, and not after', async () => {
      h.accounts.setPermissions('teacher-2', [...MODERATION_ONLY]);
      expect(await permitted('community.live.join', ['teacher-2'])).toEqual([]);
      expect(await permitted('community.live.moderate', ['teacher-2'])).toEqual([]);

      expect(await audience.participantsAmong(sessionId, ['teacher-2', 'student-1'])).toEqual([
        'teacher-2',
        'student-1',
      ]);

      await revokeHosting();
      expect(await audience.participantsAmong(sessionId, ['teacher-2', 'student-1'])).toEqual([
        'student-1',
      ]);
    });

    it('follows Communities through a lock, whatever it answers — Live keeps no lifecycle rule', async () => {
      await h.lock(communityId, owner);
      const joining = await permitted('community.live.join', everyone);
      const moderating = new Set(await permitted('community.live.moderate', everyone));
      const hosting = new Set(await permitted('community.live.host', ['teacher-2']));

      expect(await audience.participantsAmong(sessionId, everyone)).toEqual(
        everyone.filter(
          (userId) => joining.includes(userId) || moderating.has(userId) || hosting.has(userId),
        ),
      );
    });

    it('ignores the session’s state: an ended session’s audience is still Communities’ answer', async () => {
      await h.lifecycle.endBySystem(sessionId, 'idle');
      expect(await audience.participantsAmong(sessionId, ['student-1', 'stranger'])).toEqual([
        'student-1',
      ]);
    });

    it('answers [] for an unknown session, and for no ids — asking Communities nothing', async () => {
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');
      expect(await audience.participantsAmong(UNKNOWN_SESSION, ['student-1'])).toEqual([]);
      expect(await audience.participantsAmong(sessionId, [])).toEqual([]);
      expect(permittedAmong).not.toHaveBeenCalled();
    });

    it(`asks about ${MAX_AUDIENCE_PROBE} ids with one probe per act, and refuses ${MAX_AUDIENCE_PROBE + 1}`, async () => {
      h.accounts.setPermissions('teacher-2', [...MODERATION_ONLY]);
      const crowd = [
        'teacher-2',
        'student-1',
        ...Array.from({ length: MAX_AUDIENCE_PROBE - 2 }, (_, n) => `nobody-${n}`),
      ];
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');

      expect(await audience.participantsAmong(sessionId, crowd)).toEqual([
        'teacher-2',
        'student-1',
      ]);
      expect(permittedAmong.mock.calls.map(([, ids, act]) => [act, ids.length])).toEqual([
        ['community.live.join', MAX_AUDIENCE_PROBE],
        // Only those join refused can still be moderators…
        ['community.live.moderate', MAX_AUDIENCE_PROBE - 1],
        // …and only the host can host.
        ['community.live.host', 1],
      ]);

      permittedAmong.mockClear();
      await expect(
        audience.participantsAmong(sessionId, [...crowd, 'one-too-many']),
      ).rejects.toBeInstanceOf(RangeError);
      expect(permittedAmong).not.toHaveBeenCalled();
    });

    it('rejects when Communities cannot answer, whichever act fails — never a partial answer', async () => {
      h.accounts.setPermissions('teacher-3', [...MODERATION_ONLY]);
      const permittedAmong = jest.spyOn(h.authorization, 'permittedAmong');

      permittedAmong.mockRejectedValueOnce(new Error('store down'));
      await expect(
        audience.participantsAmong(sessionId, ['student-1', 'teacher-3']),
      ).rejects.toThrow('store down');

      // Joining answered; the moderators among the rest could not be told.
      permittedAmong
        .mockResolvedValueOnce(['student-1'])
        .mockRejectedValueOnce(new Error('directory down'));
      await expect(
        audience.participantsAmong(sessionId, ['student-1', 'teacher-3']),
      ).rejects.toThrow('directory down');
    });
  });

  describe('moderators', () => {
    it('lists the `community.live.moderate` holders, then the host while `community.live.host` holds', async () => {
      // The owner holds every capability; teacher-3 by grant; teacher-2 hosts.
      expect(await walk(sessionId, MAX_AUDIENCE_PROBE)).toEqual([
        'teacher-1',
        'teacher-3',
        'teacher-2',
      ]);
      expect(await audience.moderators(sessionId, { limit: 3 })).toEqual({
        userIds: ['teacher-1', 'teacher-3', 'teacher-2'],
        nextCursor: null,
      });
    });

    it('drops the host once `community.live.host` no longer holds', async () => {
      await revokeHosting();
      expect(await walk(sessionId, MAX_AUDIENCE_PROBE)).toEqual(['teacher-1', 'teacher-3']);
    });

    it('drops a holder Communities no longer lists — a ceiling identity took away', async () => {
      h.accounts.setPermissions('teacher-3', ['communities.read', 'live.join']);
      expect(await walk(sessionId, MAX_AUDIENCE_PROBE)).toEqual(['teacher-1', 'teacher-2']);
    });

    it('pages every id exactly once, never above the limit — the host last when not a holder', async () => {
      for (const limit of [1, 2, 3, 4]) {
        expect(await walk(sessionId, limit)).toEqual(['teacher-1', 'teacher-3', 'teacher-2']);
      }
    });

    it('pages every id exactly once when the host is also a holder, however the pages fall', async () => {
      // The owner starts a session in a second community: the host holds
      // `community.live.moderate` implicitly, and sorts after 24 delegates.
      const other = await h.community('teacher-9');
      const delegates = Array.from({ length: 24 }, (_, n) => `mod-${String(n).padStart(2, '0')}`);
      for (const userId of delegates) {
        await h.delegate(other.id, other.owner, userId, 'community.live.moderate');
      }
      const hosted = await h.startSession(other.owner, other.id);
      const expected = [...delegates, 'teacher-9'];

      for (const limit of [1, 2, 5, 7, 24, 25, 26, MAX_AUDIENCE_PROBE]) {
        const ids = await walk(hosted.id, limit);
        expect(ids).toEqual(expected);
        expect(new Set(ids).size).toBe(ids.length);
      }
    });

    it('pages every id exactly once when the host is a holder listed on the FIRST page', async () => {
      // Here the host sorts before every delegate: that they were seen must
      // travel in the cursor to the last page.
      const other = await h.community('teacher-8');
      const delegates = Array.from({ length: 6 }, (_, n) => `zz-${n}`);
      for (const userId of delegates) {
        await h.delegate(other.id, other.owner, userId, 'community.live.moderate');
      }
      const hosted = await h.startSession(other.owner, other.id);
      const expected = ['teacher-8', ...delegates];

      for (const limit of [1, 2, 3, 4, 5, 6, 7, MAX_AUDIENCE_PROBE]) {
        expect(await walk(hosted.id, limit)).toEqual(expected);
      }
    });

    it('answers nothing for an unknown or ended session — and ends a walk the session ended during', async () => {
      expect(await audience.moderators(UNKNOWN_SESSION, { limit: 10 })).toEqual({
        userIds: [],
        nextCursor: null,
      });

      const first = await audience.moderators(sessionId, { limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      await h.lifecycle.endBySystem(sessionId, 'idle');
      expect(await audience.moderators(sessionId, { cursor: first.nextCursor, limit: 1 })).toEqual({
        userIds: [],
        nextCursor: null,
      });
      expect(await audience.moderators(sessionId, { limit: 10 })).toEqual({
        userIds: [],
        nextCursor: null,
      });
    });

    it('takes a limit of 1 to 1,000 and nothing else', async () => {
      for (const limit of [0, -1, 1.5, MAX_AUDIENCE_PROBE + 1, Number.NaN]) {
        await expect(audience.moderators(sessionId, { limit })).rejects.toBeInstanceOf(RangeError);
      }
      await expect(audience.moderators(sessionId, { limit: 1 })).resolves.toMatchObject({
        userIds: ['teacher-1'],
      });
    });

    it('refuses a cursor it did not issue for this session — and never repeats it', async () => {
      const other = await h.community('teacher-9');
      await h.delegate(other.id, other.owner, 'mod-00', 'community.live.moderate');
      const otherSession = await h.startSession(other.owner, other.id);
      const foreign = (await audience.moderators(otherSession.id, { limit: 1 })).nextCursor;
      expect(foreign).not.toBeNull();
      const holders = (
        await h.communities.holders.list(communityId, 'community.live.moderate', { limit: 1 })
      ).nextCursor;
      const ours = (await audience.moderators(sessionId, { limit: 1 })).nextCursor ?? '';
      const tampered = Buffer.from(
        JSON.stringify(['la1', sessionId, 'holders', 'not-a-holder-cursor', false]),
      ).toString('base64url');

      for (const cursor of [
        foreign,
        holders,
        'garbage<script>',
        Buffer.from('["la1"]').toString('base64url'),
        Buffer.from(JSON.stringify(['la1', sessionId, 'holders', null, false])).toString(
          'base64url',
        ),
        tampered,
        ours.slice(1),
      ]) {
        const refused = audience.moderators(sessionId, { cursor, limit: 1 });
        await expect(refused).rejects.toBeInstanceOf(RangeError);
        const message = await refused.catch((error: Error) => error.message);
        expect(message).toBe('That cursor was not issued by LIVE_AUDIENCE for this session.');
      }
    });

    it('rejects when Communities cannot answer — never an empty page for "could not tell"', async () => {
      jest.spyOn(h.communities.holders, 'list').mockRejectedValueOnce(new Error('store down'));
      await expect(audience.moderators(sessionId, { limit: 10 })).rejects.toThrow('store down');

      jest.spyOn(h.authorization, 'permittedAmong').mockRejectedValueOnce(new Error('store down'));
      await expect(audience.moderators(sessionId, { limit: 10 })).rejects.toThrow('store down');
    });
  });
});
