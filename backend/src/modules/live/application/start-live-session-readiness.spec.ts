import type { Principal } from '../../../shared';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { ROOM_SWEEP_SECONDS } from '../domain/live-limits';
import type { RtcNotReadyReason } from '../domain/rtc-provider';
import { DisabledRtcProvider } from '../infrastructure/disabled-rtc-provider';

/**
 * Every reason the self-check can give, and what Start answers for it (P7.2,
 * Q-B): an outage — or real media not enabled — is `live.media_unavailable`,
 * which waiting may fix; anything else is this deployment's configuration,
 * `live.media_misconfigured`, which an operator must.
 */
const REFUSALS: ReadonlyArray<readonly [RtcNotReadyReason, string]> = [
  ['provider_disabled', 'live.media_unavailable'],
  ['unreachable', 'live.media_unavailable'],
  ['insecure_url', 'live.media_misconfigured'],
  ['tls_failure', 'live.media_misconfigured'],
  ['unauthorized', 'live.media_misconfigured'],
  ['auto_create_enabled', 'live.media_misconfigured'],
  ['incompatible_response', 'live.media_misconfigured'],
];

/**
 * Start waits for the provider's self-check (live.md §9, P7.1): a provider
 * that is not ready never gets a room, and nothing is stored — a 503, as an
 * outage is. The answer is kept for a room sweep, so a burst of starts asks
 * the provider once. Joins are not gated.
 */
describe('starting a live session — the provider’s readiness', () => {
  let h: LiveHarness;
  let communityId: string;
  let owner: Principal;

  beforeEach(async () => {
    h = liveHarness();
    ({ id: communityId, owner } = await h.community('teacher-1', 'student-1'));
  });

  afterEach(() => jest.restoreAllMocks());

  const start = (principal: Principal, community = communityId) =>
    h.start.execute({ principal, communityId: community, meta: META });

  /** Nothing about a session exists for the community: no room, row, audit or event. */
  async function nothingStored(): Promise<void> {
    expect(h.rtc.calls.filter((call) => call.operation === 'ensureRoom')).toEqual([]);
    expect(h.rtc.roomNames()).toEqual([]);
    expect(await h.sessions.findLiveByCommunity(communityId)).toBeNull();
    expect(h.journal.entries).toEqual([]);
    expect(h.journal.events).toEqual([]);
  }

  it('works unchanged with the fake: asked once, ready, and the session starts', async () => {
    const check = jest.spyOn(h.rtc, 'check');
    const started = await start(owner);
    expect(started.ok && started.value.created).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(h.readiness.current?.report).toEqual({ ready: true });
    // The self-check is no provider call: the fake's log holds the room alone.
    expect(h.rtc.calls.map((call) => call.operation)).toEqual(['ensureRoom']);
  });

  it('knows what to answer for every reason the self-check can give', () => {
    const reasons: Record<RtcNotReadyReason, true> = {
      provider_disabled: true,
      insecure_url: true,
      unreachable: true,
      tls_failure: true,
      unauthorized: true,
      auto_create_enabled: true,
      incompatible_response: true,
    };
    expect(REFUSALS.map(([reason]) => reason).sort()).toEqual(Object.keys(reasons).sort());
  });

  it.each(REFUSALS)(
    'stores nothing when the provider reports %s, and answers 503 %s',
    async (reason, code) => {
      h.rtc.setReadiness({ ready: false, reason });
      const refused = await start(owner);
      expect(refused).toMatchObject({ ok: false, error: { kind: 'unavailable', code } });
      await nothingStored();
    },
  );

  it('keeps an answer for a room sweep: a burst of starts asks the provider once', async () => {
    const check = jest.spyOn(h.rtc, 'check');
    const other = await h.community('teacher-2');
    expect((await start(owner)).ok).toBe(true);
    expect((await start(other.owner, other.id)).ok).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('starts once the provider is ready again — after a room sweep’s worth of the old answer', async () => {
    h.rtc.setReadiness({ ready: false, reason: 'auto_create_enabled' });
    expect(codeOf(await start(owner))).toBe('live.media_misconfigured');
    h.rtc.setReadiness({ ready: true });
    h.clock.advance(ROOM_SWEEP_SECONDS - 1);
    expect(codeOf(await start(owner))).toBe('live.media_misconfigured');
    await nothingStored();

    h.clock.advance(1);
    const started = await start(owner);
    expect(started.ok && started.value.created).toBe(true);
    expect(h.rtc.roomNames()).toHaveLength(1);
  });

  it('answers a start retried while a session runs with that session — no room is made', async () => {
    const session = await h.startSession(owner, communityId);
    h.rtc.setReadiness({ ready: false, reason: 'unreachable' });
    h.clock.advance(ROOM_SWEEP_SECONDS);
    const again = await start(owner);
    expect(again.ok && again.value).toMatchObject({ created: false, session: { id: session.id } });
    expect(h.rtc.ensured).toHaveLength(1);
  });

  it('never gates a join: the session’s room exists already', async () => {
    const session = await h.startSession(owner, communityId);
    h.rtc.setReadiness({ ready: false, reason: 'unreachable' });
    h.clock.advance(ROOM_SWEEP_SECONDS);
    const member = await h.member(communityId, owner, 'student-2');
    const joined = await h.join.execute({ principal: member, sessionId: session.id, meta: META });
    expect(joined.ok && joined.value.role).toBe('listener');
  });

  it('answers 503 before touching a disabled provider, which reports itself disabled', async () => {
    const disabled = liveHarness({ provider: new DisabledRtcProvider() });
    const world = await disabled.community('teacher-1');
    const ensureRoom = jest.spyOn(DisabledRtcProvider.prototype, 'ensureRoom');
    const refused = await disabled.start.execute({
      principal: world.owner,
      communityId: world.id,
      meta: META,
    });
    expect(codeOf(refused)).toBe('live.media_unavailable');
    expect(ensureRoom).not.toHaveBeenCalled();
    expect(disabled.readiness.current?.report).toEqual({
      ready: false,
      reason: 'provider_disabled',
    });
    expect(await disabled.sessions.findLiveByCommunity(world.id)).toBeNull();
  });
});
