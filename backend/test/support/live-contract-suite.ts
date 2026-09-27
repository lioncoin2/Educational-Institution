import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { MAX_CONCURRENT_SPEAKERS } from '../../src/modules/live/domain/live-limits';
import {
  liveSessionOrder,
  newLiveSession,
  type LiveSession,
  type LiveSessionEndReason,
} from '../../src/modules/live/domain/live-session';
import type {
  ModerationAction,
  ModerationActionType,
} from '../../src/modules/live/domain/moderation';
import type {
  LiveSessionRepository,
  PresenterGrantRepository,
  SpeakerRequestRepository,
} from '../../src/modules/live/domain/ports';
import {
  newPresenterGrant,
  type PresenterGrant,
  type PresenterStopReason,
} from '../../src/modules/live/domain/presenter-grant';
import {
  newSpeakerRequest,
  queueOrder,
  type SpeakerRequest,
  type SpeakerRequestState,
} from '../../src/modules/live/domain/speaker-request';

/**
 * One adapter's three ports, over one store — and the two things no port
 * reads back, read the adapter's own way (from the in-memory store; with a
 * SELECT in Postgres): a session's moderation rows and its presenter grants,
 * closed ones included, oldest first.
 */
export interface LiveStores {
  readonly sessions: LiveSessionRepository;
  readonly requests: SpeakerRequestRepository;
  readonly presenters: PresenterGrantRepository;
  moderationOf(sessionId: string): Promise<readonly ModerationAction[]>;
  presenterGrantsOf(sessionId: string): Promise<readonly PresenterGrant[]>;
}

/**
 * What Live's repository ports promise, as one suite: run against the
 * in-memory store and against Postgres (commit C), so mock mode keeps every
 * guarantee the database gives — the same outcome for the same sequence of
 * calls, races included (live.md §10; plan §2.4).
 *
 * It is written against the ports only. Every record is created through
 * them, with fresh uuids, so it needs no empty database: a test never
 * depends on what another left behind.
 */
