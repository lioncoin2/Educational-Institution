import type { Principal, Result } from '../../../shared';
import { COMMUNITY_ACTS } from '../../communities/contracts/capabilities';
import { PolicyAuthorizationService } from '../../identity/application/authorization.service';
import type { AuthorizationContext, AuthorizationService } from '../../identity/contracts';
import { PROVISIONAL_POLICY_RULES } from '../../identity/domain/provisional-policy';
import { META, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import type { LiveSessionView, SpeakerRequestView } from './views';

/**
 * The authorization migration (live.md §7.4; ADR 0017 decisions 10–11):
 * identity's host-only rule is gone, and in its place Live asks Communities
 * — so an identity role alone, OWNER included, never moderates, and Live
 * never passes the `ownerUserId` that rule keyed on.
 */
describe('live authorization after host-only moderation', () => {
  it('leaves identity with no resource rule at all', () => {
    expect(PROVISIONAL_POLICY_RULES).toEqual([]);
  });

  describe('with a session under way', () => {
    let h: LiveHarness;
    let communityId: string;
    let owner: Principal;
    let student: Principal;
    let session: LiveSessionView;
    let pending: SpeakerRequestView;
    let granted: SpeakerRequestView;
    /** Every context identity was asked with, by Communities and Live alike. */
    let contexts: Array<AuthorizationContext | undefined>;

    beforeEach(async () => {
      contexts = [];
      const policy = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);
      const spy: AuthorizationService = {
        can: (principal, permission, context) => {
          contexts.push(context);
          return policy.can(principal, permission, context);
        },
        authorize: (principal, permission, context) => {
          contexts.push(context);
          return policy.authorize(principal, permission, context);
        },
      };
      h = liveHarness({ identity: spy });
      const world = await h.community('teacher-1', 'student-1', 'student-2');
      ({ id: communityId, owner } = world);
      student = world.students[0];
      session = await h.startSession(owner, communityId);
      pending = await h.raised(student, session.id);
      granted = await h.raised(world.students[1], session.id);
      await h.moderate.grant({ principal: owner, requestId: granted.id, meta: META });
      await h.presenter.claim({ principal: owner, sessionId: session.id, meta: META });
      h.journal.clear();
    });

    /** Every Live use case, as `principal` would call it here. */
    const everything = (principal: Principal) =>
      ({
        start: () => h.start.execute({ principal, communityId, meta: META }),
        current: () => h.current.execute({ principal, communityId }),
        get: () => h.get.execute({ principal, sessionId: session.id }),
        join: () => h.join.execute({ principal, sessionId: session.id, meta: META }),
        raise: () => h.raise.execute({ principal, sessionId: session.id, meta: META }),
        lower: () => h.lower.execute({ principal, sessionId: session.id, meta: META }),
        hands: () => h.hands.execute({ principal, sessionId: session.id }),
        speakers: () => h.hands.execute({ principal, sessionId: session.id, state: 'granted' }),
        grant: () => h.moderate.grant({ principal, requestId: pending.id, meta: META }),
        decline: () => h.moderate.decline({ principal, requestId: pending.id, meta: META }),
        revoke: () => h.moderate.revoke({ principal, requestId: granted.id, meta: META }),
        claim: () => h.presenter.claim({ principal, sessionId: session.id, meta: META }),
        stop: () => h.presenter.stop({ principal, sessionId: session.id, meta: META }),
        end: () => h.end.execute({ principal, sessionId: session.id, meta: META }),
      }) satisfies Record<string, () => Promise<Result<unknown>>>;

    it('refuses an all-permission principal without standing everywhere, as if nothing existed — and nothing changes', async () => {
      const institutionOwner = h.person('owner-1', ['OWNER']);
      const before = {
        session: await h.session(session.id),
        pending: await h.requests.findById(pending.id),
        granted: await h.requests.findById(granted.id),
        presenter: await h.presenters.active(session.id),
      };
      const calls = h.rtc.calls.length;

      const answers: Record<string, string> = {};
      for (const [name, run] of Object.entries(everything(institutionOwner))) {
        const result = await run();
        answers[name] = result.ok ? 'ok' : result.error.code;
      }
      expect(answers).toEqual({
        start: 'live.community_not_found',
        current: 'live.community_not_found',
        get: 'live.session_not_found',
        join: 'live.session_not_found',
        raise: 'live.session_not_found',
        lower: 'live.session_not_found',
        hands: 'live.session_not_found',
        speakers: 'live.session_not_found',
        grant: 'live.request_not_found',
        decline: 'live.request_not_found',
        revoke: 'live.request_not_found',
        claim: 'live.session_not_found',
        stop: 'live.session_not_found',
        end: 'live.session_not_found',
      });
      // No provider call, no audit entry, no event, no change to any record.
      expect(h.rtc.calls).toHaveLength(calls);
      expect(h.journal.order).toEqual([]);
      expect({
        session: await h.session(session.id),
        pending: await h.requests.findById(pending.id),
        granted: await h.requests.findById(granted.id),
        presenter: await h.presenters.active(session.id),
      }).toEqual(before);
    });

    it('answers an id this API could never have issued exactly as an unknown one — before any limiter, store or Communities call', async () => {
      /** Every use case that takes a session or request id from the path, for these ids. */
      const byId = (principal: Principal, sessionId: string, requestId: string) =>
        ({
          get: () => h.get.execute({ principal, sessionId }),
          join: () => h.join.execute({ principal, sessionId, meta: META }),
          raise: () => h.raise.execute({ principal, sessionId, meta: META }),
          lower: () => h.lower.execute({ principal, sessionId, meta: META }),
          hands: () => h.hands.execute({ principal, sessionId }),
          grant: () => h.moderate.grant({ principal, requestId, meta: META }),
          decline: () => h.moderate.decline({ principal, requestId, meta: META }),
          revoke: () => h.moderate.revoke({ principal, requestId, meta: META }),
          claim: () => h.presenter.claim({ principal, sessionId, meta: META }),
          stop: () => h.presenter.stop({ principal, sessionId, meta: META }),
          end: () => h.end.execute({ principal, sessionId, meta: META }),
        }) satisfies Record<string, () => Promise<Result<unknown>>>;
      // Every role a route could ask for: the owner may moderate, the student
      // may join and raise.
      const callers = [owner, student];
      const unknown = '00000000-0000-4000-8000-0000000000a1';
      const answersFor = async (sessionId: string, requestId: string) => {
        const answers: Record<string, Result<unknown>> = {};
        for (const principal of callers) {
          for (const [name, run] of Object.entries(byId(principal, sessionId, requestId))) {
            answers[`${principal.userId} ${name}`] = await run();
          }
        }
        return answers;
      };
      const expected = await answersFor(unknown, unknown);

      const consume = jest.spyOn(h.limiter, 'consume');
      const reads = [
        jest.spyOn(h.sessions, 'findById'),
        jest.spyOn(h.requests, 'findById'),
        jest.spyOn(h.requests, 'findOpen'),
        jest.spyOn(h.presenters, 'active'),
        jest.spyOn(h.authorization, 'authorize'),
        jest.spyOn(h.authorization, 'permittedAmong'),
      ];
      const calls = h.rtc.calls.length;
      for (const malformed of ['x'.repeat(15_000), `${unknown}.1`, 'a/b', '']) {
        // The same answer, to the byte: nothing tells a malformed id from an unknown one.
        expect(await answersFor(malformed, malformed)).toEqual(expected);
      }
      expect(Object.values(expected).filter((answer) => answer.ok)).toEqual([]);
      // Refused before anything: no limiter window, no read, no Communities call.
      expect(consume).not.toHaveBeenCalled();
      for (const read of reads) expect(read).not.toHaveBeenCalled();
      expect(h.rtc.calls).toHaveLength(calls);
      expect(h.journal.order).toEqual([]);
    });

    it('passes no ownerUserId to identity, from any use case', async () => {
      const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
      contexts.length = 0;
      for (const principal of [owner, delegate, student]) {
        for (const run of Object.values(everything(principal))) await run();
      }
      // Not vacuous: identity was asked, with contexts and without.
      expect(contexts.length).toBeGreaterThan(50);
      expect(contexts.some((context) => context !== undefined)).toBe(true);
      expect(contexts.some((context) => context === undefined)).toBe(true);
      expect(
        contexts.filter((context) => context !== undefined && 'ownerUserId' in context),
      ).toEqual([]);
    });

    it('lets a delegate who is not the host moderate — nothing vetoes delegation any more', async () => {
      const delegate = await h.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
      const declined = await h.moderate.decline({
        principal: delegate,
        requestId: pending.id,
        meta: META,
      });
      expect(declined.ok && declined.value.request.state).toBe('declined');
    });

    it('confers no community act with a speaker grant (R5)', async () => {
      const speaker = h.person('student-2', ['STUDENT']);
      const answersOf = async () =>
        Promise.all(
          COMMUNITY_ACTS.map(async (act) => {
            const answer = await h.authorization.authorize(speaker, communityId, act);
            return [act, answer.ok ? answer.value.basis : answer.error.code] as const;
          }),
        );
      const asSpeaker = await answersOf();
      await h.moderate.revoke({ principal: owner, requestId: granted.id, meta: META });
      expect(await answersOf()).toEqual(asSpeaker);
      expect(asSpeaker).toContainEqual(['community.live.moderate', 'identity.permission_denied']);
    });
  });
});
