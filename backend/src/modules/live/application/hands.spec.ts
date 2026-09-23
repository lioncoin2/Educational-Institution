import type { Result } from '../../../shared';
import {
  HOST,
  SESSION,
  liveHarness,
  liveSession,
  principalOf,
} from '../../../../test/support/live-harness';
import { LISTENER } from '../domain/rtc-provider';

const student = principalOf('student-1', 'STUDENT');
const host = principalOf(HOST, 'TEACHER');

const unwrapOk = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

describe('raising a hand', () => {
  it('creates one pending request, announced once, touching no media', async () => {
    const h = liveHarness();
    const raised = unwrapOk(await h.raise.execute({ principal: student, sessionId: SESSION }));
    expect(raised.created).toBe(true);
    expect(raised.request).toMatchObject({
      sessionId: SESSION,
      userId: 'student-1',
      state: 'pending',
    });
    expect(h.eventNames()).toEqual(['live.speaker.requested']);
    // A raised hand is application state, not media state.
    expect(h.rtc.capabilityChanges).toHaveLength(0);
    expect(h.rtc.issued).toHaveLength(0);
    // Not moderation: nothing in the audit trail.
    expect(h.audit.entries).toHaveLength(0);
  });

  it('is idempotent: a hand already up is answered as it is, with no second row or event', async () => {
    const h = liveHarness();
    const first = unwrapOk(await h.raise.execute({ principal: student, sessionId: SESSION }));
    const again = unwrapOk(await h.raise.execute({ principal: student, sessionId: SESSION }));
    expect(again).toEqual({ created: false, request: first.request });
    expect(h.events.published).toHaveLength(1);
  });

  it('makes one request out of twenty simultaneous raises by one person', async () => {
    const h = liveHarness();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => h.raise.execute({ principal: student, sessionId: SESSION })),
    );
    const values = results.map(unwrapOk);
    expect(values.filter((value) => value.created)).toHaveLength(1);
    expect(new Set(values.map((value) => value.request.id)).size).toBe(1);
    expect(h.events.published).toHaveLength(1);
  });

  it('answers the granted hand when a speaker raises again — the floor is not reset', async () => {
    const h = liveHarness();
    const { request } = unwrapOk(await h.raise.execute({ principal: student, sessionId: SESSION }));
    await h.moderate.grant({ principal: host, requestId: request.id });
    const again = unwrapOk(await h.raise.execute({ principal: student, sessionId: SESSION }));
    expect(again).toMatchObject({ created: false, request: { id: request.id, state: 'granted' } });
  });

  it('refuses a session that is not live', async () => {
    const h = liveHarness({ session: { ...liveSession, state: 'ended' } });
    const result = await h.raise.execute({ principal: student, sessionId: SESSION });
    expect(result.ok || result.error.code).toBe('live.session_not_live');
  });
});

describe('lowering a hand', () => {
  it('withdraws a pending hand without touching the media plane', async () => {
    const h = liveHarness();
    await h.raise.execute({ principal: student, sessionId: SESSION });
    const lowered = unwrapOk(await h.lower.execute({ principal: student, sessionId: SESSION }));
    expect(lowered.request?.state).toBe('withdrawn');
    expect(h.rtc.capabilityChanges).toHaveLength(0);
    expect(h.eventNames()).toEqual(['live.speaker.requested', 'live.speaker.withdrawn']);
    expect(h.events.published.at(-1)?.payload).toMatchObject({ from: 'pending' });
  });

  it('lets a speaker yield the floor: the microphone right ends on the wire too', async () => {
    const h = liveHarness();
    const { request } = unwrapOk(await h.raise.execute({ principal: student, sessionId: SESSION }));
    await h.moderate.grant({ principal: host, requestId: request.id });
    const lowered = unwrapOk(await h.lower.execute({ principal: student, sessionId: SESSION }));
    expect(lowered.request?.state).toBe('withdrawn');
    expect(h.rtc.capabilityChanges.at(-1)).toEqual({
      roomName: SESSION,
      identity: 'student-1',
      capabilities: LISTENER,
    });
    expect(h.events.published.at(-1)?.payload).toMatchObject({ from: 'granted' });
    // A person's own act, not moderation.
    expect(h.audit.actions()).toEqual(['live.speaker.granted']);
  });

  it('answers {request: null} when nothing is up — a retry is harmless', async () => {
    const h = liveHarness();
    expect(unwrapOk(await h.lower.execute({ principal: student, sessionId: SESSION }))).toEqual({
      request: null,
    });
    await h.raise.execute({ principal: student, sessionId: SESSION });
    await h.lower.execute({ principal: student, sessionId: SESSION });
    expect(unwrapOk(await h.lower.execute({ principal: student, sessionId: SESSION }))).toEqual({
      request: null,
    });
    expect(h.eventNames()).toEqual(['live.speaker.requested', 'live.speaker.withdrawn']);
  });

  it('only ever lowers the caller’s own hand', async () => {
    const h = liveHarness();
    await h.raise.execute({ principal: student, sessionId: SESSION });
    const other = principalOf('student-2', 'STUDENT');
    expect(unwrapOk(await h.lower.execute({ principal: other, sessionId: SESSION }))).toEqual({
      request: null,
    });
    expect((await h.requests.findOpen(SESSION, 'student-1'))?.state).toBe('pending');
  });

  it('lets exactly one of a yield and a revoke win when they race', async () => {
    const h = liveHarness();
    const { request } = unwrapOk(await h.raise.execute({ principal: student, sessionId: SESSION }));
    await h.moderate.grant({ principal: host, requestId: request.id });
    const [yielded, revoked] = await Promise.all([
      h.lower.execute({ principal: student, sessionId: SESSION }),
      h.moderate.revoke({ principal: host, requestId: request.id }),
    ]);
    const final = (await h.requests.findById(request.id))?.state;
    expect(['withdrawn', 'revoked']).toContain(final);
    // The loser is told the hand was already decided — never a second change.
    expect([yielded.ok, revoked.ok].filter(Boolean)).toHaveLength(1);
    expect((await h.requests.granted(SESSION)).length).toBe(0);
  });
});
