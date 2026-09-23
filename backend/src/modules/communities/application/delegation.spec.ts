import type { Principal } from '../../../shared';
import { principalWith } from '../../../../test/support/principals';
import {
  META,
  codeOf,
  communitiesHarness,
  type CommunitiesHarness,
} from '../../../../test/support/communities-harness';
import { COMMUNITY_CAPABILITIES } from '../contracts/capabilities';

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

/**
 * Delegation and ownership (P3, §6.8–§6.10): what the owner may give, to
 * whom, what a grant then allows — in its community only — and how grants
 * end. Every rule here is PROVISIONAL (Q42, Q44, Q45).
 */
describe('delegation', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let teacher: Principal;
  let id: string;

  beforeEach(async () => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    teacher = h.person('teacher-1', ['TEACHER']);
    h.person('teacher-2', ['TEACHER']);
    h.person('student-1', ['STUDENT']);
    id = await h.community(admin);
    await h.addPeople(admin, id, 'teacher-1', 'teacher-2', 'student-1');
    h.journal.clear();
  });

  const grant = (userId: string, capabilities: string[], principal = admin, community = id) =>
    h.grant.execute({ principal, communityId: community, userId, capabilities, meta: META });

  const me = async (principal: Principal, community = id) =>
    unwrap(await h.get.execute({ principal, communityId: community, meta: META })).me;

  describe('granting', () => {
    it('creates one grant per capability, then reports repeats unchanged and records nothing', async () => {
      const first = unwrap(await grant('teacher-1', ['community.lock', 'community.members.view']));
      expect(first.anyCreated).toBe(true);
      expect(
        first.view.created.map((g) => [g.capability, g.userId, g.grantedBy, g.dormant]),
      ).toEqual([
        ['community.members.view', 'teacher-1', 'admin-1', false],
        ['community.lock', 'teacher-1', 'admin-1', false],
      ]);
      expect(h.journal.order).toEqual([
        'audit:communities.capability.granted',
        'event:communities.capability.granted',
        'audit:communities.capability.granted',
        'event:communities.capability.granted',
      ]);
      // Ids only: the payload is allow-listed.
      expect(h.journal.events.map((event) => Object.keys(event.payload as object).sort())).toEqual([
        ['capability', 'communityId', 'grantId', 'grantedBy', 'membershipId', 'userId'],
        ['capability', 'communityId', 'grantId', 'grantedBy', 'membershipId', 'userId'],
      ]);
      expect(h.journal.entries[0]?.metadata).toMatchObject({
        capability: 'community.members.view',
        userId: 'teacher-1',
        authority: { operation: 'community.grants.manage', basis: 'owner' },
      });

      h.journal.clear();
      const again = unwrap(await grant('teacher-1', ['community.lock']));
      expect(again.anyCreated).toBe(false);
      expect(again.view.unchanged.map((g) => g.grantId)).toEqual([first.view.created[1]?.grantId]);
      expect(h.journal.order).toEqual([]);
    });

    it('lets only the owner grant: a delegate cannot, and a non-member hears "not found" (R1)', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.lock');
      expect(codeOf(await grant('teacher-2', ['community.lock'], teacher))).toBe(
        'communities.not_community_owner',
      );
      const outsider = h.person('teacher-9', ['TEACHER']);
      expect(codeOf(await grant('teacher-2', ['community.lock'], outsider))).toBe(
        'communities.community_not_found',
      );
      expect(codeOf(await grant('teacher-2', ['community.lock'], admin, 'no-such-community'))).toBe(
        'communities.community_not_found',
      );
      // Oversight reaches no grant.
      const overseer = h.person('owner-role', ['OWNER']);
      expect(codeOf(await grant('teacher-2', ['community.lock'], overseer))).toBe(
        'communities.community_not_found',
      );
    });

    it('never gives a capability whose ceiling the owner lacks — before reading anything (R2)', async () => {
      // An owner who is an ADMIN losing live.moderate is modelled by a principal without it.
      const narrowOwner: Principal = {
        ...admin,
        permissions: new Set([...admin.permissions].filter((p) => p !== 'live.moderate')),
      };
      const reads = jest.spyOn(h.store, 'authorityOf');
      expect(
        codeOf(await grant('teacher-1', ['community.lock', 'community.live.start'], narrowOwner)),
      ).toBe('identity.permission_denied');
      expect(reads).not.toHaveBeenCalled();
      expect(await h.readModel.grants(id, { limit: 10 })).toEqual([]);
    });

    it('refuses every ineligible grantee alike, and only after the caller proved ownership (R3, R5)', async () => {
      h.person('outsider', ['TEACHER']);
      h.person('suspended', ['TEACHER']);
      await h.addPeople(admin, id, 'suspended');
      h.accounts.suspend('suspended');
      h.journal.clear();
      for (const [userId, capabilities] of [
        ['student-1', ['community.lock']], // lacks communities.moderate
        ['outsider', ['community.lock']], // not a member
        ['suspended', ['community.lock']], // cannot sign in
        ['nobody', ['community.lock']], // unknown account
        ['admin-1', ['community.lock']], // the owner themself
      ] as const) {
        expect(codeOf(await grant(userId, [...capabilities]))).toBe(
          'communities.grantee_ineligible',
        );
      }
      // A member who is not the owner learns nothing about accounts by probing.
      expect(codeOf(await grant('nobody', ['community.lock'], teacher))).toBe(
        'communities.not_community_owner',
      );
      expect(h.journal.entries).toHaveLength(0);
    });

    it('refuses the whole batch when one capability is out of reach — nothing is granted', async () => {
      // No provisional role holds communities.moderate without live.moderate:
      // an account made for the purpose, eligible for community.lock alone.
      h.person('lock-only', ['TEACHER']);
      await h.addPeople(admin, id, 'lock-only');
      h.accounts.setPermissions('lock-only', ['communities.read', 'communities.moderate']);
      expect(codeOf(await grant('lock-only', ['community.lock', 'community.live.start']))).toBe(
        'communities.grantee_ineligible',
      );
      expect(await h.readModel.grants(id, { limit: 10 })).toEqual([]);
      // The part within reach, asked alone, is given.
      unwrap(await grant('lock-only', ['community.lock']));

      h.person('assistant', ['ASSISTANT_TEACHER']);
      await h.addPeople(admin, id, 'assistant');
      expect(codeOf(await grant('assistant', ['community.members.view']))).toBe(
        'communities.grantee_ineligible',
      );
      expect(codeOf(await grant('teacher-1', ['community.lock', 'not.a.capability']))).toBe(
        'communities.capabilities_invalid',
      );
      expect(codeOf(await grant('teacher-1', []))).toBe('communities.capabilities_invalid');
      expect((await h.readModel.grants(id, { limit: 10 })).map((g) => g.userId)).toEqual([
        'lock-only',
      ]);
    });

    it('limits grants per person (PROVISIONAL)', async () => {
      for (let i = 0; i < 60; i += 1) unwrap(await grant('teacher-1', ['community.lock']));
      expect(await grant('teacher-1', ['community.lock'])).toMatchObject({
        ok: false,
        error: { code: 'communities.too_many_grants', details: { retryAfterSeconds: 600 } },
      });
    });
  });

  describe('what a grant allows', () => {
    it('gives exactly the capabilities granted — shown in me, taken on the grant basis', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.lock', 'community.members.view');
      expect((await me(teacher)).capabilities).toEqual([
        'community.members.view',
        'community.lock',
      ]);

      unwrap(
        await h.status.execute({ principal: teacher, communityId: id, to: 'LOCKED', meta: META }),
      );
      expect(h.journal.entries.at(-1)?.metadata).toMatchObject({
        authority: { act: 'community.lock', basis: 'grant' },
      });
      unwrap(await h.members.execute({ principal: teacher, communityId: id, meta: META }));
      expect(
        codeOf(
          await h.remove.execute({
            principal: teacher,
            communityId: id,
            userId: 'student-1',
            meta: META,
          }),
        ),
      ).toBe('communities.capability_required');
    });

    it('gives nothing in another community — found there, refused there (§6.14)', async () => {
      await h.delegate(admin, id, 'teacher-1', ...COMMUNITY_CAPABILITIES);
      const other = await h.community(admin, 'أخرى');
      expect(
        codeOf(
          await h.status.execute({
            principal: teacher,
            communityId: other,
            to: 'LOCKED',
            meta: META,
          }),
        ),
      ).toBe('communities.community_not_found');
      await h.addPeople(admin, other, 'teacher-1');
      expect(
        codeOf(
          await h.status.execute({
            principal: teacher,
            communityId: other,
            to: 'LOCKED',
            meta: META,
          }),
        ),
      ).toBe('communities.capability_required');
      expect((await me(teacher, other)).capabilities).toEqual([]);
    });

    it('lets a delegate invite: add members, and create links that admit while the grant stands', async () => {
      const [inviteGrant] = await h.delegate(admin, id, 'teacher-1', 'community.members.invite');
      h.person('s-a', ['STUDENT']);
      h.person('s-b', ['STUDENT']);
      h.person('s-c', ['STUDENT']);
      unwrap(
        await h.add.execute({ principal: teacher, communityId: id, userIds: ['s-a'], meta: META }),
      );
      const { token } = await h.link(teacher, id);
      const redeem = (userId: string) =>
        h.redeem.execute({ principal: principalWith(userId, ['STUDENT']), token, meta: META });
      expect(unwrap(await redeem('s-b')).kind).toBe('joined');

      // Revoked: the delegate's link fails closed, as an invalid link, consuming nothing.
      unwrap(
        await h.revokeGrant.execute({
          principal: admin,
          communityId: id,
          grantId: inviteGrant ?? '',
          meta: META,
        }),
      );
      expect(codeOf(await redeem('s-c'))).toBe('communities.invitation_invalid');
      expect(
        (await h.invitations.execute({ principal: admin, communityId: id, meta: META })).ok,
      ).toBe(true);
    });

    it('goes dormant when its holder loses the ceiling — kept, listed as dormant, and back with the role (R4)', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.lock');
      h.accounts.setRoles('teacher-1', ['STUDENT']);
      const demoted = principalWith('teacher-1', ['STUDENT']);
      expect(
        codeOf(
          await h.status.execute({ principal: demoted, communityId: id, to: 'LOCKED', meta: META }),
        ),
      ).toBe('identity.permission_denied');
      expect((await me(demoted)).capabilities).toEqual([]);
      const listed = unwrap(
        await h.grants.execute({ principal: admin, communityId: id, meta: META }),
      );
      expect(listed.items.map((g) => [g.userId, g.capability, g.dormant])).toEqual([
        ['teacher-1', 'community.lock', true],
      ]);

      h.accounts.setRoles('teacher-1', ['TEACHER']);
      unwrap(
        await h.status.execute({ principal: teacher, communityId: id, to: 'LOCKED', meta: META }),
      );
    });
  });

  describe('removal by a delegate (R6)', () => {
    const remove = (principal: Principal, userId: string) =>
      h.remove.execute({ principal, communityId: id, userId, meta: META });

    it('removes a plain member, and never someone holding more — dormant grants included', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.members.remove');
      await h.delegate(admin, id, 'teacher-2', 'community.live.moderate');
      // teacher-2's grant goes dormant: it still counts.
      h.accounts.setRoles('teacher-2', ['STUDENT']);
      expect(codeOf(await remove(teacher, 'teacher-2'))).toBe(
        'communities.member_holds_more_capabilities',
      );
      expect(codeOf(await remove(teacher, 'admin-1'))).toBe('communities.owner_not_removable');
      unwrap(await remove(teacher, 'student-1'));
      expect(h.journal.entries.at(-1)?.metadata).toMatchObject({
        userId: 'student-1',
        endedGrantIds: [],
        authority: { act: 'community.members.remove', basis: 'grant' },
      });
    });

    it('lets two delegates with equal powers remove each other — never both (Q44)', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.members.remove');
      await h.delegate(admin, id, 'teacher-2', 'community.members.remove');
      const second = principalWith('teacher-2', ['TEACHER']);
      unwrap(await remove(teacher, 'teacher-2'));
      expect(codeOf(await remove(second, 'teacher-1'))).toBe('communities.community_not_found');
    });

    it('ends the removed member’s grants with the stint; a rejoin brings none back', async () => {
      const ended = await h.delegate(
        admin,
        id,
        'teacher-2',
        'community.lock',
        'community.chat.post',
      );
      unwrap(await remove(admin, 'teacher-2'));
      expect(h.journal.entries.at(-1)?.metadata).toMatchObject({
        endedGrantIds: [...ended].sort(),
      });
      // Grants that end with a stint are implied by member.removed: no event of their own.
      expect(
        h.journal.eventNames().filter((name) => name.startsWith('communities.capability')),
      ).toEqual(['communities.capability.granted', 'communities.capability.granted']);
      await h.addPeople(admin, id, 'teacher-2');
      expect((await me(principalWith('teacher-2', ['TEACHER']))).capabilities).toEqual([]);
    });

    it('never removes oneself — that is a leave; the owner still hears it is not removable', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.members.remove');
      expect(codeOf(await remove(teacher, 'teacher-1'))).toBe('communities.cannot_remove_self');
      // A member who is also an overseer is refused alike.
      const overseer = h.person('owner-role', ['OWNER']);
      await h.addPeople(admin, id, 'owner-role');
      expect(codeOf(await remove(overseer, 'owner-role'))).toBe('communities.cannot_remove_self');
      expect(codeOf(await remove(admin, 'admin-1'))).toBe('communities.owner_not_removable');
      expect((await me(teacher)).standing).toBe('MEMBER');
      unwrap(await h.leave.execute({ principal: teacher, communityId: id, meta: META }));
    });

    it('does not bound the owner or oversight by R6', async () => {
      await h.delegate(admin, id, 'teacher-1', ...COMMUNITY_CAPABILITIES);
      const overseer = h.person('owner-role', ['OWNER']);
      unwrap(await remove(overseer, 'teacher-1'));
      await h.addPeople(admin, id, 'teacher-1');
      await h.delegate(admin, id, 'teacher-1', ...COMMUNITY_CAPABILITIES);
      unwrap(await remove(admin, 'teacher-1'));
    });
  });

  describe('revoking', () => {
    it('takes the capability away at once; a repeat changes nothing and records nothing', async () => {
      const [lockGrant] = await h.delegate(admin, id, 'teacher-1', 'community.lock');
      h.journal.clear();
      const revoke = () =>
        h.revokeGrant.execute({
          principal: admin,
          communityId: id,
          grantId: lockGrant ?? '',
          meta: META,
        });
      unwrap(await revoke());
      expect(h.journal.order).toEqual([
        'audit:communities.capability.revoked',
        'event:communities.capability.revoked',
      ]);
      expect(h.journal.events[0]?.payload).toEqual({
        communityId: id,
        grantId: lockGrant,
        membershipId: expect.any(String) as string,
        userId: 'teacher-1',
        capability: 'community.lock',
        revokedBy: 'admin-1',
      });
      expect(
        codeOf(
          await h.status.execute({ principal: teacher, communityId: id, to: 'LOCKED', meta: META }),
        ),
      ).toBe('communities.capability_required');
      unwrap(await revoke());
      expect(h.journal.order).toHaveLength(2);
    });

    it('is the owner’s alone, and never reaches a grant of another community', async () => {
      const [lockGrant] = await h.delegate(admin, id, 'teacher-1', 'community.lock');
      await h.delegate(admin, id, 'teacher-2', 'community.members.view');
      const second = principalWith('teacher-2', ['TEACHER']);
      expect(
        codeOf(
          await h.revokeGrant.execute({
            principal: second,
            communityId: id,
            grantId: lockGrant ?? '',
            meta: META,
          }),
        ),
      ).toBe('communities.not_community_owner');
      const other = await h.community(admin, 'أخرى');
      expect(
        codeOf(
          await h.revokeGrant.execute({
            principal: admin,
            communityId: other,
            grantId: lockGrant ?? '',
            meta: META,
          }),
        ),
      ).toBe('communities.grant_not_found');
      expect(
        codeOf(
          await h.revokeGrant.execute({
            principal: admin,
            communityId: id,
            grantId: 'no-such-grant',
            meta: META,
          }),
        ),
      ).toBe('communities.grant_not_found');
    });
  });

  describe('listing grants (Q45)', () => {
    beforeEach(async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.lock', 'community.members.view');
      await h.delegate(admin, id, 'teacher-2', 'community.lock');
    });

    const list = (
      principal: Principal,
      query: {
        userId?: string;
        capability?: 'community.lock';
        cursor?: string;
        limit?: number;
      } = {},
    ) => h.grants.execute({ principal, communityId: id, ...query, meta: META });

    it('shows the owner every grant, by capability then holder, paged', async () => {
      const first = unwrap(await list(admin, { limit: 2 }));
      expect(first.items.map((g) => `${g.capability}/${g.userId}`)).toEqual([
        'community.lock/teacher-1',
        'community.lock/teacher-2',
      ]);
      const rest = unwrap(await list(admin, { limit: 2, cursor: first.nextCursor ?? undefined }));
      expect(rest.items.map((g) => `${g.capability}/${g.userId}`)).toEqual([
        'community.members.view/teacher-1',
      ]);
      expect(rest.nextCursor).toBeNull();
      expect(unwrap(await list(admin, { userId: 'teacher-2' })).items).toHaveLength(1);
      expect(codeOf(await list(admin, { cursor: 'forged' }))).toBe('communities.cursor_invalid');
    });

    it('shows any other member only their own, and hides the community from outsiders', async () => {
      expect(unwrap(await list(teacher)).items.map((g) => g.capability)).toEqual([
        'community.lock',
        'community.members.view',
      ]);
      expect(unwrap(await list(teacher, { userId: 'teacher-2' })).items).toEqual([]);
      const student = principalWith('student-1', ['STUDENT']);
      expect(unwrap(await list(student)).items).toEqual([]);
      const overseer = h.person('owner-role', ['OWNER']);
      expect(codeOf(await list(overseer))).toBe('communities.community_not_found');
      expect(codeOf(await list(h.person('stranger', ['STUDENT'])))).toBe(
        'communities.community_not_found',
      );
    });
  });

  describe('transferring ownership (§6.9)', () => {
    const transfer = (principal: Principal, userId: string) =>
      h.transfer.execute({ principal, communityId: id, userId, meta: META });

    it('hands over: the old owner becomes a member with no grants; the new owner’s grants end', async () => {
      const ended = await h.delegate(admin, id, 'teacher-1', 'community.lock');
      const [kept] = await h.delegate(admin, id, 'teacher-2', 'community.members.view');
      h.journal.clear();

      const view = unwrap(await transfer(admin, 'teacher-1'));
      expect(view.me.standing).toBe('MEMBER');
      // What the ADMIN keeps is oversight, from the role — ownership, and what only it gave, is gone.
      expect(view.me.capabilities).toEqual([
        'community.members.view',
        'community.members.remove',
        'community.lock',
      ]);
      expect(codeOf(await h.authorization.authorize(admin, id, 'community.members.invite'))).toBe(
        'communities.capability_required',
      );
      expect((await me(teacher)).standing).toBe('OWNER');
      expect((await me(teacher)).capabilities).toEqual([...COMMUNITY_CAPABILITIES]);
      expect(h.journal.order).toEqual([
        'audit:communities.ownership.transferred',
        'event:communities.ownership.transferred',
      ]);
      expect(h.journal.events[0]?.payload).toEqual({
        communityId: id,
        fromUserId: 'admin-1',
        toUserId: 'teacher-1',
        transferredBy: 'admin-1',
        basis: 'owner',
        endedGrantIds: ended,
      });
      // Other members' grants survive the handover (Q45).
      const grants = unwrap(
        await h.grants.execute({ principal: teacher, communityId: id, meta: META }),
      );
      expect(grants.items.map((g) => g.grantId)).toEqual([kept]);
      // The former owner no longer grants.
      expect(codeOf(await grant('teacher-2', ['community.lock']))).toBe(
        'communities.not_community_owner',
      );
    });

    it('lets one of two simultaneous transfers win; the other is told ownership changed', async () => {
      const [first, second] = await Promise.all([
        transfer(admin, 'teacher-1'),
        transfer(admin, 'teacher-2'),
      ]);
      expect([codeOf(first), codeOf(second)].sort()).toEqual(['communities.owner_conflict', 'ok']);
      expect(h.journal.actions()).toEqual(['communities.ownership.transferred']);
    });

    it('answers a transfer to the current owner with 200 and records nothing', async () => {
      unwrap(await transfer(admin, 'admin-1'));
      expect(h.journal.order).toEqual([]);
    });

    it('audits an overseer’s transfer that changes nothing — it still shows them the community', async () => {
      const overseer = h.person('owner-role', ['OWNER']);
      unwrap(await transfer(overseer, 'admin-1'));
      expect(h.journal.entries.map((entry) => [entry.action, entry.metadata])).toEqual([
        [
          'communities.oversight.read',
          {
            act: null,
            operation: 'community.ownership.transfer',
            outcome: 'unchanged',
          },
        ],
      ]);
      expect(h.journal.events).toEqual([]);
      // The owner repeating their own ownership reads nothing new: no entry.
      unwrap(await transfer(admin, 'admin-1'));
      expect(h.journal.entries).toHaveLength(1);
    });

    it('lets oversight recover ownership — never for itself', async () => {
      const overseer = h.person('owner-role', ['OWNER']);
      expect(codeOf(await transfer(overseer, 'owner-role'))).toBe(
        'communities.owner_self_assignment',
      );
      const view = unwrap(await transfer(overseer, 'teacher-2'));
      expect(view.me.standing).toBeNull();
      expect(h.journal.events.at(-1)?.payload).toMatchObject({
        basis: 'oversight',
        transferredBy: 'owner-role',
      });
    });

    it('refuses an ineligible target, and anyone who is neither owner nor overseer', async () => {
      h.person('outsider', ['TEACHER']);
      expect(codeOf(await transfer(admin, 'student-1'))).toBe('communities.owner_ineligible');
      expect(codeOf(await transfer(admin, 'outsider'))).toBe('communities.owner_ineligible');
      h.accounts.suspend('teacher-2');
      expect(codeOf(await transfer(admin, 'teacher-2'))).toBe('communities.owner_ineligible');
      expect(codeOf(await transfer(teacher, 'teacher-1'))).toBe('communities.not_community_owner');
      const student = principalWith('student-1', ['STUDENT']);
      expect(codeOf(await transfer(student, 'teacher-1'))).toBe('identity.permission_denied');
      expect(h.journal.entries).toHaveLength(0);
    });
  });

  describe('COMMUNITY_CAPABILITY_HOLDERS', () => {
    it('agrees with the evaluator: the owner and effective grantees, never overseers', async () => {
      await h.delegate(admin, id, 'teacher-1', 'community.live.moderate');
      await h.delegate(admin, id, 'teacher-2', 'community.live.moderate');
      h.accounts.setRoles('teacher-2', ['STUDENT']);
      const page = await h.holders.list(id, 'community.live.moderate', { limit: 100 });
      expect(page).toEqual({ userIds: ['admin-1', 'teacher-1'], nextCursor: null });
      for (const userId of page.userIds) {
        const principal = principalWith(userId, userId === 'admin-1' ? ['ADMIN'] : ['TEACHER']);
        expect((await h.authorization.authorize(principal, id, 'community.live.moderate')).ok).toBe(
          true,
        );
      }
    });
  });
});
