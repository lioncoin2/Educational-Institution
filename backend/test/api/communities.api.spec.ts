import { COMMUNITY_STORE, type CommunityStore } from '../../src/modules/communities/domain/ports';
import type { ApiResponse } from '../support/api-client';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * /communities over HTTP — the application exactly as the server runs it
 * without a database: the real guards, pipes, filter and wiring, the
 * in-memory store, and accounts provisioned through the admin API.
 */
describe('communities API', () => {
  let r: RealtimeApi;
  let admin: Account;
  let teacher: Account;
  let student: Account;
  let outsider: Account;
  const transcript: string[] = [];
  let communityId: string;

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

  async function call(
    method: string,
    path: string,
    account?: Account,
    body?: unknown,
  ): Promise<ApiResponse> {
    const response = await r.api.call(method, path, { token: account?.token, body });
    transcript.push(response.raw);
    return response;
  }

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;

  /** A body with its request id removed — two refusals compared byte for byte. */
  const withoutRequestId = (response: ApiResponse) => {
    const { requestId: _ignored, ...rest } = response.body;
    return JSON.stringify({ status: response.status, ...rest });
  };

  it('refuses every route to an anonymous caller', async () => {
    for (const [method, path] of [
      ['GET', '/communities'],
      ['POST', '/communities'],
      ['POST', '/communities/join'],
      ['GET', '/communities/x'],
      ['POST', '/communities/x/lock'],
      ['POST', '/communities/x/unlock'],
      ['GET', '/communities/x/members'],
      ['POST', '/communities/x/members'],
      ['DELETE', '/communities/x/members/y'],
      ['POST', '/communities/x/leave'],
      ['POST', '/communities/x/invitations'],
      ['GET', '/communities/x/invitations'],
      ['POST', '/communities/x/invitations/y/revoke'],
      ['GET', '/communities/x/grants'],
      ['POST', '/communities/x/grants'],
      ['DELETE', '/communities/x/grants/y'],
      ['PUT', '/communities/x/owner'],
    ]) {
      expect({ method, path, status: (await call(method, path)).status }).toEqual({
        method,
        path,
        status: 401,
      });
    }
  });

  it('creates a community for whoever may create one, with its owner block', async () => {
    const refused = await call('POST', '/communities', teacher, { title: 'حلقة' });
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('identity.permission_denied');

    expect((await call('POST', '/communities', admin, { title: '   ' })).status).toBe(422);
    const tooLong = await call('POST', '/communities', admin, { title: 'ق'.repeat(401) });
    expect({ status: tooLong.status, code: code(tooLong) }).toEqual({
      status: 422,
      code: 'communities.title_invalid',
    });
    expect(
      (await call('POST', '/communities', admin, { title: 'x', ownerUserId: teacher.id })).status,
    ).toBe(400);

    const created = await call('POST', '/communities', admin, { title: 'حلقة التجويد' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'حلقة التجويد',
      status: 'OPEN',
      lifecycleVersion: 1,
      memberCount: 1,
      me: { standing: 'OWNER', joinedAt: expect.any(String) as string },
    });
    expect(created.body.me).toMatchObject({
      capabilities: expect.arrayContaining([
        'community.lock',
        'community.members.invite',
      ]) as string[],
    });
    communityId = created.body.id as string;
  });

  it('answers a non-member exactly as it answers a community that does not exist', async () => {
    const real = await call('GET', `/communities/${communityId}`, outsider);
    const missing = await call(
      'GET',
      '/communities/00000000-0000-4000-8000-00000000abcd',
      outsider,
    );
    expect(real.status).toBe(404);
    expect(code(real)).toBe('communities.community_not_found');
    expect(withoutRequestId(real)).toBe(withoutRequestId(missing));
  });

  it('adds members: 201 when anyone was added, 200 when nobody was', async () => {
    const added = await call('POST', `/communities/${communityId}/members`, admin, {
      userIds: [student.id, teacher.id],
    });
    expect(added.status).toBe(201);
    expect(added.body).toEqual({ added: [student.id, teacher.id], unchanged: [] });
    const again = await call('POST', `/communities/${communityId}/members`, admin, {
      userIds: [student.id],
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ added: [], unchanged: [student.id] });

    const ineligible = await call('POST', `/communities/${communityId}/members`, admin, {
      userIds: ['00000000-0000-4000-8000-00000000dead'],
    });
    expect(ineligible.status).toBe(422);
    expect(code(ineligible)).toBe('communities.members_not_eligible');
    for (const userIds of [
      [],
      [student.id, student.id],
      Array.from({ length: 201 }, (_, i) => `u${i}`),
    ]) {
      expect(
        (await call('POST', `/communities/${communityId}/members`, admin, { userIds })).status,
      ).toBe(400);
    }
  });

  it('shows members the community, and the roster only to those who manage it', async () => {
    const view = await call('GET', `/communities/${communityId}`, student);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      memberCount: 3,
      me: { standing: 'MEMBER', capabilities: [] },
    });

    const studentRoster = await call('GET', `/communities/${communityId}/members`, student);
    expect(studentRoster.status).toBe(403);
    const teacherRoster = await call('GET', `/communities/${communityId}/members`, teacher);
    expect(teacherRoster.status).toBe(403);
    expect(code(teacherRoster)).toBe('communities.capability_required');

    const roster = await call('GET', `/communities/${communityId}/members?limit=2`, admin);
    expect(roster.status).toBe(200);
    expect(roster.body.items).toHaveLength(2);
    for (const item of roster.body.items as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual(['active', 'displayName', 'joinedAt', 'userId']);
    }
    const next = await call(
      'GET',
      `/communities/${communityId}/members?cursor=${encodeURIComponent(roster.body.nextCursor as string)}`,
      admin,
    );
    expect(next.body.items).toHaveLength(1);
    expect(
      (await call('GET', `/communities/${communityId}/members?cursor=forged`, admin)).status,
    ).toBe(422);
    const longForgery = await call(
      'GET',
      `/communities/${communityId}/members?cursor=${'x'.repeat(600)}`,
      admin,
    );
    expect({ status: longForgery.status, code: code(longForgery) }).toEqual({
      status: 422,
      code: 'communities.cursor_invalid',
    });
    // A large limit is clamped to the maximum, not refused.
    const clamped = await call('GET', `/communities/${communityId}/members?limit=1000000`, admin);
    expect(clamped.status).toBe(200);
  });

  it('lists my communities, and every community only to an overseer', async () => {
    const mine = await call('GET', '/communities', student);
    expect(mine.status).toBe(200);
    expect((mine.body.items as { id: string }[]).map((item) => item.id)).toEqual([communityId]);
    expect((await call('GET', '/communities?scope=all', student)).status).toBe(403);
    expect((await call('GET', '/communities?scope=everything', student)).status).toBe(400);
    const all = await call('GET', '/communities?scope=all', r.owner);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(1);
  });

  let token = '';
  let invitationId = '';

  it('creates a link — the token in that response and nowhere else', async () => {
    const created = await call('POST', `/communities/${communityId}/invitations`, admin, {
      maxUses: 2,
    });
    expect(created.status).toBe(201);
    token = created.body.token as string;
    invitationId = (created.body.invitation as { id: string }).id;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.invitation).toMatchObject({ maxUses: 2, uses: 0, state: 'ACTIVE' });

    const listed = await call('GET', `/communities/${communityId}/invitations`, admin);
    expect(listed.status).toBe(200);
    expect(listed.raw).not.toContain(token);
    expect(
      (
        await call('POST', `/communities/${communityId}/invitations`, admin, {
          expiresInSeconds: 10,
        })
      ).status,
    ).toBe(422);
    expect(
      (await call('POST', `/communities/${communityId}/invitations`, student, {})).status,
    ).toBe(403);
  });

  it('joins by link: 201, then 200 — and ignores a token anywhere but the body', async () => {
    const joiner = await r.provision('joiner', 'STUDENT', 'حفصة');
    // A valid token in the query string is ignored; the body's is what counts.
    const queried = await call(
      'POST',
      `/communities/join?token=${encodeURIComponent(token)}`,
      joiner,
      { token: 'not-a-token' },
    );
    expect(queried.status).toBe(404);
    expect(code(queried)).toBe('communities.invitation_invalid');
    // Missing, mistyped or oversized: answered exactly like an unknown token (§7.2).
    for (const body of [{}, { token: 43 }, { token: 'A'.repeat(600) }]) {
      const refused = await call('POST', '/communities/join', joiner, body);
      expect({ status: refused.status, code: code(refused) }).toEqual({
        status: 404,
        code: 'communities.invitation_invalid',
      });
    }

    const joined = await call('POST', '/communities/join', joiner, { token });
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ id: communityId, me: { standing: 'MEMBER' } });
    const again = await call('POST', '/communities/join', joiner, { token });
    expect(again.status).toBe(200);
  });

  it('locks: links suspended, adding refused, management open — then unlocks', async () => {
    const locked = await call('POST', `/communities/${communityId}/lock`, admin);
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ status: 'LOCKED', lifecycleVersion: 2 });
    expect((await call('POST', `/communities/${communityId}/lock`, admin)).body).toMatchObject({
      lifecycleVersion: 2,
    });

    const late = await r.provision('late', 'STUDENT', 'رقية');
    const refused = await call('POST', '/communities/join', late, { token });
    expect(refused.status).toBe(412);
    expect(code(refused)).toBe('communities.community_locked');
    expect(
      (await call('POST', `/communities/${communityId}/members`, admin, { userIds: [late.id] }))
        .status,
    ).toBe(412);
    expect((await call('GET', `/communities/${communityId}/members`, admin)).status).toBe(200);

    const unlocked = await call('POST', `/communities/${communityId}/unlock`, admin);
    expect(unlocked.body).toMatchObject({ status: 'OPEN', lifecycleVersion: 3 });
    expect((await call('POST', '/communities/join', late, { token })).status).toBe(201);
    // Two uses: the link is now exhausted.
    const extra = await r.provision('extra', 'STUDENT', 'سمية');
    const exhausted = await call('POST', '/communities/join', extra, { token });
    expect(exhausted.status).toBe(412);
    expect(code(exhausted)).toBe('communities.invitation_exhausted');
  });

  it('revokes a link once, and a revoked link admits nobody', async () => {
    const created = await call('POST', `/communities/${communityId}/invitations`, admin, {});
    const id = (created.body.invitation as { id: string }).id;
    const revoked = await call(
      'POST',
      `/communities/${communityId}/invitations/${id}/revoke`,
      admin,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ state: 'REVOKED' });
    expect(
      (await call('POST', `/communities/${communityId}/invitations/${id}/revoke`, admin)).status,
    ).toBe(200);
    const refused = await call('POST', '/communities/join', outsider, {
      token: created.body.token as string,
    });
    expect(refused.status).toBe(412);
    expect(code(refused)).toBe('communities.invitation_revoked');
    expect(
      code(await call('POST', `/communities/${communityId}/invitations/nope/revoke`, admin)),
    ).toBe('communities.invitation_not_found');
    expect(invitationId).not.toBe(id);
  });

  it('delegates: the owner grants (201, then 200), a delegate acts, only the owner revokes (204)', async () => {
    const grants = `/communities/${communityId}/grants`;
    const granted = await call('POST', grants, admin, {
      userId: teacher.id,
      capabilities: ['community.lock', 'community.members.view'],
    });
    expect(granted.status).toBe(201);
    const created = granted.body.created as Record<string, unknown>[];
    expect(created.map((grant) => grant.capability)).toEqual([
      'community.members.view',
      'community.lock',
    ]);
    for (const grant of created) {
      expect(Object.keys(grant).sort()).toEqual([
        'capability',
        'dormant',
        'grantId',
        'grantedAt',
        'grantedBy',
        'userId',
      ]);
    }
    const again = await call('POST', grants, admin, {
      userId: teacher.id,
      capabilities: ['community.lock'],
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      created: [],
      unchanged: [{ capability: 'community.lock' }],
    });

    // The vocabulary is closed at the edge; unknown fields are refused.
    for (const body of [
      { userId: teacher.id, capabilities: ['community.view'] },
      { userId: teacher.id, capabilities: [] },
      { userId: teacher.id, capabilities: ['community.lock', 'community.lock'] },
      { userId: teacher.id, capabilities: ['community.lock'], grantedBy: admin.id },
    ]) {
      expect((await call('POST', grants, admin, body)).status).toBe(400);
    }
    const byStudent = await call('POST', grants, student, {
      userId: teacher.id,
      capabilities: ['community.lock'],
    });
    expect({ status: byStudent.status, code: code(byStudent) }).toEqual({
      status: 403,
      code: 'identity.permission_denied',
    });
    const byDelegate = await call('POST', grants, teacher, {
      userId: student.id,
      capabilities: ['community.lock'],
    });
    expect({ status: byDelegate.status, code: code(byDelegate) }).toEqual({
      status: 403,
      code: 'communities.not_community_owner',
    });
    const toStudent = await call('POST', grants, admin, {
      userId: student.id,
      capabilities: ['community.lock'],
    });
    expect({ status: toStudent.status, code: code(toStudent) }).toEqual({
      status: 422,
      code: 'communities.grantee_ineligible',
    });
    expect(
      (
        await call('POST', '/communities/00000000-0000-4000-8000-00000000abcd/grants', admin, {
          userId: teacher.id,
          capabilities: ['community.lock'],
        })
      ).status,
    ).toBe(404);

    // The delegate acts — and sees exactly what was delegated.
    const view = await call('GET', `/communities/${communityId}`, teacher);
    expect(view.body.me).toMatchObject({
      standing: 'MEMBER',
      capabilities: ['community.members.view', 'community.lock'],
    });
    expect((await call('POST', `/communities/${communityId}/lock`, teacher)).status).toBe(200);
    expect((await call('POST', `/communities/${communityId}/unlock`, teacher)).status).toBe(200);
    expect((await call('GET', `/communities/${communityId}/members`, teacher)).status).toBe(200);

    // The owner sees every grant; a holder their own; another member none; an outsider nothing.
    const listed = await call('GET', grants, admin);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(2);
    expect((await call('GET', grants, teacher)).body.items).toHaveLength(2);
    expect((await call('GET', grants, student)).body.items).toEqual([]);
    expect((await call('GET', `${grants}?capability=community.view`, admin)).status).toBe(400);
    expect((await call('GET', grants, outsider)).status).toBe(404);

    const lockGrant = created.find((grant) => grant.capability === 'community.lock');
    const path = `${grants}/${lockGrant?.grantId as string}`;
    const byHolder = await call('DELETE', path, teacher);
    expect({ status: byHolder.status, code: code(byHolder) }).toEqual({
      status: 403,
      code: 'communities.not_community_owner',
    });
    expect((await call('DELETE', path, admin)).status).toBe(204);
    expect((await call('DELETE', path, admin)).status).toBe(204);
    const unknown = await call('DELETE', `${grants}/no-such-grant`, admin);
    expect({ status: unknown.status, code: code(unknown) }).toEqual({
      status: 404,
      code: 'communities.grant_not_found',
    });
    expect((await call('POST', `/communities/${communityId}/lock`, teacher)).status).toBe(403);
  });

  it('transfers ownership: 200 with the caller’s new standing; oversight never names itself', async () => {
    const heir = await r.provision('heir', 'TEACHER', 'الأستاذ يوسف');
    await call('POST', `/communities/${communityId}/members`, admin, { userIds: [heir.id] });
    const owner = `/communities/${communityId}/owner`;

    for (const [target, expected] of [
      [outsider.id, 'communities.owner_ineligible'], // not a member
      [student.id, 'communities.owner_ineligible'], // no communities.moderate
    ] as const) {
      const refused = await call('PUT', owner, admin, { userId: target });
      expect({ status: refused.status, code: code(refused) }).toEqual({
        status: 422,
        code: expected,
      });
    }
    const byMember = await call('PUT', owner, teacher, { userId: heir.id });
    expect({ status: byMember.status, code: code(byMember) }).toEqual({
      status: 403,
      code: 'communities.not_community_owner',
    });
    const selfAssigned = await call('PUT', owner, r.owner, { userId: r.owner.id });
    expect({ status: selfAssigned.status, code: code(selfAssigned) }).toEqual({
      status: 403,
      code: 'communities.owner_self_assignment',
    });
    expect((await call('PUT', owner, admin, {})).status).toBe(400);

    const moved = await call('PUT', owner, admin, { userId: heir.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: communityId, me: { standing: 'MEMBER' } });
    const repeat = await call('PUT', owner, heir, { userId: heir.id });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ me: { standing: 'OWNER' } });

    // Oversight hands it back — the recovery path.
    const back = await call('PUT', owner, r.owner, { userId: admin.id });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ me: { standing: null } });
    expect((await call('GET', `/communities/${communityId}`, admin)).body).toMatchObject({
      me: { standing: 'OWNER' },
    });
  });

  it('removes and leaves: 204, and never the owner', async () => {
    expect(
      (await call('DELETE', `/communities/${communityId}/members/${teacher.id}`, admin)).status,
    ).toBe(204);
    const again = await call('DELETE', `/communities/${communityId}/members/${teacher.id}`, admin);
    expect(again.status).toBe(404);
    expect(code(again)).toBe('communities.member_not_found');
    const owner = await call('DELETE', `/communities/${communityId}/members/${admin.id}`, admin);
    expect(owner.status).toBe(412);
    expect(code(owner)).toBe('communities.owner_not_removable');

    expect((await call('POST', `/communities/${communityId}/leave`, student)).status).toBe(204);
    const ownerLeaves = await call('POST', `/communities/${communityId}/leave`, admin);
    expect(ownerLeaves.status).toBe(412);
    expect(code(ownerLeaves)).toBe('communities.owner_cannot_leave');
    // Removed by a manager: no way back by link.
    const back = await call('POST', '/communities/join', teacher, { token });
    expect(back.status).toBe(403);
    expect(code(back)).toBe('communities.rejoin_requires_manager');
  });

  it('limits join attempts per person, with Retry-After', async () => {
    const guesser = await r.provision('guesser', 'STUDENT', 'خديجة');
    for (let i = 0; i < 10; i += 1) {
      await call('POST', '/communities/join', guesser, { token: 'A'.repeat(43) });
    }
    const limited = await r.api.call('POST', '/communities/join', {
      token: guesser.token,
      body: { token: 'A'.repeat(43) },
    });
    expect(limited.status).toBe(429);
    expect(code(limited)).toBe('communities.too_many_attempts');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('answers 503 unavailable when the store cannot be reached — never a role-only answer', async () => {
    const store = r.api.app.get<CommunityStore>(COMMUNITY_STORE, { strict: false });
    const outage = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const spy = jest.spyOn(store, 'authorityOf').mockRejectedValueOnce(outage);
    const refused = await call('GET', `/communities/${communityId}`, admin);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({ kind: 'unavailable', code: 'unavailable' });
    spy.mockRestore();
    // A fault that is not an outage is still a fault.
    const broken = jest
      .spyOn(store, 'authorityOf')
      .mockRejectedValueOnce(new TypeError('a bug, not an outage'));
    expect((await call('GET', `/communities/${communityId}`, admin)).status).toBe(500);
    broken.mockRestore();
    expect((await call('GET', `/communities/${communityId}`, admin)).status).toBe(200);
  });

  it('never answers with an email, and never with a token hash', () => {
    expect(transcript.length).toBeGreaterThan(30);
    for (const raw of transcript) {
      expect(raw).not.toContain('@');
      expect(raw).not.toMatch(/\b[0-9a-f]{64}\b/u);
    }
    // The token appears exactly where it was issued.
    const carrying = transcript.filter((raw) => raw.includes(token));
    expect(carrying).toHaveLength(1);
  });
});
