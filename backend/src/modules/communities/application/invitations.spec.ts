import type { Principal } from '../../../shared';
import {
  META,
  codeOf,
  communitiesHarness,
  type CommunitiesHarness,
} from '../../../../test/support/communities-harness';

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

describe('invitation links', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let id: string;

  beforeEach(async () => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    id = await h.community(admin);
    h.journal.clear();
  });

  const student = (userId: string) => h.person(userId, ['STUDENT']);
  const redeem = (principal: Principal, token: unknown) =>
    h.redeem.execute({ principal, token, meta: META });
  const usesOf = async (invitationId: string) =>
    (await h.readModel.findInvitation(id, invitationId))?.uses;

  describe('the token', () => {
    it('is shown once, at creation — never listed, audited, announced or stored', async () => {
      const created = unwrap(
        await h.invite.execute({ principal: admin, communityId: id, maxUses: 5, meta: META }),
      );
      expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.invitation).toMatchObject({
        createdBy: 'admin-1',
        maxUses: 5,
        uses: 0,
        state: 'ACTIVE',
        revokedAt: null,
      });
      expect(created.invitation.expiresAt.getTime() - created.invitation.createdAt.getTime()).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
      const hash = h.secrets.hash(created.token);
      const stored = await h.readModel.findInvitation(id, created.invitation.id);
      expect(stored?.tokenHash).toBe(hash);

      await redeem(student('s1'), created.token);
      const listed = unwrap(
        await h.invitations.execute({ principal: admin, communityId: id, meta: META }),
      );
      const everywhere = JSON.stringify([listed, h.journal.entries, h.journal.events]);
      expect(everywhere).not.toContain(created.token);
      expect(everywhere).not.toContain(hash);
      expect(JSON.stringify(stored)).not.toContain(created.token);
    });

    it('answers a malformed token, an unknown one and a token in the wrong place identically', async () => {
      const s1 = student('s1');
      const answers = await Promise.all(
        ['short', 'A'.repeat(43), { token: 'x' }, undefined, `${'A'.repeat(42)}=`].map(
          async (token) => (await redeem(s1, token)).ok === false && (await redeem(s1, token)),
        ),
      );
      for (const answer of answers) {
        expect(answer).toMatchObject({
          ok: false,
          error: { kind: 'not_found', code: 'communities.invitation_invalid' },
        });
      }
    });
  });

  describe('redemption', () => {
    it('joins once: 201, then 200 with no use consumed and nothing recorded', async () => {
      const { token, invitationId } = await h.link(admin, id, { maxUses: 3 });
      h.journal.clear();
      const s1 = student('s1');
      const first = unwrap(await redeem(s1, token));
      expect(first.kind).toBe('joined');
      expect(first.community.me).toMatchObject({ standing: 'MEMBER' });
      const second = unwrap(await redeem(s1, token));
      expect(second.kind).toBe('already_member');
      expect(await usesOf(invitationId)).toBe(1);
      expect(h.journal.order).toEqual([
        'audit:communities.member.joined',
        'event:communities.member.added',
      ]);
      expect(h.journal.entries[0]).toMatchObject({
        actorUserId: 's1',
        metadata: { invitationId, membershipVersion: 2 },
      });
      expect(h.journal.events[0]?.payload).toMatchObject({
        source: 'INVITATION',
        invitationId,
        addedBy: null,
      });
    });

    it('lets simultaneous redemptions by one person make one member and use one use', async () => {
      const { token, invitationId } = await h.link(admin, id);
      const s1 = student('s1');
      // Ten through the use case — the per-person attempt limit…
      const results = await Promise.all(Array.from({ length: 10 }, () => redeem(s1, token)));
      expect(results.filter((r) => r.ok && r.value.kind === 'joined')).toHaveLength(1);
      expect(results.filter((r) => r.ok && r.value.kind === 'already_member')).toHaveLength(9);
      // …and twenty straight at the store, as the Postgres suite does.
      const s2 = student('s2');
      const direct = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          h.store.redeem({
            invitationId,
            communityId: id,
            userId: s2.userId,
            creatorUserId: 'admin-1',
            creatorCapability: 'community.members.invite',
            stintId: `double-click-${i}`,
            at: h.clock.now(),
          }),
        ),
      );
      expect(direct.filter((outcome) => outcome.kind === 'joined')).toHaveLength(1);
      expect(direct.filter((outcome) => outcome.kind === 'already_member')).toHaveLength(19);
      expect(await usesOf(invitationId)).toBe(2);
    });

    it('admits exactly max_uses of fifty people racing for the last places', async () => {
      const { token, invitationId } = await h.link(admin, id, { maxUses: 10 });
      const people = Array.from({ length: 50 }, (_, i) => student(`racer-${i}`));
      const results = await Promise.all(people.map((person) => redeem(person, token)));
      expect(results.filter((r) => r.ok)).toHaveLength(10);
      expect(results.filter((r) => codeOf(r) === 'communities.invitation_exhausted')).toHaveLength(
        40,
      );
      expect(await usesOf(invitationId)).toBe(10);
      const view = unwrap(await h.get.execute({ principal: admin, communityId: id, meta: META }));
      expect(view.memberCount).toBe(11);
    });

    it('refuses a revoked, expired or exhausted link, and consumes nothing', async () => {
      const revoked = await h.link(admin, id);
      unwrap(
        await h.revoke.execute({
          principal: admin,
          communityId: id,
          invitationId: revoked.invitationId,
          meta: META,
        }),
      );
      expect(codeOf(await redeem(student('s1'), revoked.token))).toBe(
        'communities.invitation_revoked',
      );

      const expiring = await h.link(admin, id, { expiresInSeconds: 300 });
      h.clock.advance(300);
      expect(codeOf(await redeem(student('s2'), expiring.token))).toBe(
        'communities.invitation_expired',
      );

      const once = await h.link(admin, id, { maxUses: 1 });
      unwrap(await redeem(student('s3'), once.token));
      expect(codeOf(await redeem(student('s4'), once.token))).toBe(
        'communities.invitation_exhausted',
      );
      expect(await usesOf(revoked.invitationId)).toBe(0);
      expect(await usesOf(expiring.invitationId)).toBe(0);
      expect(await usesOf(once.invitationId)).toBe(1);
    });

    it('suspends every link while LOCKED — neither consumed nor revoked — and resumes on unlock', async () => {
      const { token, invitationId } = await h.link(admin, id, { maxUses: 2 });
      unwrap(
        await h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META }),
      );
      const s1 = student('s1');
      expect(codeOf(await redeem(s1, token))).toBe('communities.community_locked');
      expect(await usesOf(invitationId)).toBe(0);
      unwrap(await h.status.execute({ principal: admin, communityId: id, to: 'OPEN', meta: META }));
      expect(unwrap(await redeem(s1, token)).kind).toBe('joined');
    });

    it('lets someone who left come back by link, but not someone who was removed', async () => {
      const { token } = await h.link(admin, id);
      const leaver = student('leaver');
      const removed = student('removed');
      unwrap(await redeem(leaver, token));
      unwrap(await redeem(removed, token));
      unwrap(await h.leave.execute({ principal: leaver, communityId: id, meta: META }));
      unwrap(
        await h.remove.execute({
          principal: admin,
          communityId: id,
          userId: 'removed',
          meta: META,
        }),
      );
      expect(unwrap(await redeem(leaver, token)).kind).toBe('joined');
      expect(await redeem(removed, token)).toMatchObject({
        ok: false,
        error: { kind: 'forbidden', code: 'communities.rejoin_requires_manager' },
      });
      // A rejoin is a new stint.
      const [state] = await h.membership.statesOf(id, ['leaver']);
      expect(state).toMatchObject({ active: true });
    });

    it('fails closed when the owner who made the link can no longer admit anyone (Q48)', async () => {
      const { token, invitationId } = await h.link(admin, id);
      h.accounts.setRoles('admin-1', ['STUDENT']); // demoted: no communities.moderate
      expect(codeOf(await redeem(student('s1'), token))).toBe('communities.invitation_invalid');
      h.accounts.setRoles('admin-1', ['ADMIN']);
      h.accounts.suspend('admin-1');
      expect(codeOf(await redeem(student('s2'), token))).toBe('communities.invitation_invalid');
      expect(await usesOf(invitationId)).toBe(0);
    });

    it('limits attempts per person, and says when to try again', async () => {
      const s1 = student('s1');
      for (let i = 0; i < 10; i += 1) await redeem(s1, 'A'.repeat(43));
      expect(await redeem(s1, 'A'.repeat(43))).toMatchObject({
        ok: false,
        error: {
          kind: 'rate_limited',
          code: 'communities.too_many_attempts',
          details: { retryAfterSeconds: expect.any(Number) as number },
        },
      });
    });

    it('never lets a guardian or an unknown role join — the seam requires communities.read', async () => {
      const { token } = await h.link(admin, id);
      const nobody: Principal = { userId: 'no-roles', roles: [], permissions: new Set() };
      expect(codeOf(await redeem(nobody, token))).toBe('identity.permission_denied');
    });
  });

  describe('managing links', () => {
    it('revokes once; a repeat changes nothing and records nothing', async () => {
      const { invitationId } = await h.link(admin, id);
      h.journal.clear();
      const revoked = unwrap(
        await h.revoke.execute({ principal: admin, communityId: id, invitationId, meta: META }),
      );
      expect(revoked).toMatchObject({ state: 'REVOKED', revokedAt: h.clock.now() });
      unwrap(
        await h.revoke.execute({ principal: admin, communityId: id, invitationId, meta: META }),
      );
      expect(h.journal.order).toEqual([
        'audit:communities.invitation.revoked',
        'event:communities.invitation.revoked',
      ]);
      expect(h.journal.entries[0]?.metadata).toMatchObject({ invitationId });
    });

    it('lets an overseer kill a leaked link, even while LOCKED', async () => {
      const { invitationId } = await h.link(admin, id);
      unwrap(
        await h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META }),
      );
      const overseer = h.person('owner-role', ['OWNER']);
      const revoked = unwrap(
        await h.revoke.execute({ principal: overseer, communityId: id, invitationId, meta: META }),
      );
      expect(revoked.state).toBe('REVOKED');
      expect(h.journal.entries.at(-1)?.metadata).toMatchObject({
        authority: { basis: 'oversight', membershipId: null },
      });
    });

    it('finds a link only inside its own community', async () => {
      const other = await h.community(admin, 'another');
      const { invitationId } = await h.link(admin, other);
      expect(
        codeOf(
          await h.revoke.execute({ principal: admin, communityId: id, invitationId, meta: META }),
        ),
      ).toBe('communities.invitation_not_found');
    });

    it('refuses terms outside the provisional bounds, naming the field', async () => {
      const refused = await h.invite.execute({
        principal: admin,
        communityId: id,
        expiresInSeconds: 30 * 24 * 60 * 60 + 1,
        meta: META,
      });
      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: 'communities.invitation_terms_invalid',
          details: { field: 'expiresInSeconds' },
        },
      });
    });

    it('lists links newest first, each with its state derived now', async () => {
      const older = await h.link(admin, id, { expiresInSeconds: 300 });
      h.clock.advance(10);
      const newer = await h.link(admin, id);
      h.clock.advance(300);
      const page = unwrap(
        await h.invitations.execute({ principal: admin, communityId: id, meta: META }),
      );
      expect(page.items.map((item) => [item.id, item.state])).toEqual([
        [newer.invitationId, 'ACTIVE'],
        [older.invitationId, 'EXPIRED'],
      ]);
    });
  });
});
