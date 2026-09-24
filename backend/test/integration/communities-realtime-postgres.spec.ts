import { sql } from 'drizzle-orm';

import type { ApiResponse } from '../support/api-client';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import type { Frame, TestSocket } from '../support/realtime-client';

const communityFrames = (socket: TestSocket): Frame[] =>
  socket.frames.filter((frame) => frame.type.startsWith('community.'));

/**
 * Community frames on the real stack:
 *
 *   PostgreSQL (the lock, the stint) → communities.* event → CommunitiesRealtimeRelay
 *   → Communities' membership contract, read from Postgres at delivery time
 *   → identity's directory (the view ceiling) → connection manager → WebSocket
 *   → a client that re-reads the community over HTTP, and catches up there
 *     on whatever it missed while disconnected.
 *
 * The production AppModule booted against a freshly migrated database; the
 * clients are real WebSocket connections.
 */
describeWithPostgres('community frames on Postgres, end to end', () => {
  let scratch: ScratchDatabase;
  let r: RealtimeApi;
  let admin: Account;
  let teacher: Account;
  let student: Account;
  let outsider: Account;

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  const call = (method: string, path: string, account: Account): Promise<ApiResponse> =>
    r.api.call(method, path, { token: account.token });

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;

  /** Everything published so far has been relayed (or found no one to tell). */
  const settled = () => r.communitiesRelay.idle();

  beforeAll(async () => {
    scratch = await scratchDatabase();
    r = await startRealtimeApi({ DATABASE_URL: scratch.url });
    admin = await r.provision('pg-admin', 'ADMIN', 'الإدارة');
    teacher = await r.provision('pg-teacher', 'TEACHER', 'الأستاذة');
    student = await r.provision('pg-student', 'STUDENT', 'مريم');
    outsider = await r.provision('pg-outsider', 'STUDENT', 'زينب');
  }, 120_000);

  afterAll(async () => {
    await r?.close();
    await scratch?.drop();
  });

  it('runs the whole scenario: added, locked, missed and caught up, removed, isolated', async () => {
    let s: TestSocket = await r.connect(student);
    const t = await r.connect(teacher);
    const stranger = await r.connect(outsider);

    // ── Added: the student hears it, with the stint's version from Postgres ─
    const communityId = await r.createCommunity(admin);
    await r.addToCommunity(admin, communityId, [teacher, student]);
    const [stint] = await rows<{ version: string | number }>(
      sql`select version from community_members
           where community_id = ${communityId} and user_id = ${student.id} and status = 'ACTIVE'`,
    );
    expect(await s.waitFor((f) => f.type === 'community.member.added')).toMatchObject({
      communityId,
      userId: student.id,
      eventId: `community.member.added:${communityId}:${student.id}:${Number(stint?.version)}`,
    });

    // ── Locked: both members hear it, at the version Postgres holds ────────
    await r.setCommunityLocked(admin, communityId, true);
    const [row] = await rows<{ status: string; lifecycle_version: string | number }>(
      sql`select status, lifecycle_version from communities where id = ${communityId}`,
    );
    expect(row?.status).toBe('LOCKED');
    for (const socket of [s, t]) {
      expect(await socket.waitFor((f) => f.type === 'community.locked')).toMatchObject({
        communityId,
        lifecycleVersion: Number(row?.lifecycle_version),
      });
    }

    // ── The student drops off; the unlock is missed, and caught up over HTTP ─
    const held = Number(row?.lifecycle_version);
    s.kill();
    await r.setCommunityLocked(admin, communityId, false);
    await t.waitFor((f) => f.type === 'community.unlocked');
    s = await r.connect(student);
    const caughtUp = await call('GET', `/communities/${communityId}`, student);
    expect(caughtUp.status).toBe(200);
    expect(caughtUp.body).toMatchObject({ status: 'OPEN' });
    expect(caughtUp.body.lifecycleVersion as number).toBeGreaterThan(held);
    expect(communityFrames(s)).toEqual([]); // the socket never replays

    // ── Removed: told once; then nothing, and every HTTP read agrees ───────
    await r.removeFromCommunity(admin, communityId, student.id);
    expect(await s.waitFor((f) => f.type === 'community.member.removed')).toMatchObject({
      communityId,
      userId: student.id,
      reason: 'removed',
    });
    await r.setCommunityLocked(admin, communityId, true);
    await t.waitFor((f) => f.type === 'community.locked' && f.lifecycleVersion === held + 2);
    await settled();
    expect(communityFrames(s).map((frame) => frame.type)).toEqual(['community.member.removed']);

    s.kill();
    s = await r.connect(student);
    const mine = await call('GET', '/communities?scope=mine', student);
    expect((mine.body.items as { id: string }[]).map((item) => item.id)).not.toContain(communityId);
    const detail = await call('GET', `/communities/${communityId}`, student);
    expect({ status: detail.status, code: code(detail) }).toEqual({
      status: 404,
      code: 'communities.community_not_found',
    });
    const chat = await call('GET', `/messaging/communities/${communityId}/conversation`, student);
    expect({ status: chat.status, code: code(chat) }).toEqual({
      status: 404,
      code: 'messaging.conversation_not_found',
    });

    // ── Someone who never belonged saw none of it ──────────────────────────
    expect(communityFrames(stranger)).toEqual([]);

    await Promise.all([s.close(), t.close(), stranger.close()]);
  });

  it('tells each side of a transfer, and a grantee, that their access changed — nobody else', async () => {
    const communityId = await r.createCommunity(admin, 'حلقة الحفظ');
    await r.addToCommunity(admin, communityId, [teacher, student]);
    const a = await r.connect(admin);
    const t = await r.connect(teacher);
    const s = await r.connect(student);

    await r.grantCapabilities(admin, communityId, teacher.id, ['community.lock']);
    await t.waitFor((f) => f.type === 'community.access.changed' && f.communityId === communityId);
    const transferred = await r.api.call('PUT', `/communities/${communityId}/owner`, {
      token: admin.token,
      body: { userId: teacher.id },
    });
    expect(transferred.status).toBe(200);
    await a.waitFor((f) => f.type === 'community.access.changed' && f.communityId === communityId);
    await t.waitForCount('community.access.changed', 2);
    await settled();

    expect(communityFrames(s)).toEqual([]);
    const [ownerNow] = await rows<{ user_id: string }>(
      sql`select user_id from community_members
           where community_id = ${communityId} and standing = 'OWNER'`,
    );
    expect(ownerNow?.user_id).toBe(teacher.id);
    await Promise.all([a.close(), t.close(), s.close()]);
  });
});
