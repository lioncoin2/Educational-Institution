import type { Principal } from '../../../shared';
import { META, codeOf, liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { IDLE_END_SECONDS, ORPHAN_GRACE_SECONDS, ROOM_SWEEP_SECONDS } from '../domain/live-limits';
import type { RtcReadinessReport } from '../domain/rtc-provider';

/** A promise the test resolves when it chooses. */
function gate<T>(): { readonly promise: Promise<T>; open(value: T): void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The room sweep keeps Start's gate fresh (live.md §9, P7.1): every sweep
 * first asks the provider's self-check again, through `LiveMediaReadiness` —
 * the one Start reads. A provider positively not LiveKit
 * (`incompatible_response`) is not read at all; any other answer changes
 * nothing the sweep does.
 */
describe('LiveReconciler — the room sweep refreshes the provider’s readiness', () => {
  let h: LiveHarness;
  let owner: Principal;
  let communityId: string;

  beforeEach(async () => {
    h = liveHarness();
    ({ id: communityId, owner } = await h.community('teacher-1', 'student-1'));
  });

  afterEach(async () => {
    await h.reconciler.stop();
    jest.restoreAllMocks();
  });

  const start = () => h.start.execute({ principal: owner, communityId, meta: META });

  it('asks at every room sweep, and Start reads that answer for a sweep’s worth of time', async () => {
    const check = jest.spyOn(h.rtc, 'check');
    expect(h.readiness.current).toBeNull();

    await h.reconciler.sweepRooms();
    expect(h.readiness.current).toEqual({ report: { ready: true }, at: h.clock.now() });

    h.rtc.setReadiness({ ready: false, reason: 'auto_create_enabled' });
    h.clock.advance(ROOM_SWEEP_SECONDS);
    await h.reconciler.sweepRooms();
    expect(h.readiness.current).toEqual({
      report: { ready: false, reason: 'auto_create_enabled' },
      at: h.clock.now(),
    });
    expect(check).toHaveBeenCalledTimes(2);

    // Start trusts the sweep's answer — 503, nothing stored — without asking
    // again: a server with auto-create on is this deployment's configuration
    // (P7.2, Q-B).
    h.clock.advance(ROOM_SWEEP_SECONDS - 1);
    expect(codeOf(await start())).toBe('live.media_misconfigured');
    expect(check).toHaveBeenCalledTimes(2);
    expect(h.rtc.roomNames()).toEqual([]);
    expect(await h.sessions.findLiveByCommunity(communityId)).toBeNull();

    // Ready again at the next sweep: Start goes ahead on that answer.
    h.rtc.setReadiness({ ready: true });
    await h.reconciler.sweepRooms();
    expect((await start()).ok).toBe(true);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('asks at every sweep, however fresh the last answer is', async () => {
    const check = jest.spyOn(h.rtc, 'check');
    for (let sweep = 0; sweep < 3; sweep += 1) await h.reconciler.sweepRooms();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('changes nothing the sweep does: a live session’s missing room is still ensured', async () => {
    const session = await h.startSession(owner, communityId);
    await h.rtc.endRoom(h.room(session.id));
    h.rtc.setReadiness({ ready: false, reason: 'unreachable' });

    expect(await h.reconciler.sweepRooms()).toEqual({
      skipped: null,
      sessions: 1,
      sessionsSkipped: 0,
      ensured: 1,
      idleEnded: 0,
      orphansEnded: 0,
    });
    expect(h.rtc.roomNames()).toEqual([h.room(session.id)]);
    expect(h.readiness.current?.report).toEqual({ ready: false, reason: 'unreachable' });
  });

  it('asks first: nothing is read from the provider before the self-check answers, and a stop waits for it', async () => {
    const answer = gate<RtcReadinessReport>();
    jest.spyOn(h.rtc, 'check').mockReturnValue(answer.promise);
    let swept = false;
    const sweeping = h.reconciler.sweepRooms().then((report) => {
      swept = true;
      return report;
    });
    await new Promise((resolve) => setImmediate(resolve));

    // While the self-check is out, the sweep reads nothing…
    expect(h.rtc.calls.map((call) => call.operation)).toEqual([]);
    expect(swept).toBe(false);
    let stopped = false;
    const stopping = h.reconciler.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    // …and once it answers — not ready, but for a reason whose calls fail on
    // their own — the sweep runs, and a stop has nothing left to wait for.
    answer.open({ ready: false, reason: 'tls_failure' });
    expect(await sweeping).toMatchObject({ skipped: null });
    expect(h.rtc.calls.map((call) => call.operation)).toEqual(['listRooms']);
    await stopping;
    expect(h.readiness.current?.report).toEqual({ ready: false, reason: 'tls_failure' });
  });

  it('reads nothing from a provider whose answers are not LiveKit’s: no room ensured, no session ended idle, no orphan ended', async () => {
    // A live session whose room went missing and that has been "empty" past
    // the idle bound — the picture a wrong endpoint answering 200 {} to
    // everything would paint — and an orphan of this deployment's form.
    const session = await h.startSession(owner, communityId);
    await h.rtc.endRoom(h.room(session.id));
    await h.sessions.markEmpty(session.id, h.clock.now());
    h.clock.advance(IDLE_END_SECONDS + ORPHAN_GRACE_SECONDS);
    const orphan = `${h.settings.roomNamePrefix}00000000-0000-4000-8000-00000000abcd`;
    await h.rtc.ensureRoom({
      roomName: orphan,
      maxParticipants: 1,
      emptyTimeoutSeconds: 1,
      departureTimeoutSeconds: 1,
    });
    h.clock.advance(ORPHAN_GRACE_SECONDS);
    const calls = h.rtc.calls.length;
    h.rtc.setReadiness({ ready: false, reason: 'incompatible_response' });

    expect(await h.reconciler.sweepRooms()).toEqual({
      skipped: 'provider_incompatible',
      sessions: 0,
      sessionsSkipped: 0,
      ensured: 0,
      idleEnded: 0,
      orphansEnded: 0,
    });
    // Only the self-check was asked; nothing was read, ensured or ended.
    expect(h.rtc.calls.slice(calls).map((call) => call.operation)).toEqual([]);
    expect((await h.session(session.id)).state).toBe('live');
    expect(h.rtc.roomNames()).toEqual([orphan]);

    // Identified as LiveKit again: the same sweep ensures, and ends the orphan.
    h.rtc.setReadiness({ ready: true });
    expect(await h.reconciler.sweepRooms()).toMatchObject({
      skipped: null,
      ensured: 1,
      orphansEnded: 1,
    });
  });

  it('shares a self-check already running — Start’s — rather than asking twice', async () => {
    const answer = gate<RtcReadinessReport>();
    const check = jest.spyOn(h.rtc, 'check').mockReturnValue(answer.promise);
    const starting = start();
    await new Promise((resolve) => setImmediate(resolve));
    const sweeping = h.reconciler.sweepRooms();
    await new Promise((resolve) => setImmediate(resolve));
    expect(check).toHaveBeenCalledTimes(1);

    answer.open({ ready: true });
    expect((await starting).ok).toBe(true);
    expect(await sweeping).toMatchObject({ skipped: null });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('is asked by the boot pass, and not by a sweep skipped as in flight', async () => {
    const check = jest.spyOn(h.rtc, 'check');
    h.reconciler.onApplicationBootstrap();
    await h.reconciler.stop();
    expect(check).toHaveBeenCalledTimes(1);
    expect(h.readiness.current?.report).toEqual({ ready: true });

    const listing = h.rtc.hold('listRooms');
    const first = h.reconciler.sweepRooms();
    await listing.reached;
    expect(await h.reconciler.sweepRooms()).toMatchObject({ skipped: 'in_flight' });
    listing.release();
    await first;
    expect(check).toHaveBeenCalledTimes(2);
  });
});
