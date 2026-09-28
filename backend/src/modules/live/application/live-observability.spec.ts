import { Logger } from '@nestjs/common';

import type { Principal } from '../../../shared';
import {
  META,
  captureLogs,
  codeOf,
  liveHarness,
  type LiveHarness,
} from '../../../../test/support/live-harness';
import { credentialsIn } from '../../../../test/support/log-capture';
import { FAKE_TOKEN_PATTERN } from '../infrastructure/fake-rtc-provider';
import type { LiveSessionView } from './views';

/**
 * Live's structured log lines of P7.2 (brief §17; audit §4.9) — ids, codes
 * and outcomes, never a token, a secret or a name:
 *
 *   live.join.admitted / live.join.denied   every /join answer; a denial
 *                                           carries the internal reason the
 *                                           wire never does (decision Q-A)
 *   live.token.issued                       session, role, epoch, lifetime
 *   live.media.authorization_changed        each push the provider answered
 *   live.speaker.granted / .revoked         the floor
 *   live.presenter.claimed / .closed        the presenter slot
 *   live.reconciler.tick                    each reconciler tick's counts and
 *                                           duration — logged when it changed
 *                                           something, at debug otherwise
 */
describe('Live’s log lines (P7.2)', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(async () => {
    logs = captureLogs();
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    session = await h.startSession(owner, communityId);
    logs.lines.length = 0;
  });

  afterEach(() => jest.restoreAllMocks());

  const join = (principal: Principal, sessionId = session.id) =>
    h.join.execute({ principal, sessionId, meta: META });

  const named = (event: string) =>
    logs.lines.filter((line) => line.fields.event === event).map((line) => line.fields);

  /** Nothing any line says could be a credential: no JWT, no fake token. */
  function noCredentialLogged(): void {
    const written = JSON.stringify(logs.lines);
    expect(credentialsIn(written)).toEqual([]);
    expect(written).not.toMatch(FAKE_TOKEN_PATTERN);
  }

  describe('a join', () => {
    it('logs an admission and the token it issued — the role, epoch and lifetime, never the token', async () => {
      const joined = await join(student);
      if (!joined.ok) throw new Error(joined.error.code);

      expect(named('live.join.admitted')).toEqual([
        {
          event: 'live.join.admitted',
          sessionId: session.id,
          userId: 'student-1',
          role: 'listener',
        },
      ]);
      expect(named('live.token.issued')).toEqual([
        {
          event: 'live.token.issued',
          sessionId: session.id,
          userId: 'student-1',
          role: 'listener',
          epoch: 0,
          ttlSeconds: 120,
          expiresAt: joined.value.expiresAt.toISOString(),
          media: { microphone: false, screen: false, screenAudio: false },
        },
      ]);
      expect(JSON.stringify(logs.lines)).not.toContain(joined.value.token);
      noCredentialLogged();
    });

    // Decision Q-A: the three answer the same 404 on the wire, so nobody
    // learns whether a session runs or who belongs; only the log says why.
    it('answers a non-member, a member of another community and a removed member alike — and logs each refusal’s reason', async () => {
      const outsider = h.person('student-9', ['STUDENT']);
      const elsewhere = (await h.community('teacher-2', 'student-2')).students[0];
      await h.remove(communityId, owner, 'student-1');

      const answers = [await join(outsider), await join(elsewhere), await join(student)];
      expect(answers.map(codeOf)).toEqual([
        'live.session_not_found',
        'live.session_not_found',
        'live.session_not_found',
      ]);
      expect(answers[0]).toEqual(answers[1]);
      expect(answers[1]).toEqual(answers[2]);

      expect(named('live.join.denied')).toEqual(
        ['student-9', 'student-2', 'student-1'].map((userId) => ({
          event: 'live.join.denied',
          sessionId: session.id,
          userId,
          reason: 'not_a_participant',
          code: 'live.session_not_found',
          communities: 'communities.community_not_found',
        })),
      );
      noCredentialLogged();
    });

    it('logs why else a join was refused — with the code the client was given', async () => {
      await join(student, 'not an id at all');
      await join(student, '00000000-0000-4000-8000-00000000beef');
      await h.end.execute({ principal: owner, sessionId: session.id, meta: META });
      await join(student);

      expect(named('live.join.denied')).toEqual([
        // Never an id this API could have issued: not logged.
        {
          event: 'live.join.denied',
          userId: 'student-1',
          reason: 'malformed_id',
          code: 'live.session_not_found',
        },
        {
          event: 'live.join.denied',
          sessionId: '00000000-0000-4000-8000-00000000beef',
          userId: 'student-1',
          reason: 'no_such_session',
          code: 'live.session_not_found',
        },
        {
          event: 'live.join.denied',
          sessionId: session.id,
          userId: 'student-1',
          reason: 'session_ended',
          code: 'live.session_not_live',
        },
      ]);
      expect(JSON.stringify(logs.lines)).not.toContain('not an id at all');
    });
  });

  describe('the floor and the presenter slot', () => {
    it('logs a grant and a revoke with what the push came to, and each push the provider answered', async () => {
      h.rtc.connect(h.room(session.id), 'student-1', {
        canPublishAudio: false,
        canPublishScreen: false,
        canPublishScreenAudio: false,
        canSubscribe: true,
        canPublishData: false,
        hidden: false,
      });
      const hand = await h.raised(student, session.id);
      await h.moderate.grant({ principal: owner, requestId: hand.id, meta: META });
      await h.moderate.revoke({ principal: owner, requestId: hand.id, meta: META });

      const floor = { sessionId: session.id, requestId: hand.id, userId: 'student-1' };
      expect(named('live.speaker.granted')).toEqual([
        { event: 'live.speaker.granted', ...floor, by: 'teacher-1', media: 'applied' },
      ]);
      expect(named('live.speaker.revoked')).toEqual([
        { event: 'live.speaker.revoked', ...floor, by: 'teacher-1', media: 'applied' },
      ]);
      expect(named('live.media.authorization_changed')).toEqual(
        [true, false].map((microphone) => ({
          event: 'live.media.authorization_changed',
          sessionId: session.id,
          userId: 'student-1',
          cause: 'stored_change',
          outcome: 'applied',
          microphone,
          screen: false,
        })),
      );
      noCredentialLogged();
    });

    it('logs the slot claimed and closed — by its holder, or taken back by a moderator', async () => {
      const claimed = await h.presenter.claim({
        principal: owner,
        sessionId: session.id,
        meta: META,
      });
      if (!claimed.ok) throw new Error(claimed.error.code);
      await h.presenter.stop({ principal: owner, sessionId: session.id, meta: META });

      const [grant] = named('live.presenter.claimed');
      expect(grant).toEqual({
        event: 'live.presenter.claimed',
        sessionId: session.id,
        presenterGrantId: expect.any(String) as string,
        userId: 'teacher-1',
        media: 'not_connected',
      });
      expect(named('live.presenter.closed')).toEqual([
        {
          event: 'live.presenter.closed',
          sessionId: session.id,
          presenterGrantId: grant?.presenterGrantId,
          userId: 'teacher-1',
          by: 'teacher-1',
          reason: 'stopped',
          media: 'not_connected',
        },
      ]);
    });
  });

  describe('the reconciler', () => {
    it('logs each tick that changed something — its counts and duration — and a quiet one only at debug', async () => {
      // student-1 holding a microphone nothing gives them.
      h.rtc.connect(h.room(session.id), 'student-1', {
        canPublishAudio: true,
        canPublishScreen: false,
        canPublishScreenAudio: false,
        canSubscribe: true,
        canPublishData: false,
        hidden: false,
      });
      logs.lines.length = 0;
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

      await h.reconciler.sweepParticipants();
      expect(named('live.reconciler.tick')).toEqual([
        {
          event: 'live.reconciler.tick',
          tick: 'participants',
          skipped: null,
          sessions: 1,
          sessionsSkipped: 0,
          checked: 1,
          removed: 0,
          corrected: 1,
          pushed: 0,
          violations: 0,
          resets: 0,
          ended: 0,
          foreignRemoved: 0,
          foreignBreaches: 0,
          durationMs: expect.any(Number) as number,
        },
      ]);

      // Corrected now: the next ticks change nothing, and say so only at debug.
      await h.reconciler.sweepParticipants();
      await h.reconciler.sweepRooms();
      expect(named('live.reconciler.tick')).toHaveLength(1);
      const quiet = debug.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => fields.event === 'live.reconciler.tick')
        .map((fields) => fields.tick);
      expect(quiet).toEqual(['participants', 'rooms']);
      noCredentialLogged();
    });
  });
});
