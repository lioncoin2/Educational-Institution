import { Logger } from '@nestjs/common';

import { err, failure, type Result } from '../../../shared';
import type { AuthorizationService } from '../../identity/contracts';
import {
  HOST,
  SESSION,
  allowAll,
  liveHarness,
  pending,
  principalOf,
} from '../../../../test/support/live-harness';
import { LISTENER, SPEAKER } from '../domain/rtc-provider';
import { MAX_CONCURRENT_SPEAKERS } from '../domain/speaker-request';

const denyAll: AuthorizationService = {
  can: () => false,
  authorize: () => err(failure('forbidden', 'denied', 'no')),
};

const host = principalOf(HOST, 'TEACHER');

const unwrapOk = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};
const codeOf = <T>(result: Result<T>) => (result.ok ? 'ok' : result.error.code);

describe('granting the floor', () => {
  it('refuses a caller without the moderate permission, before looking anything up', async () => {
    const h = liveHarness({ authorization: denyAll, requests: [pending('req-1', 'student-1')] });
    const lookup = jest.spyOn(h.requests, 'findById');
    expect((await h.moderate.grant({ principal: host, requestId: 'req-1' })).ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(h.rtc.capabilityChanges).toHaveLength(0);
  });

  it('promotes on the wire with the FULL permission set, and records the decision once', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    const result = unwrapOk(await h.moderate.grant({ principal: host, requestId: 'req-1' }));

    expect(result.request).toMatchObject({ id: 'req-1', state: 'granted' });
    expect(result.media).toBe('applied');
    expect(h.rtc.capabilityChanges).toEqual([
      { roomName: SESSION, identity: 'student-1', capabilities: SPEAKER },
    ]);
    expect(h.audit.actions()).toEqual(['live.speaker.granted']);
    expect(h.audit.entries[0]).toMatchObject({
      actorUserId: HOST,
      resourceType: 'live.session',
      resourceId: SESSION,
      metadata: { targetUserId: 'student-1', requestId: 'req-1', media: 'applied' },
    });
    expect(h.eventNames()).toEqual(['live.speaker.granted']);
    expect(h.requests.moderation.map((action) => action.type)).toEqual(['grant_speaker']);
  });

  it('is idempotent: granting a granted hand answers 200 unchanged and records nothing more', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    const again = unwrapOk(await h.moderate.grant({ principal: host, requestId: 'req-1' }));
    expect(again).toMatchObject({ request: { state: 'granted' }, media: 'unchanged' });
    expect(h.rtc.capabilityChanges).toHaveLength(1);
    expect(h.audit.entries).toHaveLength(1);
    expect(h.events.published).toHaveLength(1);
  });

  it(`never lets more than ${MAX_CONCURRENT_SPEAKERS} hold the floor, even when granted all at once`, async () => {
    const hands = Array.from({ length: 7 }, (_, i) => pending(`req-${i}`, `student-${i}`));
    const h = liveHarness({ requests: hands });
    const results = await Promise.all(
      hands.map((hand) => h.moderate.grant({ principal: host, requestId: hand.id })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(MAX_CONCURRENT_SPEAKERS);
    expect(results.filter((result) => codeOf(result) === 'live.speaker_slots_full')).toHaveLength(
      7 - MAX_CONCURRENT_SPEAKERS,
    );
    expect(await h.requests.granted(SESSION)).toHaveLength(MAX_CONCURRENT_SPEAKERS);
  });

  it('reports the media plane honestly: not connected, or the provider unreachable', async () => {
    const absent = liveHarness({ requests: [pending('req-1', 'student-1')] });
    absent.rtc.markAbsent(SESSION, 'student-1');
    expect(
      unwrapOk(await absent.moderate.grant({ principal: host, requestId: 'req-1' })).media,
    ).toBe('not_connected');

    const down = liveHarness({ requests: [pending('req-1', 'student-1')] });
    down.rtc.unavailable = true;
    const result = unwrapOk(await down.moderate.grant({ principal: host, requestId: 'req-1' }));
    // Live's record is the truth; the provider catches up.
    expect(result).toMatchObject({ request: { state: 'granted' }, media: 'pending' });
    expect(down.convergence.size).toBe(1);
  });

  it('still audits and announces a grant the provider refused — the decision stands', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // A refusal is not an outage: a rejected key, say. The adapter has logged it.
    jest
      .spyOn(h.rtc, 'updateCapabilities')
      .mockRejectedValueOnce(new Error('The media provider refused updateCapabilities (401).'));

    const result = unwrapOk(await h.moderate.grant({ principal: host, requestId: 'req-1' }));
    expect(result).toMatchObject({ request: { state: 'granted' }, media: 'pending' });
    expect(h.audit.entries.map((entry) => entry.action)).toEqual(['live.speaker.granted']);
    expect(h.eventNames()).toEqual(['live.speaker.granted']);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('401');

    // …and the watch lands it once the provider takes it.
    await h.convergence.tick();
    expect(h.rtc.capabilityChanges).toEqual([
      { roomName: SESSION, identity: 'student-1', capabilities: SPEAKER },
    ]);
    logged.mockRestore();
  });

  it('refuses a hand that is no longer pending, and an unknown request', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    await h.lower.execute({ principal: principalOf('student-1', 'STUDENT'), sessionId: SESSION });
    expect(codeOf(await h.moderate.grant({ principal: host, requestId: 'req-1' }))).toBe(
      'live.invalid_transition',
    );
    expect(codeOf(await h.moderate.grant({ principal: host, requestId: 'nope' }))).toBe(
      'live.request_not_found',
    );
  });
});

