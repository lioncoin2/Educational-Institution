import { RATE_LIMITER, type RateLimiter } from '../../src/shared';
import { ATTENDANCE_SNAPSHOT_POLICY } from '../../src/modules/attendance/application/attendance-policy';
import { RTC_PROVIDER } from '../../src/modules/live/domain/rtc-provider';
import type { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * Attendance over HTTP (attendance.md §15.1): one authenticated route that
 * records a snapshot on a press. The edge asks only for an account; the
 * decision is the use case's community-standing gate. A press returns the
 * header view — the recorder named, never the participant list — 201 the first
 * time and 200 on an idempotent replay. The booted app runs in mock mode, so a
 * freshly started session observes an empty, valid presence (counts zero).
 */
describe('attendance API (recording snapshots)', () => {
  let r: RealtimeApi;
  let host: Account; // the community owner, the session host, the recorder
  let member: Account; // a community member with no recording standing
  let outsider: Account; // not a member of the community at all
  let communityId: string;
  let sessionId: string;
  let rtc: FakeRtcProvider; // the mock-mode media provider the observation reads
  let limiter: RateLimiter; // the real in-memory limiter the use case charges

  beforeAll(async () => {
    r = await startRealtimeApi();
    host = r.owner; // OWNER: holds communities.create and live.moderate
    member = await r.provision('teacher', 'TEACHER', 'الأستاذة عائشة');
    outsider = await r.provision('student', 'STUDENT', 'مريم');
    communityId = await r.createCommunity(host, 'حلقة الحضور');
    await r.addToCommunity(host, communityId, [member]);
    const started = await r.api.call('POST', `/live/communities/${communityId}/sessions`, {
      token: host.token,
    });
    if (started.status !== 201) throw new Error(`start session: ${started.status} ${started.raw}`);
    sessionId = started.body.id as string;

    // The same instances the running app wired: RTC_OBSERVER is the fake
    // provider (useExisting RTC_PROVIDER) the observation reads, and the
    // rate limiter is the global in-memory one the use case charges.
    rtc = r.api.app.get<FakeRtcProvider>(RTC_PROVIDER, { strict: false });
    limiter = r.api.app.get<RateLimiter>(RATE_LIMITER, { strict: false });
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  function record(account: Account | undefined, liveSessionId: string, body: unknown) {
    return r.api.call('POST', `/attendance/live-sessions/${liveSessionId}/snapshots`, {
      token: account?.token,
      body,
    });
  }

  it('records a snapshot (201) as the header view — the recorder named, no participant data', async () => {
    const response = await record(host, sessionId, { clientRequestId: 'press_AAAAAAAA' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      communityId,
      liveSessionId: sessionId,
      recordedBy: { userId: host.id, displayName: 'Owner' },
      observationRule: 'provider_registry_v1',
      observationStartedAt: expect.any(String),
      observedAt: expect.any(String),
      recordedAt: expect.any(String),
      connectedCount: 0,
      connectingCount: 0,
    });
    // The header only: the entries are paged apart, never returned by a press.
    expect(response.body).not.toHaveProperty('entries');
    expect(response.body).not.toHaveProperty('participants');
    // Instants are ISO-8601.
    const recordedAt = response.body.recordedAt as string;
    expect(new Date(recordedAt).toISOString()).toBe(recordedAt);
  });

  it('replays the same key (200) with an identical body — idempotent', async () => {
    const first = await record(host, sessionId, { clientRequestId: 'press_REPLAY01' });
    expect(first.status).toBe(201);

    const again = await record(host, sessionId, { clientRequestId: 'press_REPLAY01' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
  });

  it('refuses an unauthenticated press (401)', async () => {
    const response = await record(undefined, sessionId, { clientRequestId: 'press_NOAUTH01' });
    expect(response.status).toBe(401);
  });

  it('rejects a missing clientRequestId (400, the transport pipe)', async () => {
    const response = await record(host, sessionId, {});
    expect(response.status).toBe(400);
  });

  it('rejects an unknown body field (400, whitelist) — the recorder is never a client claim', async () => {
    const response = await record(host, sessionId, {
      clientRequestId: 'press_EXTRA001',
      communityId: 'c-forged',
      recordedBy: 'someone-else',
    });
    expect(response.status).toBe(400);
  });

  it('rejects a malformed clientRequestId (422, from the domain) — before any lookup or charge', async () => {
    const response = await record(host, sessionId, { clientRequestId: 'short' });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      kind: 'validation',
      code: 'attendance.client_request_id_invalid',
    });
  });

  it('answers 404 for an unknown session — never revealing whether it exists', async () => {
    const response = await record(host, 'live-session-does-not-exist', {
      clientRequestId: 'press_UNKNOWN1',
    });
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'attendance.session_not_found' });
  });

  it('answers 404 for a caller with no standing in the community — the same masked not-found', async () => {
    const response = await record(outsider, sessionId, { clientRequestId: 'press_OUTSIDE1' });
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'attendance.session_not_found' });
  });

  it('answers 403 for a member who holds no recording standing', async () => {
    const response = await record(member, sessionId, { clientRequestId: 'press_MEMBER01' });
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'attendance.not_allowed' });
  });

  it('answers 503 observation_unavailable when the provider cannot be read — authorized, nothing stored', async () => {
    // A press that reaches observation but the provider is unreadable. 503 with
    // this code is returned only after the key is validated, the session
    // described, the recorder authorized, the session found live and the rate
    // charged — so the code itself proves the request reached observation.
    await limiter.reset(host.id, ATTENDANCE_SNAPSHOT_POLICY);
    rtc.setUnavailable(true); // every listParticipants throws RtcUnavailableError
    const refused = await record(host, sessionId, { clientRequestId: 'press_UNAVAIL1' });
    rtc.setUnavailable(false);

    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({
      kind: 'unavailable',
      code: 'attendance.observation_unavailable',
    });

    // Nothing was stored: retrying the same key once the provider is back
    // creates a fresh snapshot (201), not an idempotent replay (200) — a replay
    // would mean the failed press had persisted. No audit or event is emitted on
    // this path either; the use-case spec asserts that directly.
    const retried = await record(host, sessionId, { clientRequestId: 'press_UNAVAIL1' });
    expect(retried.status).toBe(201);
  });

  it('answers 429 too_many_snapshots with retryAfterSeconds — charged before the observation', async () => {
    // Drive the real limiter (attendance.snapshot.user, limit 6) to its ceiling
    // with valid presses from a clean window; the next press is refused. The
    // rate is charged before the observation, so a 429 never reaches
    // LIVE_PRESENCE — nothing else answers 429, so the status proves it.
    await limiter.reset(host.id, ATTENDANCE_SNAPSHOT_POLICY);
    for (let press = 0; press < 6; press += 1) {
      const allowed = await record(host, sessionId, { clientRequestId: `press_LIMIT00${press}` });
      expect(allowed.status).toBe(201);
    }

    const refused = await record(host, sessionId, { clientRequestId: 'press_LIMIT999' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({
      kind: 'rate_limited',
      code: 'attendance.too_many_snapshots',
    });
    expect(
      (refused.body.error as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds,
    ).toBeGreaterThan(0);

    await limiter.reset(host.id, ATTENDANCE_SNAPSHOT_POLICY); // leave the window clean
  });

  // Last: this ends the shared session, so no later case may rely on it running.
  it('answers 412 once the session is no longer running', async () => {
    const ended = await r.api.call('POST', `/live/sessions/${sessionId}/end`, {
      token: host.token,
    });
    expect(ended.status).toBe(200);

    const response = await record(host, sessionId, { clientRequestId: 'press_ENDED001' });
    expect(response.status).toBe(412);
    expect(response.body.error).toMatchObject({ code: 'attendance.session_not_live' });
  });
});
