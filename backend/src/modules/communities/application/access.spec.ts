import type { Principal, Result } from '../../../shared';
import { ALL_PERMISSIONS } from '../../identity/contracts/permissions';
import {
  META,
  codeOf,
  communitiesHarness,
  type CommunitiesHarness,
} from '../../../../test/support/communities-harness';

/**
 * Who may reach a community at all. The rule (§6.1): identity's ceiling AND
 * Communities' own standing AND the lifecycle — a role alone is never enough.
 */
describe('community access', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let communityId: string;
  let token: string;
  let invitationId: string;

  beforeEach(async () => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    communityId = await h.community(admin);
    ({ token, invitationId } = await h.link(admin, communityId));
    h.person('student-1', ['STUDENT']);
    await h.addPeople(admin, communityId, 'student-1');
  });

  /** Every community-scoped use case, as the principal would call it. */
  const everyAct = (principal: Principal, community: string) =>
    ({
      view: () => h.get.execute({ principal, communityId: community, meta: META }),
      lock: () => h.status.execute({ principal, communityId: community, to: 'LOCKED', meta: META }),
      unlock: () => h.status.execute({ principal, communityId: community, to: 'OPEN', meta: META }),
      roster: () => h.members.execute({ principal, communityId: community, meta: META }),
      add: () =>
        h.add.execute({ principal, communityId: community, userIds: ['student-1'], meta: META }),
      remove: () =>
        h.remove.execute({ principal, communityId: community, userId: 'student-1', meta: META }),
      invite: () => h.invite.execute({ principal, communityId: community, meta: META }),
      links: () => h.invitations.execute({ principal, communityId: community, meta: META }),
      revoke: () =>
        h.revoke.execute({ principal, communityId: community, invitationId, meta: META }),
      // Last: leaving changes the answers to everything after it.
      leave: () => h.leave.execute({ principal, communityId: community, meta: META }),
    }) satisfies Record<string, () => Promise<Result<unknown>>>;

  async function answers(principal: Principal, community: string) {
    const out: Record<string, unknown> = {};
    for (const [name, run] of Object.entries(everyAct(principal, community))) {
      const result = await run();
      out[name] = result.ok ? 'ok' : result.error;
    }
    return out;
  }

  it('tells a non-member exactly what it tells anyone about a community that does not exist', async () => {
    // Every permission but oversight: a role never substitutes for membership.
    const everything: Principal = {
      userId: 'almost-everything',
      roles: [],
      permissions: new Set<string>(
        ALL_PERMISSIONS.filter((permission) => permission !== 'communities.manage'),
      ),
    };
    const teacher = h.person('teacher-1', ['TEACHER']);
    for (const outsider of [everything, teacher]) {
      const real = await answers(outsider, communityId);
      const missing = await answers(outsider, '00000000-0000-4000-8000-00000000ffff');
      expect(real).toEqual(missing);
      for (const answer of Object.values(real)) {
        expect(answer).toMatchObject({ code: 'communities.community_not_found' });
      }
    }
  });

  it('refuses a teacher without standing: not found outside, capability required inside (§6.14)', async () => {
    const teacher = h.person('teacher-1', ['TEACHER']);
    const outside = await answers(teacher, communityId);
    expect(
      Object.values(outside).every(
        (a) => (a as { code: string }).code === 'communities.community_not_found',
      ),
    ).toBe(true);

    await h.addPeople(admin, communityId, 'teacher-1');
    const inside = await answers(teacher, communityId);
    const codes = Object.fromEntries(
      Object.entries(inside).map(([name, answer]) => [
        name,
        answer === 'ok' ? 'ok' : (answer as { code: string }).code,
      ]),
    );
    expect(codes).toEqual({
      view: 'ok',
      lock: 'communities.capability_required',
      unlock: 'communities.capability_required',
      roster: 'communities.capability_required',
      add: 'communities.capability_required',
      remove: 'communities.capability_required',
      invite: 'communities.capability_required',
      links: 'communities.capability_required',
      revoke: 'communities.capability_required',
      // Leaving is theirs to do — last, so it does not change the rest.
      leave: 'ok',
    });
  });

  it('lets an overseer view, list, lock, remove and manage links — but never add or create links', async () => {
    const overseer = h.person('owner-role', ['OWNER']); // holds communities.manage, not a member
    const codes: Record<string, string> = {};
    for (const [name, run] of Object.entries(everyAct(overseer, communityId))) {
      if (name === 'unlock') continue; // taken after lock below
      codes[name] = codeOf(await run());
    }
    codes.unlock = codeOf(await everyAct(overseer, communityId).unlock());
    expect(codes).toEqual({
      view: 'ok',
      lock: 'ok',
      roster: 'ok',
      add: 'communities.community_not_found',
      remove: 'ok',
      leave: 'communities.community_not_found',
      invite: 'communities.community_not_found',
      links: 'ok',
      revoke: 'ok',
      unlock: 'ok',
    });
    // Every read on the oversight basis leaves an audit entry (PROVISIONAL, Q43).
    const reads = h.journal.entries.filter(
      (entry) => entry.action === 'communities.oversight.read',
    );
    expect(reads.map((entry) => entry.metadata?.act)).toEqual([
      'community.view',
      'community.members.view',
      'community.members.invite',
    ]);
  });

  it('refuses without reading anything when no path has its ceiling', async () => {
    const student = h.person('student-2', ['STUDENT']);
    const reads = jest.spyOn(h.store, 'authorityOf');
    for (const run of [
      () => h.members.execute({ principal: student, communityId, meta: META }),
      () => h.status.execute({ principal: student, communityId, to: 'LOCKED', meta: META }),
      () => h.invite.execute({ principal: student, communityId, meta: META }),
      () => h.remove.execute({ principal: student, communityId, userId: 'x', meta: META }),
    ]) {
      expect(codeOf(await run())).toBe('identity.permission_denied');
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it('refuses a system job without the permission, even when no guard ran first', async () => {
    const job = h.system('cleanup', []);
    for (const run of Object.values(everyAct(job, communityId))) {
      expect(codeOf(await run())).toBe('identity.permission_denied');
    }
    expect(codeOf(await h.create.execute({ principal: job, title: 'x', meta: META }))).toBe(
      'identity.permission_denied',
    );
    expect(codeOf(await h.redeem.execute({ principal: job, token, meta: META }))).toBe(
      'identity.permission_denied',
    );
    expect(codeOf(await h.list.execute({ principal: job, scope: 'mine', meta: META }))).toBe(
      'identity.permission_denied',
    );
  });

  it('never lets a job own or join a community, whatever it is given', async () => {
    const powerful = h.system('importer', ALL_PERMISSIONS);
    expect(codeOf(await h.create.execute({ principal: powerful, title: 'x', meta: META }))).toBe(
      'communities.person_required',
    );
    expect(codeOf(await h.redeem.execute({ principal: powerful, token, meta: META }))).toBe(
      'communities.person_required',
    );
    // It may oversee, like any holder of communities.manage — audited.
    expect(codeOf(await h.get.execute({ principal: powerful, communityId, meta: META }))).toBe(
      'ok',
    );
    expect(h.journal.entries.at(-1)).toMatchObject({
      actorUserId: null,
      action: 'communities.oversight.read',
    });
  });

  it('keeps an unmapped role from reading its way in: a student cannot see the roster', async () => {
    const student: Principal = { ...h.person('student-1', ['STUDENT']) };
    expect(codeOf(await h.get.execute({ principal: student, communityId, meta: META }))).toBe('ok');
    expect(codeOf(await h.members.execute({ principal: student, communityId, meta: META }))).toBe(
      'identity.permission_denied',
    );
  });

  it('answers authorizeEach with one read, and an answer for every id asked', async () => {
    const second = await h.community(admin, 'حلقة الحفظ');
    const reads = jest.spyOn(h.store, 'authorityOfEach');
    const student = h.person('student-1', ['STUDENT']);
    const answers = await h.authorization.authorizeEach(
      student,
      [communityId, second, 'no-such-community'],
      'community.view',
    );
    expect(reads).toHaveBeenCalledTimes(1);
    expect([...answers.entries()].map(([id, result]) => [id, codeOf(result)])).toEqual([
      [communityId, 'ok'],
      [second, 'communities.community_not_found'],
      ['no-such-community', 'communities.community_not_found'],
    ]);
    await expect(
      h.authorization.authorizeEach(
        student,
        Array.from({ length: 1001 }, (_, i) => `c${i}`),
        'community.view',
      ),
    ).rejects.toThrow(RangeError);
  });

  it('records the basis a permit rests on, for the audit of whatever it authorizes', async () => {
    const permit = await h.authorization.authorize(admin, communityId, 'community.lock');
    expect(permit).toMatchObject({
      ok: true,
      value: {
        principalUserId: 'admin-1',
        communityId,
        scope: 'communities.community',
        act: 'community.lock',
        basis: 'owner',
        grantId: null,
        ceiling: ['communities.moderate'],
      },
    });
  });
});
