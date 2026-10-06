import { Logger } from '@nestjs/common';

import type { Principal, Result } from '../../../shared';
import { META, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import type { LiveSessionView, SpeakerRequestView } from './views';

/**
 * When Communities cannot answer — its store down, a timeout — every Live
 * route that asks it fails closed with 503 `unavailable` (audit D14; live.md
 * §7.1): never a role-only answer, never a change made on a guess, and the
 * failure logged by class only.
 */
describe('a Communities outage', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;
  let student: Principal;
  let session: LiveSessionView;
  let pending: SpeakerRequestView;
  let granted: SpeakerRequestView;
  let logged: jest.SpyInstance;

  beforeEach(async () => {
    h = liveHarness();
    const world = await h.community('teacher-1', 'student-1', 'student-2', 'student-3');
    ({ id: communityId, owner } = world);
    student = world.students[0];
    session = await h.startSession(owner, communityId);
    pending = await h.raised(world.students[1], session.id);
    granted = await h.raised(world.students[2], session.id);
    await h.moderate.grant({ principal: owner, requestId: granted.id, meta: META });
    await h.presenter.claim({ principal: owner, sessionId: session.id, meta: META });
    h.journal.clear();
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Every route that asks Communities, as someone it would otherwise admit. */
  const asking = () =>
    ({
      start: () => h.start.execute({ principal: owner, communityId, meta: META }),
      current: () => h.current.execute({ principal: student, communityId }),
      get: () => h.get.execute({ principal: student, sessionId: session.id }),
      join: () => h.join.execute({ principal: student, sessionId: session.id, meta: META }),
      raise: () => h.raise.execute({ principal: student, sessionId: session.id, meta: META }),
      // With no hand up, lowering asks whether the caller may see the session.
      lower: () => h.lower.execute({ principal: student, sessionId: session.id, meta: META }),
      hands: () => h.hands.execute({ principal: owner, sessionId: session.id }),
      grant: () => h.moderate.grant({ principal: owner, requestId: pending.id, meta: META }),
      decline: () => h.moderate.decline({ principal: owner, requestId: pending.id, meta: META }),
      revoke: () => h.moderate.revoke({ principal: owner, requestId: granted.id, meta: META }),
      claim: () => h.presenter.claim({ principal: owner, sessionId: session.id, meta: META }),
      // A stop by anyone but the presenter asks whether they moderate.
      stop: () => h.presenter.stop({ principal: student, sessionId: session.id, meta: META }),
      end: () => h.end.execute({ principal: owner, sessionId: session.id, meta: META }),
    }) satisfies Record<string, () => Promise<Result<unknown>>>;

  async function answersOf(): Promise<Record<string, unknown>> {
    const answers: Record<string, unknown> = {};
    for (const [name, run] of Object.entries(asking())) {
      const result = await run();
      answers[name] = result.ok ? 'ok' : result.error;
    }
    return answers;
  }

  const UNAVAILABLE = {
    kind: 'unavailable',
    code: 'unavailable',
    message: 'A service this request needs is briefly unavailable. Try again shortly.',
  };

  it('answers 503 unavailable on every route that asks — and changes nothing', async () => {
    const before = {
      session: await h.session(session.id),
      pending: await h.requests.findById(pending.id),
      granted: await h.requests.findById(granted.id),
      presenters: await h.presenters.activeGrants(session.id),
    };
    const calls = h.rtc.calls.length;
    jest
      .spyOn(h.authorization, 'authorize')
      .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:5432'));

    const answers = await answersOf();
    for (const answer of Object.values(answers)) expect(answer).toEqual(UNAVAILABLE);
    expect(Object.keys(answers)).toHaveLength(13);

    expect(h.rtc.calls).toHaveLength(calls);
    expect(h.journal.order).toEqual([]);
    expect({
      session: await h.session(session.id),
      pending: await h.requests.findById(pending.id),
      granted: await h.requests.findById(granted.id),
      presenters: await h.presenters.activeGrants(session.id),
    }).toEqual(before);
  });

  it('logs the failure by its class, never its message', async () => {
    jest
      .spyOn(h.authorization, 'authorize')
      .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:5432'));
    await h.join.execute({ principal: student, sessionId: session.id, meta: META });
    expect(logged.mock.calls).toEqual([
      [
        { event: 'live.communities.unavailable', err: { name: 'Error' } },
        'Communities could not answer; failing closed',
      ],
    ]);
  });

  it('refuses a grant when the requester’s eligibility cannot be read', async () => {
    jest
      .spyOn(h.authorization, 'permittedAmong')
      .mockRejectedValue(new Error('connection terminated'));
    expect(await h.moderate.grant({ principal: owner, requestId: pending.id, meta: META })).toEqual(
      {
        ok: false,
        error: UNAVAILABLE,
      },
    );
    expect((await h.requests.findById(pending.id))?.state).toBe('pending');
    expect(h.journal.order).toEqual([]);
  });

  it('keeps a decision made before the outage struck its media push: stored, audited, media pending', async () => {
    const permittedAmong = h.authorization.permittedAmong.bind(h.authorization);
    // The eligibility check reads; the push that follows the commit cannot.
    jest
      .spyOn(h.authorization, 'permittedAmong')
      .mockImplementationOnce(permittedAmong)
      .mockImplementationOnce(permittedAmong)
      .mockRejectedValue(new Error('connection terminated'));
    const decided = await h.moderate.grant({ principal: owner, requestId: pending.id, meta: META });
    expect(decided).toMatchObject({
      ok: true,
      value: { request: { state: 'granted' }, media: 'pending' },
    });
    expect(h.audits()).toEqual(['live.speaker.granted']);
    expect(h.media.unsettled().map((push) => push.userId)).toContain('student-2');
  });

  it('answers again as soon as Communities does — nothing about the outage is kept', async () => {
    jest.spyOn(h.authorization, 'authorize').mockRejectedValueOnce(new Error('timeout'));
    const refused = await h.join.execute({ principal: student, sessionId: session.id, meta: META });
    expect(refused.ok).toBe(false);
    const admitted = await h.join.execute({
      principal: student,
      sessionId: session.id,
      meta: META,
    });
    expect(admitted.ok).toBe(true);
  });
});
