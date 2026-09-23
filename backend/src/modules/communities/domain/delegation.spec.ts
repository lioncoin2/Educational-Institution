import type { CommunityCapability } from '../contracts/capabilities';
import { MANAGE_GRANTS, TRANSFER_OWNERSHIP } from './act-rules';
import type { HeldCeilings } from './authority';
import {
  ceilingOf,
  decideOwnerOperation,
  effectiveCapabilities,
  mayGrant,
  mayRemove,
  mayTransfer,
} from './delegation';

const OPEN = { status: 'OPEN' };
const LOCKED = { status: 'LOCKED' };
const stint = (standing: 'OWNER' | 'MEMBER') => ({
  id: `stint-${standing}`,
  standing,
  joinedAt: new Date(1),
  version: 1,
  grants: [],
});

const owner: HeldCeilings = { standing: true, oversight: false };
const overseer: HeldCeilings = { standing: false, oversight: true };
const both: HeldCeilings = { standing: true, oversight: true };
const none: HeldCeilings = { standing: false, oversight: false };

const outcome = (decision: ReturnType<typeof decideOwnerOperation>) =>
  decision.kind === 'permit'
    ? `permit:${decision.basis}`
    : decision.kind === 'no_ceiling'
      ? 'no_ceiling'
      : decision.failure.code;

/** Pins the PROVISIONAL delegation rules (§6.8–§6.10; Q42, Q44, Q45). */
describe('the owner operations (R1, §6.9)', () => {
  it('need communities.moderate; only a transfer is reachable by oversight', () => {
    expect(MANAGE_GRANTS).toEqual({
      name: 'community.grants.manage',
      ownerCeiling: ['communities.moderate'],
      oversightCeiling: null,
    });
    expect(TRANSFER_OWNERSHIP).toEqual({
      name: 'community.ownership.transfer',
      ownerCeiling: ['communities.moderate'],
      oversightCeiling: ['communities.manage'],
    });
  });

  it('let the owner manage grants — nobody else, and no grant ever', () => {
    expect(
      outcome(
        decideOwnerOperation(MANAGE_GRANTS, owner, { community: OPEN, stint: stint('OWNER') }),
      ),
    ).toBe('permit:owner');
    // A member holding every capability by grant is still not the owner: no sub-delegation.
    const delegate = stint('MEMBER');
    expect(
      outcome(decideOwnerOperation(MANAGE_GRANTS, both, { community: OPEN, stint: delegate })),
    ).toBe('communities.not_community_owner');
    // Oversight reaches no grant: a non-member overseer hears "no such community".
    expect(
      outcome(decideOwnerOperation(MANAGE_GRANTS, both, { community: OPEN, stint: null })),
    ).toBe('communities.community_not_found');
    expect(
      outcome(decideOwnerOperation(MANAGE_GRANTS, overseer, { community: OPEN, stint: null })),
    ).toBe('no_ceiling');
  });

  it('answer a missing community and one the caller is not in identically', () => {
    const missing = decideOwnerOperation(MANAGE_GRANTS, owner, { community: null, stint: null });
    expect(decideOwnerOperation(MANAGE_GRANTS, owner, { community: OPEN, stint: null })).toEqual(
      missing,
    );
    expect(outcome(missing)).toBe('communities.community_not_found');
  });

  it('refuse an owner without the ceiling — ownership dormant — before any basis', () => {
    expect(
      outcome(
        decideOwnerOperation(MANAGE_GRANTS, none, { community: OPEN, stint: stint('OWNER') }),
      ),
    ).toBe('no_ceiling');
    // …but oversight may still recover ownership by transfer.
    expect(
      outcome(
        decideOwnerOperation(TRANSFER_OWNERSHIP, overseer, {
          community: OPEN,
          stint: stint('OWNER'),
        }),
      ),
    ).toBe('permit:oversight');
  });

  it('prefer the owner basis to oversight, and are never closed by the lifecycle', () => {
    expect(
      decideOwnerOperation(TRANSFER_OWNERSHIP, both, { community: LOCKED, stint: stint('OWNER') }),
    ).toMatchObject({
      kind: 'permit',
      basis: 'owner',
      membership: { membershipId: 'stint-OWNER' },
    });
    expect(
      decideOwnerOperation(TRANSFER_OWNERSHIP, overseer, { community: LOCKED, stint: null }),
    ).toEqual({ kind: 'permit', basis: 'oversight', membership: null });
    expect(
      outcome(
        decideOwnerOperation(TRANSFER_OWNERSHIP, owner, {
          community: OPEN,
          stint: stint('MEMBER'),
        }),
      ),
    ).toBe('communities.not_community_owner');
  });
});

