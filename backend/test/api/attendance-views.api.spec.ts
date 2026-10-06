import { LiveReconciler } from '../../src/modules/live/application/live-reconciler';
import { ProtectLiveSessions } from '../../src/modules/live/application/protect-live-sessions';
import {
  RTC_PROVIDER,
  type RtcCapabilities,
  type RtcParticipantObservation,
} from '../../src/modules/live/domain/rtc-provider';
import type { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * Attendance read routes over HTTP (attendance.md §15.1): the community
 * snapshot list, one snapshot's header, and its participants. The edge is
 * `@Authenticated()`; the decision is community standing (`AttendanceAccess`),
 * with the §11.3 host/recorder fallback. Names are resolved at view time
 * (§6.3); no email, no "present", ever. Reads never touch Live, so snapshots
 * stay readable after the session ends.
 */
const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

function participant(identity: string, state: 'active' | 'joining'): RtcParticipantObservation {
  return {
    identity,
    state,
    standard: true,
    joinedAt: new Date(1_000),
    publishing: [],
    capabilities: LISTENER,
  };
}

// Account-shaped but never provisioned: the directory cannot resolve it → null name.
const GHOST = 'ghost-user-00000000';

describe('attendance view API (reading snapshots)', () => {
  let r: RealtimeApi;
  let rtc: FakeRtcProvider;

  let host: Account; // community owner + session host + recorder; views via ownership
  let viewer: Account; // member holding community.attendance.view
  let member: Account; // member holding no attendance act
  let outsider: Account; // not a member of the community
  let recorder2: Account; // member holding community.attendance.record only (no view act)
  let attendeeA: Account;
  let attendeeB: Account;
  let attendeeC: Account;

  let communityId: string;
  let sessionId: string;
  let snapWithParticipants: string; // oldest
  let snap1: string;
  let snap2: string;
  let snapByRecorder2: string; // newest

  beforeAll(async () => {
    r = await startRealtimeApi();
    // Scripted presence must not be swept away mid-test (the live.api.spec convention).
    await r.api.app.get(LiveReconciler, { strict: false }).stop();
    await r.api.app.get(ProtectLiveSessions, { strict: false }).onModuleDestroy();
    rtc = r.api.app.get<FakeRtcProvider>(RTC_PROVIDER, { strict: false });

    host = r.owner;
    viewer = await r.provision('viewer', 'TEACHER', 'المشرفة');
    member = await r.provision('member', 'TEACHER', 'عضو');
    outsider = await r.provision('outsider', 'STUDENT', 'غريب');
    recorder2 = await r.provision('recorder2', 'TEACHER', 'المسجّل الثاني');
    attendeeA = await r.provision('attendee-a', 'STUDENT', 'أحمد');
    attendeeB = await r.provision('attendee-b', 'STUDENT', 'بلال');
    attendeeC = await r.provision('attendee-c', 'STUDENT', 'خالد');

    communityId = await r.createCommunity(host, 'حلقة العرض');
    await r.addToCommunity(host, communityId, [viewer, member, recorder2]);
    await r.grantCapabilities(host, communityId, viewer.id, ['community.attendance.view']);
    await r.grantCapabilities(host, communityId, recorder2.id, ['community.attendance.record']);

    const started = await r.api.call('POST', `/live/communities/${communityId}/sessions`, {
      token: host.token,
    });
    if (started.status !== 201) throw new Error(`start session: ${started.status} ${started.raw}`);
    sessionId = started.body.id as string;
    const room = `live-${sessionId}`;

    const record = async (account: Account, clientRequestId: string): Promise<string> => {
      const response = await r.api.call(
        'POST',
        `/attendance/live-sessions/${sessionId}/snapshots`,
        {
          token: account.token,
          body: { clientRequestId },
        },
      );
      if (response.status !== 201) throw new Error(`record: ${response.status} ${response.raw}`);
      return response.body.id as string;
    };

    // One snapshot with participants: 3 connected (A, B, ghost) and 1 connecting (C).
    rtc.observe(room, [
      participant(attendeeA.id, 'active'),
      participant(attendeeB.id, 'active'),
      participant(GHOST, 'active'),
      participant(attendeeC.id, 'joining'),
    ]);
    snapWithParticipants = await record(host, 'press_PART0001');

    // Three more empty snapshots, so the community list has four (newest last).
    rtc.observe(room, []);
    snap1 = await record(host, 'press_LIST0001');
    snap2 = await record(host, 'press_LIST0002');
    snapByRecorder2 = await record(recorder2, 'press_REC200001');
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  function listSnapshots(account: Account | undefined, qs = '') {
    return r.api.call('GET', `/attendance/communities/${communityId}/snapshots${qs}`, {
      token: account?.token,
    });
  }
  function getSnapshot(account: Account | undefined, id: string) {
    return r.api.call('GET', `/attendance/snapshots/${id}`, { token: account?.token });
  }
  function getParticipants(account: Account | undefined, id: string, qs = '') {
    return r.api.call('GET', `/attendance/snapshots/${id}/participants${qs}`, {
      token: account?.token,
    });
  }
  const idsOf = (body: Record<string, unknown>) =>
    (body.items as Array<{ id: string }>).map((item) => item.id);

  describe('the community snapshot list', () => {
    it('returns the community’s snapshots newest first, headers only', async () => {
      const response = await listSnapshots(host);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['items', 'nextCursor']);
      expect(idsOf(response.body)).toEqual([snapByRecorder2, snap2, snap1, snapWithParticipants]);
      expect(response.body.nextCursor).toBeNull(); // four items, default limit 50
      // A header view — the recorder named, no participant list.
      const first = (response.body.items as Array<Record<string, unknown>>)[0];
      expect(first).toMatchObject({
        recordedBy: { userId: recorder2.id, displayName: 'المسجّل الثاني' },
      });
      expect(first).not.toHaveProperty('entries');
      expect(first).not.toHaveProperty('participants');
    });

    it('keyset-pages: first page carries a cursor, the last page’s is null', async () => {
      const page1 = await listSnapshots(host, '?limit=2');
      expect(page1.status).toBe(200);
      expect(idsOf(page1.body)).toEqual([snapByRecorder2, snap2]);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await listSnapshots(
        host,
        `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor as string)}`,
      );
      expect(idsOf(page2.body)).toEqual([snap1, snapWithParticipants]);
      expect(page2.body.nextCursor).toBeNull();
    });

    it('clamps an oversized limit to 200 rather than refusing it (§7)', async () => {
      const response = await listSnapshots(host, '?limit=1000000');
      expect(response.status).toBe(200);
      expect(idsOf(response.body)).toHaveLength(4);
    });

    it('rejects a non-integer limit with 400 (the transport pipe)', async () => {
      expect((await listSnapshots(host, '?limit=ten')).status).toBe(400);
    });

    it('filters to one live session, and yields an empty page for a foreign session', async () => {
      const mine = await listSnapshots(host, `?liveSessionId=${sessionId}`);
      expect(idsOf(mine.body)).toEqual([snapByRecorder2, snap2, snap1, snapWithParticipants]);

      const foreign = await listSnapshots(host, '?liveSessionId=live-no-such-session');
      expect(foreign.status).toBe(200);
      expect(foreign.body).toEqual({ items: [], nextCursor: null });
    });

    it('rejects an invalid cursor with 422 attendance.cursor_invalid', async () => {
      expect((await listSnapshots(host, '?cursor=forged')).status).toBe(422);
      const long = await listSnapshots(host, `?cursor=${'x'.repeat(600)}`);
      expect({ status: long.status, code: (long.body.error as { code: string }).code }).toEqual({
        status: 422,
        code: 'attendance.cursor_invalid',
      });
    });

    it('answers 404 community_not_found for an unknown community or a caller with no standing', async () => {
      const unknown = await r.api.call(
        'GET',
        `/attendance/communities/no-such-community/snapshots`,
        {
          token: host.token,
        },
      );
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toMatchObject({ code: 'attendance.community_not_found' });

      const nonMember = await listSnapshots(outsider);
      expect(nonMember.status).toBe(404);
      expect(nonMember.body.error).toMatchObject({ code: 'attendance.community_not_found' });
    });

    it('answers 403 not_allowed for a member who holds no attendance act', async () => {
      const response = await listSnapshots(member);
      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({ code: 'attendance.not_allowed' });
    });

    it('lets a holder of community.attendance.view list the community', async () => {
      const response = await listSnapshots(viewer);
      expect(response.status).toBe(200);
      expect(idsOf(response.body)).toHaveLength(4);
    });

    it('lets a recorder without the view act list a session they recorded in — the §11.3 fallback', async () => {
      // With the session filter, recorder2 (recorded in it) passes via recordedOrHostedInSession.
      const scoped = await listSnapshots(recorder2, `?liveSessionId=${sessionId}`);
      expect(scoped.status).toBe(200);
      expect(idsOf(scoped.body)).toEqual([snapByRecorder2, snap2, snap1, snapWithParticipants]);

      // Without a session to stand on, the same recorder has no list standing.
      const unscoped = await listSnapshots(recorder2);
      expect(unscoped.status).toBe(403);
      expect(unscoped.body.error).toMatchObject({ code: 'attendance.not_allowed' });
    });
  });

  describe('one snapshot', () => {
    it('returns the header to a viewer (counts, recorder named, no entries)', async () => {
      const response = await getSnapshot(viewer, snapWithParticipants);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: snapWithParticipants,
        communityId,
        liveSessionId: sessionId,
        recordedBy: { userId: host.id, displayName: 'Owner' },
        observationRule: 'provider_registry_v1',
        connectedCount: 3,
        connectingCount: 1,
      });
      expect(response.body).not.toHaveProperty('entries');
    });

    it('answers 404 snapshot_not_found for an unknown id', async () => {
      const response = await getSnapshot(host, 'no-such-snapshot');
      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({ code: 'attendance.snapshot_not_found' });
    });

    it('masks a forbidden snapshot as the same 404 as unknown', async () => {
      const forbidden = await getSnapshot(member, snapWithParticipants);
      expect(forbidden.status).toBe(404);
      expect(forbidden.body.error).toMatchObject({ code: 'attendance.snapshot_not_found' });
      expect((await getSnapshot(outsider, snapWithParticipants)).status).toBe(404);
    });

    it('lets a recorder of the session view a snapshot without the view act — the §11.3 fallback', async () => {
      const response = await getSnapshot(recorder2, snapWithParticipants);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: snapWithParticipants });
    });
  });

  describe('the participants list', () => {
    it('returns participants with names resolved, and null for an unknown account', async () => {
      const response = await getParticipants(host, snapWithParticipants);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['items', 'nextCursor']);
      const items = response.body.items as Array<{
        userId: string;
        displayName: string | null;
        connection: string;
      }>;
      expect(items).toHaveLength(4);
      const byId = new Map(items.map((p) => [p.userId, p]));
      expect(byId.get(attendeeA.id)).toEqual({
        userId: attendeeA.id,
        displayName: 'أحمد',
        connection: 'CONNECTED',
      });
      expect(byId.get(attendeeC.id)).toEqual({
        userId: attendeeC.id,
        displayName: 'خالد',
        connection: 'CONNECTING',
      });
      expect(byId.get(GHOST)).toEqual({
        userId: GHOST,
        displayName: null,
        connection: 'CONNECTED',
      });
      // Account ids ascending (keyset order), no email anywhere.
      expect(items.map((p) => p.userId)).toEqual([...items.map((p) => p.userId)].sort());
      expect(JSON.stringify(response.body)).not.toContain('@institution.test');
    });

    it('keyset-pages participants, first cursor then null, covering the whole set', async () => {
      const page1 = await getParticipants(host, snapWithParticipants, '?limit=2');
      expect((page1.body.items as unknown[]).length).toBe(2);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await getParticipants(
        host,
        snapWithParticipants,
        `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor as string)}`,
      );
      expect(page2.body.nextCursor).toBeNull();
      const seen = [
        ...(page1.body.items as Array<{ userId: string }>),
        ...(page2.body.items as Array<{ userId: string }>),
      ].map((p) => p.userId);
      expect(new Set(seen)).toEqual(new Set([attendeeA.id, attendeeB.id, attendeeC.id, GHOST]));
    });

    it('filters by connection state', async () => {
      const connected = await getParticipants(host, snapWithParticipants, '?connection=CONNECTED');
      expect(
        new Set((connected.body.items as Array<{ userId: string }>).map((p) => p.userId)),
      ).toEqual(new Set([attendeeA.id, attendeeB.id, GHOST]));
      const connecting = await getParticipants(
        host,
        snapWithParticipants,
        '?connection=CONNECTING',
      );
      expect((connecting.body.items as Array<{ userId: string }>).map((p) => p.userId)).toEqual([
        attendeeC.id,
      ]);
    });

    it('still lists a since-deactivated account (the record is historical, §6.3)', async () => {
      await r.api.call('POST', `/admin/users/${attendeeB.id}/status`, {
        token: host.token,
        body: { status: 'SUSPENDED' },
      });
      const response = await getParticipants(host, snapWithParticipants);
      const ids = (response.body.items as Array<{ userId: string }>).map((p) => p.userId);
      expect(ids).toContain(attendeeB.id);
    });

    it('rejects an invalid participant cursor with 422 attendance.cursor_invalid', async () => {
      // The entry cursor is base64url of an account id; a value that decodes to
      // nothing does not decode to a cursor (§15.2). ('forged' would be a valid,
      // if meaningless, opaque id cursor — the entry cursor has no structure.)
      const response = await getParticipants(host, snapWithParticipants, '?cursor=!!!!');
      expect(response.status).toBe(422);
      expect(response.body.error).toMatchObject({ code: 'attendance.cursor_invalid' });
    });

    it('masks a forbidden snapshot’s participants as the same 404 as unknown', async () => {
      const forbidden = await getParticipants(member, snapWithParticipants);
      expect(forbidden.status).toBe(404);
      expect(forbidden.body.error).toMatchObject({ code: 'attendance.snapshot_not_found' });
    });
  });

  describe('access and persistence', () => {
    it('refuses an unauthenticated read on every route (401)', async () => {
      expect((await listSnapshots(undefined)).status).toBe(401);
      expect((await getSnapshot(undefined, snapWithParticipants)).status).toBe(401);
      expect((await getParticipants(undefined, snapWithParticipants)).status).toBe(401);
    });

    it('keeps snapshots readable after the live session has ended', async () => {
      const ended = await r.api.call('POST', `/live/sessions/${sessionId}/end`, {
        token: host.token,
      });
      expect(ended.status).toBe(200);

      const single = await getSnapshot(viewer, snapWithParticipants);
      expect(single.status).toBe(200);
      const list = await listSnapshots(host);
      expect(idsOf(list.body)).toHaveLength(4);
      const parts = await getParticipants(host, snapWithParticipants);
      expect((parts.body.items as unknown[]).length).toBe(4);
    });
  });
});