describe('declining a hand', () => {
  it('passes over a pending hand without touching the media plane, audited under its own name', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    const result = unwrapOk(await h.moderate.decline({ principal: host, requestId: 'req-1' }));
    expect(result.request.state).toBe('declined');
    expect(h.rtc.capabilityChanges).toHaveLength(0);
    // Each act has its own audit action — a decline is never logged as a revoke.
    expect(h.audit.actions()).toEqual(['live.speaker.declined']);
    expect(h.eventNames()).toEqual(['live.speaker.declined']);
  });

  it('is idempotent, and refuses to decline a hand that already holds the floor', async () => {
    const h = liveHarness({
      requests: [pending('req-1', 'student-1'), pending('req-2', 'student-2')],
    });
    await h.moderate.decline({ principal: host, requestId: 'req-1' });
    expect(
      unwrapOk(await h.moderate.decline({ principal: host, requestId: 'req-1' })).request.state,
    ).toBe('declined');
    expect(h.audit.entries).toHaveLength(1);

    await h.moderate.grant({ principal: host, requestId: 'req-2' });
    expect(codeOf(await h.moderate.decline({ principal: host, requestId: 'req-2' }))).toBe(
      'live.invalid_transition',
    );
  });
});

describe('revoking the floor', () => {
  it('demotes to listener with the full set rather than removing anyone', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    const result = unwrapOk(await h.moderate.revoke({ principal: host, requestId: 'req-1' }));

    expect(result).toMatchObject({ request: { state: 'revoked' }, media: 'applied' });
    expect(h.rtc.capabilityChanges.at(-1)).toEqual({
      roomName: SESSION,
      identity: 'student-1',
      capabilities: LISTENER,
    });
    expect(h.rtc.removed).toHaveLength(0);
    expect(h.audit.actions()).toEqual(['live.speaker.granted', 'live.speaker.revoked']);
  });

  it('is idempotent, and refuses to revoke a hand that is only pending', async () => {
    const h = liveHarness({
      requests: [pending('req-1', 'student-1'), pending('req-2', 'student-2')],
    });
    await h.moderate.grant({ principal: host, requestId: 'req-1' });
    await h.moderate.revoke({ principal: host, requestId: 'req-1' });
    expect(unwrapOk(await h.moderate.revoke({ principal: host, requestId: 'req-1' })).media).toBe(
      'unchanged',
    );
    expect(h.audit.entries).toHaveLength(2);
    expect(codeOf(await h.moderate.revoke({ principal: host, requestId: 'req-2' }))).toBe(
      'live.invalid_transition',
    );
  });

  it('frees a speaker slot, so the next hand can be granted', async () => {
    const hands = Array.from({ length: MAX_CONCURRENT_SPEAKERS + 1 }, (_, i) =>
      pending(`req-${i}`, `student-${i}`),
    );
    const h = liveHarness({ requests: hands });
    for (const hand of hands.slice(0, MAX_CONCURRENT_SPEAKERS)) {
      await h.moderate.grant({ principal: host, requestId: hand.id });
    }
    const last = hands[MAX_CONCURRENT_SPEAKERS].id;
    expect(codeOf(await h.moderate.grant({ principal: host, requestId: last }))).toBe(
      'live.speaker_slots_full',
    );
    await h.moderate.revoke({ principal: host, requestId: 'req-0' });
    expect((await h.moderate.grant({ principal: host, requestId: last })).ok).toBe(true);
  });
});

/**
 * "May this user moderate THIS room?" — asked of identity's real authorization
 * service with its provisional rules (host-only moderation, Q1).
 */
describe('moderation is scoped to the room', () => {
  it('lets the host moderate their own room', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    expect((await h.moderate.grant({ principal: host, requestId: 'req-1' })).ok).toBe(true);
  });

  it('refuses a teacher who does not host this room, and changes nothing', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    const result = await h.moderate.grant({
      principal: principalOf('another-teacher', 'TEACHER'),
      requestId: 'req-1',
    });
    expect(codeOf(result)).toBe('identity.permission_denied');
    expect((await h.requests.findById('req-1'))?.state).toBe('pending');
    expect(h.rtc.capabilityChanges).toHaveLength(0);
    expect(h.audit.entries).toHaveLength(0);
  });

  it('refuses a student outright, before looking the request up', async () => {
    const h = liveHarness({ requests: [pending('req-1', 'student-1')] });
    const lookup = jest.spyOn(h.requests, 'findById');
    const result = await h.moderate.grant({
      principal: principalOf('student-1', 'STUDENT'),
      requestId: 'req-1',
    });
    expect(result.ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('treats a permissive policy as permissive — the rule lives in identity, not here', async () => {
    const h = liveHarness({ authorization: allowAll, requests: [pending('req-1', 'student-1')] });
    expect(
      (await h.moderate.grant({ principal: principalOf('anyone', 'TEACHER'), requestId: 'req-1' }))
        .ok,
    ).toBe(true);
  });
});