describe('who may receive a grant (R3, R5)', () => {
  it('is an ACTIVE member who is neither the owner nor the grantor', () => {
    expect(mayGrant({ grantorUserId: 'o', grantee: { userId: 'm', standing: 'MEMBER' } })).toBe(
      true,
    );
    expect(mayGrant({ grantorUserId: 'o', grantee: null })).toBe(false);
    expect(mayGrant({ grantorUserId: 'o', grantee: { userId: 'x', standing: 'OWNER' } })).toBe(
      false,
    );
    expect(mayGrant({ grantorUserId: 'o', grantee: { userId: 'o', standing: 'MEMBER' } })).toBe(
      false,
    );
  });

  it('needs every permission of the capability’s ceiling (R2 and R3 alike)', () => {
    expect(ceilingOf('community.lock')).toEqual(['communities.moderate']);
    expect(ceilingOf('community.chat.post')).toEqual(['communities.moderate', 'messaging.send']);
    expect(ceilingOf('community.live.start')).toEqual(['communities.moderate', 'live.moderate']);
  });
});

describe('dormancy (R4)', () => {
  it('keeps a grant whose ceiling is gone, but never counts it', () => {
    const granted: CommunityCapability[] = ['community.lock', 'community.live.moderate'];
    expect([...effectiveCapabilities(granted, new Set(['community.lock']))]).toEqual([
      'community.lock',
    ]);
    expect([...effectiveCapabilities(granted, new Set())]).toEqual([]);
    // A ceiling without a grant gives nothing either.
    expect([...effectiveCapabilities([], new Set(['community.lock']))]).toEqual([]);
  });
});

describe('who may be removed (§3.2, R6)', () => {
  const remover = new Set<CommunityCapability>(['community.members.remove', 'community.lock']);
  const member = { userId: 'm', standing: 'MEMBER' as const };

  it('never the owner — whatever the basis', () => {
    for (const basis of ['owner', 'grant', 'oversight'] as const) {
      expect(
        mayRemove({
          basis,
          target: { userId: 'o', standing: 'OWNER' },
          targetGrants: [],
          removerUserId: 'r',
          removerEffective: remover,
        }),
      ).toBe('owner');
    }
  });

  it('never oneself — whatever the basis: that is a leave (Q49)', () => {
    for (const basis of ['grant', 'oversight'] as const) {
      expect(
        mayRemove({
          basis,
          target: member,
          targetGrants: [],
          removerUserId: 'm',
          removerEffective: remover,
        }),
      ).toBe('self');
    }
    // The owner removing themself is refused as the owner.
    expect(
      mayRemove({
        basis: 'owner',
        target: { userId: 'o', standing: 'OWNER' },
        targetGrants: [],
        removerUserId: 'o',
        removerEffective: new Set(),
      }),
    ).toBe('owner');
  });

  it('bounds a delegate by a subset rule that counts dormant grants', () => {
    const decide = (targetGrants: CommunityCapability[]) =>
      mayRemove({
        basis: 'grant',
        target: member,
        targetGrants,
        removerUserId: 'r',
        removerEffective: remover,
      });
    expect(decide([])).toBe('allowed');
    expect(decide(['community.lock'])).toBe('allowed');
    expect(decide(['community.lock', 'community.members.remove'])).toBe('allowed');
    // The target's live.moderate may be dormant — it still counts: dormant can come back.
    expect(decide(['community.lock', 'community.live.moderate'])).toBe('holds_more');
  });

  it('does not bound the owner or oversight', () => {
    for (const basis of ['owner', 'oversight'] as const) {
      expect(
        mayRemove({
          basis,
          target: member,
          targetGrants: ['community.live.moderate', 'community.chat.post'],
          removerUserId: basis === 'owner' ? 'o' : null,
          removerEffective: new Set(),
        }),
      ).toBe('allowed');
    }
  });

  it('lets two delegates with equal sets remove each other — one at a time (Q44)', () => {
    const same = new Set<CommunityCapability>(['community.members.remove']);
    expect(
      mayRemove({
        basis: 'grant',
        target: member,
        targetGrants: ['community.members.remove'],
        removerUserId: 'r',
        removerEffective: same,
      }),
    ).toBe('allowed');
  });
});

describe('a transfer naming its own actor (§6.9)', () => {
  it('changes nothing for the owner, and is refused to an overseer', () => {
    expect(
      mayTransfer({ basis: 'owner', actorUserId: 'o', actorIsOwner: true, targetUserId: 'o' }),
    ).toBe('unchanged');
    expect(
      mayTransfer({ basis: 'oversight', actorUserId: 'a', actorIsOwner: false, targetUserId: 'a' }),
    ).toBe('self_assignment');
    // An overseer who already is the owner names the owner: nothing to change.
    expect(
      mayTransfer({ basis: 'oversight', actorUserId: 'a', actorIsOwner: true, targetUserId: 'a' }),
    ).toBe('unchanged');
    expect(
      mayTransfer({ basis: 'oversight', actorUserId: 'a', actorIsOwner: false, targetUserId: 'm' }),
    ).toBe('proceed');
    expect(
      mayTransfer({ basis: 'owner', actorUserId: 'o', actorIsOwner: true, targetUserId: 'm' }),
    ).toBe('proceed');
  });
});
