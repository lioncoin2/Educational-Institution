import { EVENT_SUBSCRIBER, type DomainEvent, type EventSubscriber } from '../../src/shared';
import { CommunityEvents } from '../../src/modules/communities/contracts/events';
import type { ApiResponse } from '../support/api-client';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import type { Frame, TestSocket } from '../support/realtime-client';

const communityFrames = (socket: TestSocket): Frame[] =>
  socket.frames.filter((frame) => frame.type.startsWith('community.'));

/**
 * Communities' frames over real sockets (P5): the application exactly as
 * the server runs it without a database — AppModule's wiring, RealtimeModule
 * importing CommunitiesModule, the real in-process bus from Communities'
 * journal to CommunitiesRealtimeRelay — driven over HTTP, received by a
 * `ws` client. Every frame is a hint the client answers over HTTP; the last
 * tests show HTTP carrying what a frame could not.
 */
describe('community frames over the realtime API', () => {
  let r: RealtimeApi;
  let admin: Account;
  let teacher: Account;
  let student: Account;
  let outsider: Account;

  beforeAll(async () => {
    r = await startRealtimeApi();
    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذة عائشة');
    student = await r.provision('student', 'STUDENT', 'مريم');
    outsider = await r.provision('outsider', 'STUDENT', 'زينب');
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  const call = (method: string, path: string, account: Account): Promise<ApiResponse> =>
    r.api.call(method, path, { token: account.token });

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;

  /** Every event published so far has been relayed (or found no one to tell). */
  const settled = () => r.communitiesRelay.idle();

  it('tells a member they were added, then of a lock and an unlock — and a stranger nothing', async () => {
    const s = await r.connect(student);
    const stranger = await r.connect(outsider);
    try {
      const communityId = await r.createCommunity(admin);
      await r.addToCommunity(admin, communityId, [student]);

      expect(await s.waitFor((f) => f.type === 'community.member.added')).toEqual({
        type: 'community.member.added',
        version: 1,
        eventId: expect.stringMatching(
          new RegExp(`^community\\.member\\.added:${communityId}:${student.id}:\\d+$`),
        ) as string,
        occurredAt: expect.any(String) as string,
        communityId,
        userId: student.id,
      });

      const locked = await r.setCommunityLocked(admin, communityId, true);
      expect(await s.waitFor((f) => f.type === 'community.locked')).toMatchObject({
        communityId,
        lifecycleVersion: locked.lifecycleVersion,
        eventId: `community.locked:${communityId}:${String(locked.lifecycleVersion)}`,
      });
      const unlocked = await r.setCommunityLocked(admin, communityId, false);
      expect(await s.waitFor((f) => f.type === 'community.unlocked')).toMatchObject({
        communityId,
        lifecycleVersion: unlocked.lifecycleVersion,
      });
      expect(unlocked.lifecycleVersion).toBe(3);
      await settled();

      expect(communityFrames(stranger)).toEqual([]);
      // Frames name ids and versions; the title is HTTP's to tell.
      expect(JSON.stringify(s.frames)).not.toContain('حلقة');
    } finally {
      await Promise.all([s.close(), stranger.close()]);
    }
  });

  it('tells the grantee — and nobody else — that their access changed, with the community’s id only', async () => {
    const communityId = await r.createCommunity(admin);
    await r.addToCommunity(admin, communityId, [teacher, student]);
    const t = await r.connect(teacher);
    const s = await r.connect(student);
    const a = await r.connect(admin);
    try {
      await r.grantCapabilities(admin, communityId, teacher.id, ['community.members.view']);

      const changed = await t.waitFor((f) => f.type === 'community.access.changed');
      expect(Object.keys(changed).sort()).toEqual([
        'communityId',
        'eventId',
        'occurredAt',
        'type',
        'version',
      ]);
      expect(changed.communityId).toBe(communityId);
      await settled();
      expect(communityFrames(s)).toEqual([]);
      expect(communityFrames(a)).toEqual([]);

      // The frame said only "look again": HTTP says what changed.
      const detail = await call('GET', `/communities/${communityId}`, teacher);
      expect((detail.body.me as { capabilities: string[] }).capabilities).toContain(
        'community.members.view',
      );
    } finally {
      await Promise.all([t.close(), s.close(), a.close()]);
    }
  });

  it('tells a removed member once, then nothing — and HTTP agrees after they reconnect', async () => {
    const communityId = await r.createCommunity(admin);
    await r.addToCommunity(admin, communityId, [teacher, student]);
    const chat = await call('GET', `/messaging/communities/${communityId}/conversation`, student);
    expect(chat.status).toBe(200);
    const s = await r.connect(student);
    const t = await r.connect(teacher);

    await r.removeFromCommunity(admin, communityId, student.id);
    expect(await s.waitFor((f) => f.type === 'community.member.removed')).toMatchObject({
      communityId,
      userId: student.id,
      reason: 'removed',
    });

    await r.setCommunityLocked(admin, communityId, true);
    // Barrier: a member has the lock, so its fan-out has run.
    await t.waitFor((f) => f.type === 'community.locked' && f.communityId === communityId);
    await settled();
    expect(communityFrames(s).map((frame) => frame.type)).toEqual(['community.member.removed']);

    // The app reconnects and re-reads: every read now says the same thing.
    s.kill();
    const again = await r.connect(student);
    try {
      const mine = await call('GET', '/communities?scope=mine', student);
      expect(mine.status).toBe(200);
      expect((mine.body.items as { id: string }[]).map((item) => item.id)).not.toContain(
        communityId,
      );
      const detail = await call('GET', `/communities/${communityId}`, student);
      expect({ status: detail.status, code: code(detail) }).toEqual({
        status: 404,
        code: 'communities.community_not_found',
      });
      const chatNow = await call(
        'GET',
        `/messaging/communities/${communityId}/conversation`,
        student,
      );
      expect({ status: chatNow.status, code: code(chatNow) }).toEqual({
        status: 404,
        code: 'messaging.conversation_not_found',
      });
      expect(communityFrames(again)).toEqual([]);
    } finally {
      await Promise.all([again.close(), t.close()]);
    }
  });

  it('recovers a lock missed while disconnected from GET /communities/:id — status and a newer version', async () => {
    const communityId = await r.createCommunity(admin);
    await r.addToCommunity(admin, communityId, [student]);
    const held = await call('GET', `/communities/${communityId}`, student);
    expect(held.body).toMatchObject({ status: 'OPEN', lifecycleVersion: 1 });

    const s = await r.connect(student);
    s.kill(); // the network drops
    await r.setCommunityLocked(admin, communityId, true);
    await settled();

    const back = await r.connect(student);
    try {
      expect(communityFrames(back)).toEqual([]); // the socket never replays
      const now = await call('GET', `/communities/${communityId}`, student);
      expect(now.body).toMatchObject({ status: 'LOCKED' });
      expect(now.body.lifecycleVersion as number).toBeGreaterThan(
        held.body.lifecycleVersion as number,
      );
    } finally {
      await back.close();
    }
  });

  it('gives a fact delivered twice the same frame — the same eventId, byte for byte', async () => {
    const seen: DomainEvent[] = [];
    const unsubscribe = r.api.app
      .get<EventSubscriber>(EVENT_SUBSCRIBER)
      .subscribe(CommunityEvents.communityLocked, (event) => {
        seen.push(event);
      });
    const communityId = await r.createCommunity(admin);
    await r.addToCommunity(admin, communityId, [student]);
    const s = await r.connect(student);
    try {
      await r.setCommunityLocked(admin, communityId, true);
      await s.waitFor((f) => f.type === 'community.locked' && f.communityId === communityId);
      const lock = seen.find(
        (event) => (event.payload as { communityId: string }).communityId === communityId,
      );
      await r.communitiesRelay.relay(lock!); // redelivery — e.g. a retrying outbox

      const [first, second] = await s.waitForCount('community.locked', 2);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    } finally {
      unsubscribe();
      await s.close();
    }
  });
});
