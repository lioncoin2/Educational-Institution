import { err, failure, type Result } from '../../../shared';
import type { AuthorizationService } from '../../identity/contracts';
import {
  HOST,
  SESSION,
  allowAll,
  liveHarness,
  liveSession,
  pending,
  principalOf,
} from '../../../../test/support/live-harness';
import { LISTENER, SPEAKER } from '../domain/rtc-provider';
import { JOIN_TOKEN_TTL_SECONDS } from './join-live-session.use-case';

const denyAll: AuthorizationService = {
  can: () => false,
  authorize: () => err(failure('forbidden', 'denied', 'no')),
};

const unwrapOk = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

const student = principalOf('student-1', 'STUDENT');
const teacher = principalOf(HOST, 'TEACHER');

describe('joining a live session', () => {
  it('refuses a caller without the join permission, minting nothing', async () => {
    const h = liveHarness({ authorization: denyAll });
    const result = await h.join.execute({ principal: student, sessionId: SESSION });
    expect(result.ok).toBe(false);
    expect(h.rtc.issued).toHaveLength(0);
  });

  // The property a large session rests on.
  it('gives a listener a token that can publish nothing — not audio, not a screen, not data', async () => {
    const h = liveHarness();
    const ticket = unwrapOk(await h.join.execute({ principal: student, sessionId: SESSION }));
    expect(h.rtc.issued[0]?.capabilities).toEqual(LISTENER);
    expect(LISTENER).toEqual({
      canPublishAudio: false,
      canPublishScreen: false,
      canPublishScreenAudio: false,
      canSubscribe: true,
      canPublishData: false,
      hidden: false,
    });
    expect(ticket).toMatchObject({
      role: 'listener',
      media: { microphone: false, screen: false, screenAudio: false },
    });
  });

  it('gives the host who may speak the microphone, as moderator', async () => {
    const h = liveHarness();
    const ticket = unwrapOk(await h.join.execute({ principal: teacher, sessionId: SESSION }));
    expect(h.rtc.issued[0]?.capabilities).toEqual(SPEAKER);
    expect(ticket.role).toBe('moderator');
    expect(ticket.media).toEqual({ microphone: true, screen: false, screenAudio: false });
  });

  it('does not let the host publish without live.speak', async () => {
    const joinOnly: AuthorizationService = {
      can: (_principal, permission) => permission === 'live.join',
      authorize: (_principal, permission) =>
        permission === 'live.join'
          ? allowAll.authorize(_principal, permission)
          : err(failure('forbidden', 'denied', 'no')),
    };
    const h = liveHarness({ authorization: joinOnly });
    const ticket = unwrapOk(await h.join.execute({ principal: teacher, sessionId: SESSION }));
    expect(ticket.role).toBe('listener');
    expect(h.rtc.issued[0]?.capabilities.canPublishAudio).toBe(false);
  });

  it('names the participant from the account directory — the request carries no name', async () => {
    const h = liveHarness();
    await h.join.execute({ principal: student, sessionId: SESSION });
    expect(h.rtc.issued[0]).toMatchObject({ identity: 'student-1', displayName: 'مريم' });
  });

  it('scopes the token to the session and the caller, for 120 seconds', async () => {
    const h = liveHarness();
    const ticket = unwrapOk(await h.join.execute({ principal: student, sessionId: SESSION }));
    expect(JOIN_TOKEN_TTL_SECONDS).toBe(120);
    expect(h.rtc.issued[0]).toMatchObject({
      roomName: SESSION,
      identity: 'student-1',
      ttlSeconds: 120,
    });
    expect(ticket.expiresInSeconds).toBe(120);
  });

  // The reconnect contract: /join is the re-entry path, and it always decides
  // from the records as they are now — never from what an older token said.
  it('decides afresh on every call: a granted hand re-joins as speaker, a revoked one as listener', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    const moderator = principalOf(HOST, 'TEACHER');

    expect(unwrapOk(await h.join.execute({ principal: student, sessionId: SESSION })).role).toBe(
      'listener',
    );
    await h.moderate.grant({ principal: moderator, requestId: 'req-1' });
    const asSpeaker = unwrapOk(await h.join.execute({ principal: student, sessionId: SESSION }));
    expect(asSpeaker.role).toBe('speaker');
    expect(h.rtc.issued.at(-1)?.capabilities).toEqual(SPEAKER);

    await h.moderate.revoke({ principal: moderator, requestId: 'req-1' });
    const asListener = unwrapOk(await h.join.execute({ principal: student, sessionId: SESSION }));
    expect(asListener.role).toBe('listener');
    expect(h.rtc.issued.at(-1)?.capabilities).toEqual(LISTENER);
  });

  it('may be called again at any time — each call mints a fresh ticket and changes nothing else', async () => {
    const h = liveHarness();
    for (let i = 0; i < 3; i += 1) {
      unwrapOk(await h.join.execute({ principal: student, sessionId: SESSION }));
    }
    expect(h.rtc.issued).toHaveLength(3);
    expect(h.rtc.capabilityChanges).toHaveLength(0);
    expect(h.rtc.removed).toHaveLength(0);
    expect(h.audit.entries).toHaveLength(0);
  });

  it('refuses a session that is not live, and reports a missing one as not found', async () => {
    const ended = liveHarness({ session: { ...liveSession, state: 'ended' } });
    const notLive = await ended.join.execute({ principal: student, sessionId: SESSION });
    expect(notLive.ok || notLive.error.code).toBe('live.session_not_live');

    const h = liveHarness();
    const missing = await h.join.execute({ principal: student, sessionId: 'nope' });
    expect(missing.ok || missing.error.code).toBe('live.session_not_found');
    expect(h.rtc.issued).toHaveLength(0);
  });
});
