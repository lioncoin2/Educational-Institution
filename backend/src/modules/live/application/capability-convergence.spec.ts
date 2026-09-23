import { Logger } from '@nestjs/common';

import {
  HOST,
  SESSION,
  liveHarness,
  pending,
  principalOf,
} from '../../../../test/support/live-harness';
import { LISTENER, SPEAKER } from '../domain/rtc-provider';
import { CONVERGENCE_TICK_MS, CONVERGENCE_WINDOW_MS } from './capability-convergence';

const host = principalOf(HOST, 'TEACHER');

/**
 * The 120-second join token must not make reconnection unreliable, and a
 * change of the floor must reach the media plane even when the person was
 * away or the provider was down. The watch re-applies each person's CURRENT
 * standing after a change, for as long as an older media token could still
 * be used — and never removes anyone.
 */
describe('capability convergence after the floor changes hands', () => {
  it('lands a grant made while the provider was down, once it is back', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    h.rtc.unavailable = true;
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    expect(h.rtc.capabilityChanges).toHaveLength(0);

    h.rtc.unavailable = false;
    await h.convergence.tick();
    expect(h.rtc.capabilityChanges).toEqual([
      { roomName: SESSION, identity: 'student-1', capabilities: SPEAKER },
    ]);
  });

  it('corrects a revoked speaker who comes back holding an older token, within one tick', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    // They drop off; the revoke finds them gone…
    h.rtc.markAbsent(SESSION, 'student-1');
    const revoked = await h.moderate.revoke({ principal: host, requestId: 'req-1' });
    expect(revoked.ok && revoked.value.media).toBe('not_connected');
    // …and they return with a token refreshed while they could still speak.
    h.rtc.markPresent(SESSION, 'student-1');
    h.clock.advance(CONVERGENCE_TICK_MS / 1000);
    await h.convergence.tick();
    expect(h.rtc.capabilityChanges.at(-1)).toEqual({
      roomName: SESSION,
      identity: 'student-1',
      capabilities: LISTENER,
    });
  });

  it('re-applies the CURRENT standing, not the one from the moment of the change', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    h.rtc.unavailable = true;
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    await h.moderate.revoke({ principal: host, requestId: 'req-1' });
    h.rtc.unavailable = false;
    await h.convergence.tick();
    // Granted, then revoked while unreachable: only the listener set is right now.
    expect(h.rtc.capabilityChanges.map((change) => change.capabilities)).toEqual([LISTENER]);
  });

  it('keeps watching for as long as an older media token could be used, then stops', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    expect(h.convergence.size).toBe(1);

    h.clock.advance((CONVERGENCE_WINDOW_MS - CONVERGENCE_TICK_MS) / 1000);
    await h.convergence.tick();
    expect(h.convergence.size).toBe(1);

    h.clock.advance((2 * CONVERGENCE_TICK_MS) / 1000);
    await h.convergence.tick();
    expect(h.convergence.size).toBe(0);
    // LiveKit's refreshed tokens live ten minutes; the watch outlives them.
    expect(CONVERGENCE_WINDOW_MS).toBeGreaterThan(10 * 60_000);
  });

  it('never removes anyone — a legitimate participant keeps their place', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    await h.moderate.revoke({ principal: host, requestId: 'req-1' });
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(CONVERGENCE_TICK_MS / 1000);
      await h.convergence.tick();
    }
    expect(h.rtc.removed).toHaveLength(0);
    expect(h.rtc.muted).toHaveLength(0);
  });

  it('keeps the host on the microphone hosting gives them, even when their own hand is revoked', async () => {
    const h = liveHarness({ requests: [pending('req-h', HOST)] });
    await h.moderate.grant({ principal: host, requestId: 'req-h' });
    const revoked = await h.moderate.revoke({ principal: host, requestId: 'req-h' });
    expect(revoked.ok && revoked.value.media).toBe('applied');
    // Standing is recomputed, not assumed from the act: the host still speaks.
    expect(h.rtc.capabilityChanges.map((change) => change.capabilities)).toEqual([
      SPEAKER,
      SPEAKER,
    ]);
  });

  it('never lets a failing lookup escape a tick — the watch stays and lands later', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    h.rtc.unavailable = true;
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    h.rtc.unavailable = false;

    // The store behind live's records fails once (a lost connection, in Postgres).
    jest.spyOn(h.sessions, 'findById').mockRejectedValueOnce(new Error('connection terminated'));
    await expect(h.convergence.tick()).resolves.toBeUndefined();
    expect(h.convergence.size).toBe(1);
    expect(logged.mock.calls).toEqual([
      [
        { sessionId: SESSION, err: { name: 'Error' } },
        'could not apply a participant’s live capabilities; retrying',
      ],
    ]);

    await h.convergence.tick();
    expect(h.rtc.capabilityChanges).toEqual([
      { roomName: SESSION, identity: 'student-1', capabilities: SPEAKER },
    ]);
    logged.mockRestore();
  });

  it('stops watching a session that is no longer live', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    const session = await h.sessions.findById(SESSION as never);
    await h.sessions.save({ ...(session as NonNullable<typeof session>), state: 'ended' });
    const before = h.rtc.capabilityChanges.length;
    await h.convergence.tick();
    expect(h.convergence.size).toBe(0);
    expect(h.rtc.capabilityChanges).toHaveLength(before);
  });
});
