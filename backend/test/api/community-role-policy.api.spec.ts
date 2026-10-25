import { LiveReconciler } from '../../src/modules/live/application/live-reconciler';
import type { ApiResponse } from '../support/api-client';
import { LogCapture } from '../support/log-capture';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * Owner policy revision 2026-10-25 (ADR 0044), decisions A and B, over HTTP:
 *
 *   A. The owner, teachers, administration and supervisors may START a
 *      broadcast — through the permission the COMMUNITY gives them (its owner's
 *      standing, or a `community.live.start` grant there). A general
 *      institutional role never stands in for that missing permission.
 *   B. Teachers, administrators and supervisors may ADD members only to the
 *      groups and channels they are permitted to manage there (owner standing
 *      or a `community.members.invite` grant) — oversight still never adds.
 *
 * Every refusal is the server's; nothing here depends on what the app shows.
 */
describe('community role policy (ADR 0044 A, B)', () => {
  let r: RealtimeApi;
  let owner: Account; // the institution's OWNER
  let admin: Account;
  let teacher: Account;
  let supervisor: Account;
  let assistant: Account;
  let student: Account;
  let newcomer: Account;
  /** Created — and so owned — by the admin; the others are plain members. */
  let managed: string;
  /** Created by the institution owner; the supervisor is a plain member. */
  let elsewhere: string;
  /** Created by the institution owner; none of the others is a member. */
  let foreign: string;

  beforeAll(async () => {
    r = await startRealtimeApi(
      { LIVEKIT_API_SECRET: 'development-only-secret', LIVE_MEDIA_PROVIDER: '' },
      { logger: new LogCapture() },
    );
    await r.api.app.get(LiveReconciler, { strict: false }).stop();
    owner = r.owner;
    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذة حفصة');
    supervisor = await r.provision('supervisor', 'SUPERVISOR', 'المشرفة خديجة');
    assistant = await r.provision('assistant', 'ASSISTANT_TEACHER', 'المساعدة رقية');
    student = await r.provision('student', 'STUDENT', 'مريم');
    newcomer = await r.provision('newcomer', 'STUDENT', 'زينب');

    managed = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, managed, [owner, teacher, supervisor, assistant, student]);
    elsewhere = await r.createCommunity(owner, 'حلقة الفجر');
    await r.addToCommunity(owner, elsewhere, [supervisor]);
    foreign = await r.createCommunity(owner, 'حلقة المساء');
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;
  const refusal = (response: ApiResponse) => ({ status: response.status, code: code(response) });

  const start = (by: Account, communityId: string) =>
    r.api.call('POST', `/live/communities/${communityId}/sessions`, { token: by.token });

  /** Starts, asserts the starter is the host, and ends it again (one live session per community). */
  async function startsAndHosts(by: Account, communityId: string): Promise<void> {
    const started = await start(by, communityId);
    expect(started.status).toBe(201);
    expect(started.body.hostUserId).toBe(by.id);
    const ended = await r.api.call('POST', `/live/sessions/${started.body.id as string}/end`, {
      token: by.token,
    });
    expect(ended.status).toBe(200);
  }

  const add = (by: Account, communityId: string, userIds: readonly string[]) =>
    r.api.call('POST', `/communities/${communityId}/members`, {
      token: by.token,
      body: { userIds },
    });

  describe('A — starting a broadcast', () => {
    it('the community owner (its creator) starts and hosts', async () => {
      await startsAndHosts(admin, managed);
    });

    it('no general role starts without the community permission', async () => {
      // Teachers and — now — supervisors pass the identity ceiling, and are
      // then refused by the community: a member with no grant.
      expect(refusal(await start(teacher, managed))).toEqual({
        status: 403,
        code: 'live.start_not_permitted',
      });
      expect(refusal(await start(supervisor, managed))).toEqual({
        status: 403,
        code: 'live.start_not_permitted',
      });
      // The institution's own OWNER is a plain member here: no bypass.
      expect(refusal(await start(owner, managed))).toEqual({
        status: 403,
        code: 'live.start_not_permitted',
      });
      // Assistants and students cannot start anywhere.
      for (const account of [assistant, student]) {
        expect(refusal(await start(account, managed))).toEqual({
          status: 403,
          code: 'identity.permission_denied',
        });
      }
    });

    it('a non-member — even an administrator — learns nothing of the community', async () => {
      const refused = refusal(await start(admin, foreign));
      expect(refused.status).toBe(404);
    });

    it('a community.live.start grant lets a supervisor and a teacher start and host', async () => {
      await r.grantCapabilities(admin, managed, supervisor.id, ['community.live.start']);
      await startsAndHosts(supervisor, managed);
      await r.grantCapabilities(admin, managed, teacher.id, ['community.live.start']);
      await startsAndHosts(teacher, managed);
    });

    it("a grant is the community's own: it does not carry to another community", async () => {
      expect(refusal(await start(supervisor, elsewhere))).toEqual({
        status: 403,
        code: 'live.start_not_permitted',
      });
    });

    it('start cannot be delegated to an assistant or a student (no identity ceiling)', async () => {
      for (const account of [assistant, student]) {
        const response = await r.api.call('POST', `/communities/${managed}/grants`, {
          token: admin.token,
          body: { userId: account.id, capabilities: ['community.live.start'] },
        });
        expect(response.status).toBe(422);
      }
    });
  });

  describe('B — adding members', () => {
    it('a supervisor without the community permission is refused', async () => {
      expect(refusal(await add(supervisor, managed, [newcomer.id]))).toEqual({
        status: 403,
        code: 'communities.capability_required',
      });
    });

    it('a supervisor granted community.members.invite adds — once (idempotent)', async () => {
      await r.grantCapabilities(admin, managed, supervisor.id, ['community.members.invite']);
      expect((await add(supervisor, managed, [newcomer.id])).status).toBe(201);
      // Already a member: nothing to add, and nothing refused.
      expect((await add(supervisor, managed, [newcomer.id])).status).toBe(200);
    });

    it('an invalid target is refused, and nothing is added', async () => {
      const unknown = '00000000-0000-4000-8000-0000000000aa';
      expect(refusal(await add(supervisor, managed, [unknown]))).toEqual({
        status: 422,
        code: 'communities.members_not_eligible',
      });
    });

    it('a grant in one community adds nothing in another (cross-community)', async () => {
      // A plain member of `elsewhere`, with no grant there.
      expect(refusal(await add(supervisor, elsewhere, [newcomer.id]))).toEqual({
        status: 403,
        code: 'communities.capability_required',
      });
      // Not a member of `foreign` at all: indistinguishable from no community.
      expect((await add(supervisor, foreign, [newcomer.id])).status).toBe(404);
    });

    it('a teacher granted community.members.invite adds; a plain-member admin does not (no oversight bypass)', async () => {
      const another = await r.provision('another', 'STUDENT', 'سمية');
      await r.grantCapabilities(admin, managed, teacher.id, ['community.members.invite']);
      expect((await add(teacher, managed, [another.id])).status).toBe(201);
      // The institution's OWNER holds oversight but no grant in `managed`.
      expect(refusal(await add(owner, managed, [another.id]))).toEqual({
        status: 403,
        code: 'communities.capability_required',
      });
    });
  });
});