export function liveRepositoryContract(
  name: string,
  stores: () => Promise<LiveStores> | LiveStores,
): void {
  describe(`live repositories — ${name}`, () => {
    let s: LiveStores;

    beforeEach(async () => {
      s = await stores();
    });

    const ids = new UuidIdGenerator();
    const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);
    const at = (seconds: number) => new Date(T0 + seconds * 1000);
    const person = () => `user-${ids.next()}`;
    const community = () => `community-${ids.next()}`;

    const action = (
      sessionId: string,
      type: ModerationActionType,
      actorUserId: string | null,
      targetUserId: string | null,
      when: Date,
    ): ModerationAction => ({
      id: ids.next<'ModerationAction'>(),
      sessionId,
      actorUserId,
      targetUserId,
      type,
      at: when,
    });

    const newSession = (communityId = community(), when = at(0)): LiveSession =>
      newLiveSession({
        id: ids.next<'LiveSession'>(),
        communityId,
        hostUserId: person(),
        at: when,
        participantCap: 300,
        moderatorReserve: 10,
      });

    const start = (session: LiveSession) =>
      s.sessions.start(
        session,
        action(session.id, 'start_session', session.hostUserId, null, session.startedAt),
      );

    /** A live session, started through the port. */
    async function started(communityId = community(), when = at(0)): Promise<LiveSession> {
      const session = newSession(communityId, when);
      expect(await start(session)).toEqual({ created: true, session });
      return session;
    }

    const end = (
      session: LiveSession,
      when: Date,
      endedBy: string | null = session.hostUserId,
      reason: LiveSessionEndReason = 'moderator',
    ) =>
      s.sessions.end({
        sessionId: session.id,
        at: when,
        endedBy,
        reason,
        moderation: action(session.id, 'end_session', endedBy, null, when),
      });

    const raise = (session: LiveSession, userId: string, when: Date) =>
      s.requests.raise(
        newSpeakerRequest({
          id: ids.next<'SpeakerRequest'>(),
          sessionId: session.id,
          userId,
          at: when,
        }),
      );

    /** A new pending request, raised through the port. */
    async function raised(session: LiveSession, userId: string, when: Date) {
      const outcome = await raise(session, userId, when);
      if (outcome === 'session_not_live' || !outcome.created) {
        throw new Error('expected a new request');
      }
      return outcome.request;
    }

    const grant = (request: SpeakerRequest, by: string, when: Date) =>
      s.requests.grantWithinCap({
        requestId: request.id,
        cap: MAX_CONCURRENT_SPEAKERS,
        at: when,
        by,
        moderation: action(request.sessionId, 'grant_speaker', by, request.userId, when),
      });

    /** A moderator's compare-and-set (decline, revoke), with its moderation row. */
    const decide = (
      request: SpeakerRequest,
      from: readonly SpeakerRequestState[],
      to: 'declined' | 'revoked',
      by: string,
      when: Date,
    ) =>
      s.requests.transition({
        requestId: request.id,
        from,
        to,
        at: when,
        by,
        moderation: action(
          request.sessionId,
          to === 'declined' ? 'decline_speaker' : 'revoke_speaker',
          by,
          request.userId,
          when,
        ),
      });

    /** The requester lowering their own hand: a withdrawal, or a yield. No moderation row. */
    const lower = (request: SpeakerRequest, when: Date) =>
      s.requests.transition({
        requestId: request.id,
        from: ['pending', 'granted'],
        to: 'withdrawn',
        at: when,
        by: request.userId,
        moderation: null,
      });

    const claim = (session: LiveSession, userId: string, when: Date) =>
      s.presenters.open(
        newPresenterGrant({
          id: ids.next<'PresenterGrant'>(),
          sessionId: session.id,
          userId,
          at: when,
        }),
        action(session.id, 'grant_presenter', userId, userId, when),
      );

    const stop = (
      session: LiveSession,
      userId: string,
      by: string | null,
      reason: PresenterStopReason,
      when: Date,
    ) =>
      s.presenters.close({
        sessionId: session.id,
        userId,
        by,
        reason,
        at: when,
        moderation:
          reason === 'revoked' ? action(session.id, 'revoke_presenter', by, userId, when) : null,
      });

    const version = async (session: LiveSession) =>
      (await s.sessions.findById(session.id))?.stateVersion;
    const rows = async (session: LiveSession) =>
      (await s.moderationOf(session.id)).map((row) => row.type);
    const request = async (id: string) => s.requests.findById(id);

    describe('starting', () => {
      it('stores a live session at state version 1, with its start_session row', async () => {
        const session = newSession();
        const row = action(session.id, 'start_session', session.hostUserId, null, at(0));
        expect(await s.sessions.start(session, row)).toEqual({ created: true, session });
        expect(await s.sessions.findById(session.id)).toEqual(session);
        expect(await s.sessions.findLiveByCommunity(session.communityId)).toEqual(session);
        expect(await s.moderationOf(session.id)).toEqual([
          expect.objectContaining({
            id: row.id,
            sessionId: session.id,
            actorUserId: session.hostUserId,
            targetUserId: null,
            type: 'start_session',
            at: at(0),
          }),
        ]);
      });

      it('keeps one live session per community: another start returns it, writing nothing', async () => {
        const running = await started();
        const second = newSession(running.communityId, at(5));
        expect(await start(second)).toEqual({ created: false, session: running });
        expect(await s.sessions.findById(second.id)).toBeNull();
        expect(await s.moderationOf(second.id)).toEqual([]);
        expect(await rows(running)).toEqual(['start_session']);
      });

      it('answers twenty racing starts with one session', async () => {
        const communityId = community();
        const candidates = Array.from({ length: 20 }, () => newSession(communityId));
        const outcomes = await Promise.all(candidates.map(start));
        expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
        const winner = outcomes.find((outcome) => outcome.created)?.session;
        expect(new Set(outcomes.map((outcome) => outcome.session.id))).toEqual(
          new Set([winner?.id]),
        );
        expect(await s.sessions.findLiveByCommunity(communityId)).toEqual(winner);
        for (const loser of candidates.filter((candidate) => candidate.id !== winner?.id)) {
          expect(await s.sessions.findById(loser.id)).toBeNull();
        }
      });

      it('keeps communities apart, and starts again once the running session has ended', async () => {
        const first = await started();
        const elsewhere = await started();
        expect(await s.sessions.findLiveByCommunity(elsewhere.communityId)).toEqual(elsewhere);
        await end(first, at(60));
        expect(await s.sessions.findLiveByCommunity(first.communityId)).toBeNull();
        const next = await started(first.communityId, at(90));
        expect(await s.sessions.findLiveByCommunity(first.communityId)).toEqual(next);
      });
    });

    describe('ending', () => {
      it('ends in one step: every open hand expires, the presenter grant closes, one version, one row', async () => {
        const session = await started();
        const moderator = session.hostUserId;
        const waiting = await raised(session, person(), at(1));
        const speaking = await raised(session, person(), at(2));
        const declined = await raised(session, person(), at(3));
        const more = await Promise.all(
          Array.from({ length: 12 }, (_, n) => raised(session, person(), at(4 + n))),
        );
        await grant(speaking, moderator, at(20));
        await decide(declined, ['pending'], 'declined', moderator, at(21));
        await claim(session, moderator, at(22));
        const before = await version(session);

        const outcome = await end(session, at(60), moderator, 'moderator');
        expect(outcome).toEqual({
          ended: true,
          session: {
            ...session,
            state: 'ended',
            stateVersion: (before ?? 0) + 1,
            endedAt: at(60),
            endedBy: moderator,
            endReason: 'moderator',
          },
        });
        expect(await s.sessions.findById(session.id)).toEqual(outcome?.session);
        expect(await s.sessions.findLiveByCommunity(session.communityId)).toBeNull();

        for (const hand of [waiting, ...more]) {
          expect(await request(hand.id)).toEqual({
            ...hand,
            state: 'expired',
            decidedAt: at(60),
            decidedBy: null,
          });
        }
        expect(await request(speaking.id)).toMatchObject({
          state: 'expired',
          grantedAt: at(20),
          decidedAt: at(60),
          decidedBy: null,
        });
        // A terminal request stays as it was.
        expect(await request(declined.id)).toMatchObject({
          state: 'declined',
          decidedBy: moderator,
        });
        expect(await s.requests.findOpen(session.id, speaking.userId)).toBeNull();
        expect(await s.requests.granted(session.id)).toEqual([]);
        expect(await s.requests.pendingPage(session.id, null, 100)).toEqual([]);
        expect(await s.requests.countPending(session.id, 100)).toBe(0);

        expect(await s.presenters.active(session.id)).toBeNull();
        expect(await s.presenterGrantsOf(session.id)).toEqual([
          expect.objectContaining({
            userId: moderator,
            endedAt: at(60),
            endedBy: moderator,
            endReason: 'session_ended',
          }),
        ]);
        expect(await rows(session)).toEqual([
          'start_session',
          'grant_speaker',
          'decline_speaker',
          'grant_presenter',
          'end_session',
        ]);
      });

      it('answers a repeated end with the ended session, writing nothing', async () => {
        const session = await started();
        const first = await end(session, at(60));
        const again = await end(session, at(70), person(), 'moderator');
        expect(again).toEqual({ ended: false, session: first?.session });
        expect(await version(session)).toBe(first?.session.stateVersion);
        expect(await rows(session)).toEqual(['start_session', 'end_session']);
      });

      it('lets the system end a session with no actor, for idleness or a closed community', async () => {
        const idle = await started();
        const closed = await started();
        expect((await end(idle, at(900), null, 'idle'))?.session).toMatchObject({
          endedBy: null,
          endReason: 'idle',
        });
        expect((await end(closed, at(60), null, 'community_closed'))?.session).toMatchObject({
          endedBy: null,
          endReason: 'community_closed',
        });
        expect(await s.moderationOf(idle.id)).toEqual([
          expect.objectContaining({ type: 'start_session' }),
          expect.objectContaining({ type: 'end_session', actorUserId: null }),
        ]);
      });

      it('refuses a moderator’s end that names no moderator, changing nothing (S2)', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        await expect(end(session, at(60), null, 'moderator')).rejects.toThrow();
        expect(await s.sessions.findById(session.id)).toMatchObject({ state: 'live' });
        expect(await request(hand.id)).toMatchObject({ state: 'pending' });
        expect(await rows(session)).toEqual(['start_session']);
      });

      it('answers null for an unknown session', async () => {
        expect(await end(newSession(), at(60))).toBeNull();
      });
    });

    describe('paging the live sessions', () => {
      // Far from every other test's sessions, so what they leave behind stays out of the way.
      const far = (seconds: number) => at(30 * 24 * 60 * 60 + seconds);

      it('pages them by (startedAt, id), leaving ended sessions out', async () => {
        const tied = far(10);
        const sessions = [
          await started(community(), far(30)),
          await started(community(), tied),
          await started(community(), tied),
          await started(community(), far(20)),
          await started(community(), far(40)),
        ];
        const gone = sessions[3];
        await end(gone, far(50));
        const expected = sessions
          .filter((session) => session.id !== gone.id)
          .sort(liveSessionOrder)
          .map((session) => session.id);

        const seen: LiveSession[] = [];
        let after: { startedAt: Date; id: string } | null = { startedAt: far(0), id: '' };
        for (let pages = 0; ; pages += 1) {
          // A keyset that does not move on would page forever: fail instead.
          expect(pages).toBeLessThan(10);
          const page: readonly LiveSession[] = await s.sessions.listLive(after, 2);
          expect(page.length).toBeLessThanOrEqual(2);
          seen.push(...page);
          const last = page.at(-1);
          if (last === undefined) break;
          after = { startedAt: last.startedAt, id: last.id };
        }
        const mine = new Set(expected);
        expect(seen.filter((session) => mine.has(session.id)).map((session) => session.id)).toEqual(
          expected,
        );
        expect(seen.every((session) => session.state === 'live')).toBe(true);
        // A keyset: strictly increasing, so no session is seen twice.
        for (let n = 1; n < seen.length; n += 1) {
          expect(liveSessionOrder(seen[n - 1], seen[n])).toBeLessThan(0);
        }
      });

      it('starts from the beginning without a position, in order', async () => {
        await started();
        const page = await s.sessions.listLive(null, 100);
        expect(page.length).toBeGreaterThan(0);
        expect([...page].sort(liveSessionOrder)).toEqual(page);
        expect(page.every((session) => session.state === 'live')).toBe(true);
      });

      it('refuses a page size outside 1..100', async () => {
        for (const limit of [0, 101, 1.5]) {
          await expect(s.sessions.listLive(null, limit)).rejects.toThrow(RangeError);
        }
      });
    });

    describe('the reconciler’s bookkeeping', () => {
      it('marks a live session empty from its first observation, and clears it — no version step', async () => {
        const session = await started();
        await s.sessions.markEmpty(session.id, at(30));
        await s.sessions.markEmpty(session.id, at(60));
        expect(await s.sessions.findById(session.id)).toMatchObject({
          emptySince: at(30),
          stateVersion: 1,
        });
        await s.sessions.markEmpty(session.id, null);
        expect((await s.sessions.findById(session.id))?.emptySince).toBeNull();
        await s.sessions.markEmpty(session.id, at(90));
        expect((await s.sessions.findById(session.id))?.emptySince).toEqual(at(90));
        expect(await version(session)).toBe(1);
      });

      it('counts violations on a live session, and shows the last — no version step', async () => {
        const session = await started();
        expect(await s.sessions.noteViolation(session.id, at(10))).toBe(1);
        expect(await s.sessions.noteViolation(session.id, at(20))).toBe(2);
        expect(await s.sessions.findById(session.id)).toMatchObject({
          enforcementViolations: 2,
          lastViolationAt: at(20),
          stateVersion: 1,
        });
        expect(await s.sessions.noteViolation(newSession().id, at(30))).toBe(0);
      });

      it('moves the media room epoch by compare-and-set, with the reset_media row', async () => {
        const session = await started();
        const reset = (expected: number, when: Date) =>
          s.sessions.bumpEpoch(
            session.id,
            expected,
            action(session.id, 'reset_media', null, null, when),
          );
        expect(await reset(0, at(10))).toEqual({ ...session, mediaRoomEpoch: 1 });
        expect(await reset(0, at(11))).toBeNull();
        expect(await reset(2, at(12))).toBeNull();
        expect((await reset(1, at(13)))?.mediaRoomEpoch).toBe(2);
        expect(await s.sessions.findById(session.id)).toMatchObject({
          mediaRoomEpoch: 2,
          stateVersion: 1,
        });
        expect(await s.moderationOf(session.id)).toEqual([
          expect.objectContaining({ type: 'start_session' }),
          expect.objectContaining({ type: 'reset_media', actorUserId: null, at: at(10) }),
          expect.objectContaining({ type: 'reset_media', actorUserId: null, at: at(13) }),
        ]);
        expect(
          await s.sessions.bumpEpoch(
            newSession().id,
            0,
            action(session.id, 'reset_media', null, null, at(14)),
          ),
        ).toBeNull();
      });

      it('lets exactly one of two racing resets from the same epoch win', async () => {
        const session = await started();
        const outcomes = await Promise.all(
          [at(10), at(11)].map((when) =>
            s.sessions.bumpEpoch(
              session.id,
              0,
              action(session.id, 'reset_media', null, null, when),
            ),
          ),
        );
        expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
        expect((await s.sessions.findById(session.id))?.mediaRoomEpoch).toBe(1);
        expect((await rows(session)).filter((type) => type === 'reset_media')).toHaveLength(1);
      });
    });

    describe('raising a hand', () => {
      it('stores one pending request per person, one version later', async () => {
        const session = await started();
        const userId = person();
        const first = await raise(session, userId, at(1));
        expect(first).toMatchObject({ created: true, stateVersion: 2 });
        const created = first === 'session_not_live' ? null : first.request;
        expect(created).toMatchObject({ userId, state: 'pending', requestedAt: at(1) });

        const again = newSpeakerRequest({
          id: ids.next<'SpeakerRequest'>(),
          sessionId: session.id,
          userId,
          at: at(2),
        });
        expect(await s.requests.raise(again)).toEqual({
          created: false,
          request: created,
          stateVersion: 2,
        });
        expect(await s.requests.findById(again.id)).toBeNull();
        expect(await s.requests.findOpen(session.id, userId)).toEqual(created);
        expect(await version(session)).toBe(2);
        // A raise is the requester's own act: no moderation row.
        expect(await rows(session)).toEqual(['start_session']);
      });

      it('makes one request out of twenty racing raises by one person', async () => {
        const session = await started();
        const userId = person();
        const outcomes = await Promise.all(
          Array.from({ length: 20 }, (_, n) => raise(session, userId, at(1 + n))),
        );
        const results = outcomes.flatMap((outcome) =>
          outcome === 'session_not_live' ? [] : [outcome],
        );
        expect(results).toHaveLength(20);
        expect(results.filter((result) => result.created)).toHaveLength(1);
        expect(new Set(results.map((result) => result.request.id)).size).toBe(1);
        expect(await version(session)).toBe(2);
      });

      it('answers a speaker’s raise with the granted hand', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        await grant(hand, session.hostUserId, at(2));
        expect(await raise(session, hand.userId, at(3))).toMatchObject({
          created: false,
          request: { id: hand.id, state: 'granted' },
        });
      });

      it('takes a new request once the last one is closed', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        await lower(hand, at(2));
        const next = await raise(session, hand.userId, at(3));
        expect(next).toMatchObject({ created: true, request: { state: 'pending' } });
        expect(next === 'session_not_live' ? null : next.request.id).not.toBe(hand.id);
      });

      it('refuses a raise in an ended or unknown session', async () => {
        const session = await started();
        await end(session, at(60));
        expect(await raise(session, person(), at(61))).toBe('session_not_live');
        expect(await raise(newSession(), person(), at(61))).toBe('session_not_live');
      });
    });

    describe('reading hands', () => {
      it('pages pending hands first come, first served, by keyset — equal instants by id', async () => {
        const session = await started();
        const hands = [
          await raised(session, person(), at(5)),
          await raised(session, person(), at(1)),
          await raised(session, person(), at(3)),
          await raised(session, person(), at(3)),
          await raised(session, person(), at(3)),
          await raised(session, person(), at(9)),
          await raised(session, person(), at(2)),
        ];
        // A granted hand leaves the pending queue.
        const granted = hands[5];
        await grant(granted, session.hostUserId, at(10));
        const expected = hands
          .filter((hand) => hand.id !== granted.id)
          .sort(queueOrder)
          .map((hand) => hand.id);

        const pages: string[][] = [];
        let after: { requestedAt: Date; id: string } | null = null;
        while (pages.length < 10) {
          const page: readonly SpeakerRequest[] = await s.requests.pendingPage(
            session.id,
            after,
            4,
          );
          if (page.length === 0) break;
          pages.push(page.map((hand) => hand.id));
          const last = page.at(-1) as SpeakerRequest;
          after = { requestedAt: last.requestedAt, id: last.id };
        }
        expect(pages.map((page) => page.length)).toEqual([4, 2]);
        expect(pages.flat()).toEqual(expected);
        expect(await s.requests.granted(session.id)).toEqual([
          expect.objectContaining({ id: granted.id, state: 'granted' }),
        ]);
      });

      it('refuses a hands page outside 1..100', async () => {
        const session = await started();
        for (const limit of [0, 101, 2.5]) {
          await expect(s.requests.pendingPage(session.id, null, limit)).rejects.toThrow(RangeError);
        }
      });

      it('counts pending hands no further than the cap', async () => {
        const session = await started();
        for (let n = 0; n < 5; n += 1) await raised(session, person(), at(n));
        expect(await s.requests.countPending(session.id, 3)).toBe(3);
        expect(await s.requests.countPending(session.id, 100)).toBe(5);
        expect(await s.requests.countPending(newSession().id, 100)).toBe(0);
        for (const cap of [0, 101, 1.5]) {
          await expect(s.requests.countPending(session.id, cap)).rejects.toThrow(RangeError);
        }
      });

      it('lists the granted hands in queue order', async () => {
        const session = await started();
        const late = await raised(session, person(), at(9));
        const early = await raised(session, person(), at(1));
        await grant(late, session.hostUserId, at(10));
        await grant(early, session.hostUserId, at(11));
        expect((await s.requests.granted(session.id)).map((hand) => hand.id)).toEqual([
          early.id,
          late.id,
        ]);
      });
    });

    describe('granting within the cap', () => {
      it('grants exactly four, then answers slots_full without a version step', async () => {
        const session = await started();
        const moderator = session.hostUserId;
        const hands = await Promise.all(
          Array.from({ length: 6 }, (_, n) => raised(session, person(), at(n))),
        );
        const kinds: string[] = [];
        for (const hand of hands)
          kinds.push((await grant(hand, moderator, at(20)))?.kind ?? 'null');
        expect(kinds).toEqual([
          'granted',
          'granted',
          'granted',
          'granted',
          'slots_full',
          'slots_full',
        ]);
        expect(await s.requests.granted(session.id)).toHaveLength(MAX_CONCURRENT_SPEAKERS);
        expect(await request(hands[4].id)).toMatchObject({ state: 'pending' });
        expect(await version(session)).toBe(1 + 6 + 4);
        expect((await rows(session)).filter((type) => type === 'grant_speaker')).toHaveLength(4);

        // A slot freed is a slot to give.
        await decide(hands[0], ['granted'], 'revoked', moderator, at(30));
        expect((await grant(hands[4], moderator, at(31)))?.kind).toBe('granted');
      });

      it('grants exactly four of ten racing grants', async () => {
        const session = await started();
        const hands = await Promise.all(
          Array.from({ length: 10 }, (_, n) => raised(session, person(), at(n))),
        );
        const outcomes = await Promise.all(
          hands.map((hand) => grant(hand, session.hostUserId, at(20))),
        );
        const kinds = outcomes.map((outcome) => outcome?.kind);
        expect(kinds.filter((kind) => kind === 'granted')).toHaveLength(4);
        expect(kinds.filter((kind) => kind === 'slots_full')).toHaveLength(6);
        expect(await s.requests.granted(session.id)).toHaveLength(4);
        expect(await version(session)).toBe(1 + 10 + 4);
      });

      it('counts each session’s floor on its own', async () => {
        const full = await started();
        const other = await started();
        for (let n = 0; n < 4; n += 1) {
          await grant(await raised(full, person(), at(n)), full.hostUserId, at(10));
        }
        const hand = await raised(other, person(), at(1));
        expect((await grant(hand, other.hostUserId, at(11)))?.kind).toBe('granted');
      });

      it('records who gave the floor and when, one version later, with the grant_speaker row', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        const outcome = await grant(hand, session.hostUserId, at(7));
        expect(outcome).toEqual({
          kind: 'granted',
          request: {
            ...hand,
            state: 'granted',
            grantedAt: at(7),
            decidedAt: at(7),
            decidedBy: session.hostUserId,
          },
          stateVersion: 3,
        });
        expect(await request(hand.id)).toEqual(outcome?.request);
        expect((await s.moderationOf(session.id)).at(-1)).toMatchObject({
          type: 'grant_speaker',
          actorUserId: session.hostUserId,
          targetUserId: hand.userId,
          at: at(7),
        });
      });

      it('answers a repeat unchanged, a decided request invalid and an unknown one null — writing nothing', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        const passed = await raised(session, person(), at(2));
        await grant(hand, session.hostUserId, at(3));
        await decide(passed, ['pending'], 'declined', session.hostUserId, at(4));
        const before = await version(session);
        const rowsBefore = await rows(session);

        expect(await grant(hand, session.hostUserId, at(5))).toMatchObject({
          kind: 'unchanged',
          request: { state: 'granted', decidedAt: at(3) },
          stateVersion: before,
        });
        expect(await grant(passed, session.hostUserId, at(6))).toMatchObject({
          kind: 'invalid',
          request: { state: 'declined' },
          stateVersion: before,
        });
        const unknown = newSpeakerRequest({
          id: ids.next<'SpeakerRequest'>(),
          sessionId: session.id,
          userId: person(),
          at: at(7),
        });
        expect(await grant(unknown, session.hostUserId, at(7))).toBeNull();
        expect(await version(session)).toBe(before);
        expect(await rows(session)).toEqual(rowsBefore);
      });
    });

    describe('compare-and-set transitions', () => {
      it('applies a move from an expected state, one version later, with the row it is given', async () => {
        const session = await started();
        const moderator = session.hostUserId;
        const passed = await raised(session, person(), at(1));
        const withdrawing = await raised(session, person(), at(2));

        expect(await decide(passed, ['pending'], 'declined', moderator, at(5))).toEqual({
          kind: 'applied',
          request: { ...passed, state: 'declined', decidedAt: at(5), decidedBy: moderator },
          stateVersion: 4,
        });
        expect(await lower(withdrawing, at(6))).toEqual({
          kind: 'applied',
          request: {
            ...withdrawing,
            state: 'withdrawn',
            decidedAt: at(6),
            decidedBy: withdrawing.userId,
          },
          stateVersion: 5,
        });
        // The requester's own act writes no moderation row.
        expect(await rows(session)).toEqual(['start_session', 'decline_speaker']);
      });

      it('answers a repeat unchanged and writes nothing', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        await decide(hand, ['pending'], 'declined', session.hostUserId, at(2));
        expect(
          await decide(hand, ['pending'], 'declined', session.hostUserId, at(3)),
        ).toMatchObject({
          kind: 'unchanged',
          request: { state: 'declined', decidedAt: at(2) },
          stateVersion: 3,
        });
        expect(await version(session)).toBe(3);
        expect(await rows(session)).toEqual(['start_session', 'decline_speaker']);
      });

      it('answers a move from an unexpected state invalid, leaving the request as it was', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        expect(await decide(hand, ['granted'], 'revoked', session.hostUserId, at(2))).toMatchObject(
          {
            kind: 'invalid',
            request: { state: 'pending' },
            stateVersion: 2,
          },
        );
        await grant(hand, session.hostUserId, at(3));
        expect(
          await decide(hand, ['pending'], 'declined', session.hostUserId, at(4)),
        ).toMatchObject({
          kind: 'invalid',
          request: { state: 'granted' },
        });
        // The compare in compare-and-set: a move the table allows is still
        // refused from a state the caller did not name — withdrawing a pending
        // hand never yields a floor granted in the meantime.
        const withdrawPending = await s.requests.transition({
          requestId: hand.id,
          from: ['pending'],
          to: 'withdrawn',
          at: at(4),
          by: hand.userId,
          moderation: null,
        });
        expect(withdrawPending).toMatchObject({ kind: 'invalid', request: { state: 'granted' } });
        await decide(hand, ['granted'], 'revoked', session.hostUserId, at(5));
        // A closed hand cannot be lowered again: revoked is not withdrawn.
        expect(await lower(hand, at(6))).toMatchObject({
          kind: 'invalid',
          request: { state: 'revoked' },
        });
        expect(await version(session)).toBe(4);
      });

      it('lets one of a revoke and a yield racing on one floor win', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        await grant(hand, session.hostUserId, at(2));
        const outcomes = await Promise.all([
          lower(hand, at(3)),
          decide(hand, ['granted'], 'revoked', session.hostUserId, at(3)),
        ]);
        expect(outcomes.map((outcome) => outcome?.kind).sort()).toEqual(['applied', 'invalid']);
        expect(['withdrawn', 'revoked']).toContain((await request(hand.id))?.state);
        expect(await version(session)).toBe(4);
      });

      it('lets a lower racing a grant end with the hand down — as a yield if the grant came first', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        const [granted, lowered] = await Promise.all([
          grant(hand, session.hostUserId, at(2)),
          lower(hand, at(2)),
        ]);
        expect(lowered?.kind).toBe('applied');
        expect(['granted', 'invalid']).toContain(granted?.kind);
        const final = await request(hand.id);
        expect(final?.state).toBe('withdrawn');
        expect(final?.grantedAt === null).toBe(granted?.kind === 'invalid');
      });

      it('refuses a move to pending or granted, and an actor that does not fit the state (R3)', async () => {
        const session = await started();
        const hand = await raised(session, person(), at(1));
        const move = (to: SpeakerRequestState, by: string | null) =>
          s.requests.transition({
            requestId: hand.id,
            from: ['pending'],
            to,
            at: at(2),
            by,
            moderation: null,
          });
        await expect(move('granted', session.hostUserId)).rejects.toThrow(RangeError);
        await expect(move('pending', session.hostUserId)).rejects.toThrow(RangeError);
        await expect(move('expired', session.hostUserId)).rejects.toThrow(RangeError);
        await expect(move('withdrawn', null)).rejects.toThrow(RangeError);
        expect(await request(hand.id)).toEqual(hand);
      });

      it('answers null for an unknown request', async () => {
        const session = await started();
        const unknown = newSpeakerRequest({
          id: ids.next<'SpeakerRequest'>(),
          sessionId: session.id,
          userId: person(),
          at: at(1),
        });
        expect(await lower(unknown, at(2))).toBeNull();
      });
    });

    describe('the presenter slot', () => {
      it('opens the free slot one version later, with the grant_presenter row', async () => {
        const session = await started();
        const presenter = session.hostUserId;
        const outcome = await claim(session, presenter, at(5));
        expect(outcome).toMatchObject({
          kind: 'opened',
          grant: {
            sessionId: session.id,
            userId: presenter,
            grantedBy: presenter,
            grantedAt: at(5),
            endedAt: null,
            endReason: null,
          },
          stateVersion: 2,
        });
        expect(await s.presenters.active(session.id)).toEqual(outcome.grant);
        expect(await rows(session)).toEqual(['start_session', 'grant_presenter']);
      });

      it('answers the holder held and anyone else occupied, writing nothing', async () => {
        const session = await started();
        const opened = await claim(session, session.hostUserId, at(5));
        expect(await claim(session, session.hostUserId, at(6))).toEqual({
          kind: 'held',
          grant: opened.grant,
          stateVersion: 2,
        });
        expect(await claim(session, person(), at(7))).toEqual({
          kind: 'occupied',
          grant: opened.grant,
          stateVersion: 2,
        });
        expect(await s.presenterGrantsOf(session.id)).toHaveLength(1);
        expect(await rows(session)).toEqual(['start_session', 'grant_presenter']);
      });

      it('gives the slot to exactly one of two racing claims', async () => {
        const session = await started();
        const outcomes = await Promise.all([
          claim(session, person(), at(5)),
          claim(session, person(), at(5)),
        ]);
        expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['occupied', 'opened']);
        expect(await s.presenterGrantsOf(session.id)).toHaveLength(1);
        expect(await version(session)).toBe(2);
      });

      it('closes the holder’s grant, saying who and why, one version later', async () => {
        const session = await started();
        const presenter = session.hostUserId;
        await claim(session, presenter, at(5));
        const stopped = await stop(session, presenter, presenter, 'stopped', at(9));
        expect(stopped).toMatchObject({
          grant: { userId: presenter, endedAt: at(9), endedBy: presenter, endReason: 'stopped' },
          stateVersion: 3,
        });
        expect(await s.presenters.active(session.id)).toBeNull();
        // A presenter's own stop is not moderation.
        expect(await rows(session)).toEqual(['start_session', 'grant_presenter']);

        const other = person();
        await claim(session, other, at(10));
        const moderator = person();
        expect(await stop(session, other, moderator, 'revoked', at(12))).toMatchObject({
          grant: { userId: other, endedBy: moderator, endReason: 'revoked' },
          stateVersion: 5,
        });
        expect(await rows(session)).toEqual([
          'start_session',
          'grant_presenter',
          'grant_presenter',
          'revoke_presenter',
        ]);
      });

      it('closes nothing when nothing is open, or when the slot has passed to someone else', async () => {
        const session = await started();
        expect(await stop(session, person(), null, 'ineligible', at(5))).toEqual({
          grant: null,
          stateVersion: 1,
        });
        const holder = person();
        const opened = await claim(session, holder, at(6));
        const somebodyElse = person();
        expect(await stop(session, somebodyElse, person(), 'revoked', at(7))).toEqual({
          grant: null,
          stateVersion: 2,
        });
        expect(await s.presenters.active(session.id)).toEqual(opened.grant);
        expect(await rows(session)).toEqual(['start_session', 'grant_presenter']);
      });

      it('opens again after a close, as a new grant', async () => {
        const session = await started();
        const first = await claim(session, session.hostUserId, at(5));
        await stop(session, session.hostUserId, session.hostUserId, 'stopped', at(6));
        const second = await claim(session, session.hostUserId, at(7));
        expect(second.kind).toBe('opened');
        expect(second.grant?.id).not.toBe(first.grant?.id);
        expect(await s.presenterGrantsOf(session.id)).toHaveLength(2);
      });
    });

    describe('the ineligible expiry', () => {
      it('expires the person’s open hand and closes their presenter grant, in one version step', async () => {
        const session = await started();
        const userId = person();
        const hand = await raised(session, userId, at(1));
        await grant(hand, session.hostUserId, at(2));
        await claim(session, userId, at(3));
        const bystander = await raised(session, person(), at(4));

        const outcome = await s.requests.expireIneligible(session.id, userId, at(10));
        expect(outcome.request).toEqual({
          ...hand,
          state: 'expired',
          grantedAt: at(2),
          decidedAt: at(10),
          decidedBy: null,
        });
        expect(outcome.presenter).toMatchObject({
          userId,
          endedAt: at(10),
          endedBy: null,
          endReason: 'ineligible',
        });
        expect(outcome.stateVersion).toBe(6);
        expect(await s.requests.findOpen(session.id, userId)).toBeNull();
        expect(await s.presenters.active(session.id)).toBeNull();
        // Nobody else is touched, and an expiry is not moderation.
        expect(await request(bystander.id)).toEqual(bystander);
        expect(await rows(session)).toEqual(['start_session', 'grant_speaker', 'grant_presenter']);
      });

      it('expires a pending hand alone, and leaves another presenter’s grant open', async () => {
        const session = await started();
        const userId = person();
        const hand = await raised(session, userId, at(1));
        const opened = await claim(session, session.hostUserId, at(2));
        const outcome = await s.requests.expireIneligible(session.id, userId, at(5));
        expect(outcome).toMatchObject({
          request: { id: hand.id, state: 'expired', grantedAt: null },
          presenter: null,
          stateVersion: 4,
        });
        expect(await s.presenters.active(session.id)).toEqual(opened.grant);
      });

      it('changes nothing, the version included, for someone holding nothing', async () => {
        const session = await started();
        await raised(session, person(), at(1));
        expect(await s.requests.expireIneligible(session.id, person(), at(5))).toEqual({
          request: null,
          presenter: null,
          stateVersion: 2,
        });
        expect(await version(session)).toBe(2);
        expect(await s.requests.expireIneligible(newSession().id, person(), at(5))).toEqual({
          request: null,
          presenter: null,
          stateVersion: 0,
        });
      });
    });

    describe('the targeted watch’s windows', () => {
      it('names who lost the floor at or after an instant, once each', async () => {
        const session = await started();
        const moderator = session.hostUserId;
        const [revokedTwice, yielded, withdrawn, speaking, expired] = [
          person(),
          person(),
          person(),
          person(),
          person(),
        ];
        const first = await raised(session, revokedTwice, at(1));
        await grant(first, moderator, at(2));
        await decide(first, ['granted'], 'revoked', moderator, at(10));
        const floor = await raised(session, yielded, at(3));
        await grant(floor, moderator, at(4));
        await lower(floor, at(20));
        // Withdrawn while pending: it never held the floor.
        await lower(await raised(session, withdrawn, at(5)), at(25));
        // Still speaking: a floor given inside the window is not a floor lost.
        await grant(await raised(session, speaking, at(6)), moderator, at(35));
        await grant(await raised(session, expired, at(8)), moderator, at(9));
        await s.requests.expireIneligible(session.id, expired, at(30));
        const again = await raised(session, revokedTwice, at(31));
        await grant(again, moderator, at(32));
        await decide(again, ['granted'], 'revoked', moderator, at(40));

        const since = async (seconds: number) =>
          s.requests.floorClosedSince(session.id, at(seconds));
        expect(await since(10)).toEqual([revokedTwice, yielded, expired].sort());
        expect(await since(15)).toEqual([revokedTwice, yielded, expired].sort());
        // At the instant itself: `since` is inclusive.
        expect(await since(20)).toEqual([revokedTwice, yielded, expired].sort());
        expect(await since(21)).toEqual([revokedTwice, expired].sort());
        expect(await since(41)).toEqual([]);
        expect(await s.requests.floorClosedSince(newSession().id, at(0))).toEqual([]);
      });

      it('names whose presenter grant closed at or after an instant, once each', async () => {
        const session = await started();
        const [a, b, c] = [person(), person(), person()];
        await claim(session, a, at(1));
        await stop(session, a, a, 'stopped', at(10));
        await claim(session, b, at(11));
        await stop(session, b, person(), 'revoked', at(20));
        await claim(session, a, at(21));
        await s.requests.expireIneligible(session.id, a, at(30));
        await claim(session, c, at(31));

        const since = async (seconds: number) => s.presenters.closedSince(session.id, at(seconds));
        expect(await since(10)).toEqual([a, b].sort());
        expect(await since(20)).toEqual([a, b].sort());
        expect(await since(21)).toEqual([a]);
        expect(await since(31)).toEqual([]);
      });
    });

    describe('after the end', () => {
      it('refuses every change as session_not_live, and a repeat is still a repeat (D6)', async () => {
        const session = await started();
        const moderator = session.hostUserId;
        const pendingHand = await raised(session, person(), at(1));
        const passed = await raised(session, person(), at(2));
        await decide(passed, ['pending'], 'declined', moderator, at(3));
        const ended = await end(session, at(10));
        const frozen = ended?.session.stateVersion;
        const rowsAtEnd = await rows(session);

        expect(await raise(session, person(), at(11))).toBe('session_not_live');
        expect(await grant(pendingHand, moderator, at(12))).toMatchObject({
          kind: 'session_not_live',
          request: { state: 'expired' },
          stateVersion: frozen,
        });
        expect(await lower(pendingHand, at(13))).toMatchObject({
          kind: 'session_not_live',
          request: { state: 'expired' },
        });
        expect(await decide(passed, ['pending'], 'declined', moderator, at(14))).toMatchObject({
          kind: 'unchanged',
          request: { state: 'declined', decidedAt: at(3) },
        });
        expect(await claim(session, moderator, at(15))).toEqual({
          kind: 'session_not_live',
          grant: null,
          stateVersion: frozen,
        });
        expect(await stop(session, moderator, moderator, 'stopped', at(16))).toEqual({
          grant: null,
          stateVersion: frozen,
        });
        expect(await s.requests.expireIneligible(session.id, pendingHand.userId, at(17))).toEqual({
          request: null,
          presenter: null,
          stateVersion: frozen,
        });
        expect(
          await s.sessions.bumpEpoch(
            session.id,
            0,
            action(session.id, 'reset_media', null, null, at(18)),
          ),
        ).toBeNull();
        expect(await s.sessions.noteViolation(session.id, at(19))).toBe(0);
        await s.sessions.markEmpty(session.id, at(20));

        expect(await s.sessions.findById(session.id)).toEqual(ended?.session);
        expect(await rows(session)).toEqual(rowsAtEnd);
        expect(await s.presenterGrantsOf(session.id)).toEqual([]);
      });
    });

    describe('the state version', () => {
      it('steps by exactly one per change a moderator can observe, and never on a no-op', async () => {
        const session = await started();
        const moderator = session.hostUserId;
        const steps: Array<[string, number | undefined]> = [['start', await version(session)]];
        const note = async (label: string) => {
          steps.push([label, await version(session)]);
        };

        const hand = await raised(session, person(), at(1));
        await note('raise');
        await raise(session, hand.userId, at(2));
        await note('raise again');
        await grant(hand, moderator, at(3));
        await note('grant');
        await grant(hand, moderator, at(4));
        await note('grant again');
        const other = await raised(session, person(), at(5));
        await note('another raise');
        await decide(other, ['pending'], 'declined', moderator, at(6));
        await note('decline');
        await decide(other, ['pending'], 'declined', moderator, at(7));
        await note('decline again');
        await claim(session, moderator, at(8));
        await note('claim');
        await claim(session, moderator, at(9));
        await note('claim again');
        await stop(session, moderator, moderator, 'stopped', at(10));
        await note('stop');
        await stop(session, moderator, moderator, 'stopped', at(11));
        await note('stop again');
        await s.requests.expireIneligible(session.id, person(), at(12));
        await note('nothing to expire');
        await s.sessions.noteViolation(session.id, at(13));
        await s.sessions.markEmpty(session.id, at(13));
        await note('bookkeeping');
        await lower(hand, at(14));
        await note('yield');
        await end(session, at(20));
        await note('end');
        await end(session, at(21));
        await note('end again');

        expect(steps).toEqual([
          ['start', 1],
          ['raise', 2],
          ['raise again', 2],
          ['grant', 3],
          ['grant again', 3],
          ['another raise', 4],
          ['decline', 5],
          ['decline again', 5],
          ['claim', 6],
          ['claim again', 6],
          ['stop', 7],
          ['stop again', 7],
          ['nothing to expire', 7],
          ['bookkeeping', 7],
          ['yield', 8],
          ['end', 9],
          ['end again', 9],
        ]);
      });
    });
  });
}
