import type { CommunityAct } from '../contracts/capabilities';
import { ACT_RULES, LINK_MANAGEMENT_RULE, type ActRule } from './act-rules';
import { decideCommunityAct, type AuthorityRead, type HeldCeilings } from './authority';

const OPEN = { status: 'OPEN' };
const LOCKED = { status: 'LOCKED' };
const FUTURE = { status: 'ARCHIVED' }; // a status this build does not know

const ownerStint = {
  id: 'stint-o',
  standing: 'OWNER' as const,
  joinedAt: new Date(1),
  version: 1,
  grants: [],
};
const memberStint = {
  id: 'stint-m',
  standing: 'MEMBER' as const,
  joinedAt: new Date(2),
  version: 2,
  grants: [],
};

const both: HeldCeilings = { standing: true, oversight: true };
const standingOnly: HeldCeilings = { standing: true, oversight: false };
const oversightOnly: HeldCeilings = { standing: false, oversight: true };
const none: HeldCeilings = { standing: false, oversight: false };

function decide(rule: ActRule | CommunityAct, held: HeldCeilings, read: AuthorityRead) {
  return decideCommunityAct(typeof rule === 'string' ? ACT_RULES[rule] : rule, held, read);
}

const outcome = (decision: ReturnType<typeof decide>) =>
  decision.kind === 'permit'
    ? `permit:${decision.basis}`
    : decision.kind === 'no_ceiling'
      ? 'no_ceiling'
      : decision.failure.code;

describe('decideCommunityAct — the evaluator (§6.5)', () => {
  it('refuses before reading anything when no path has its ceiling', () => {
    // A member-less read, or the owner's: without a ceiling the answer is the same.
    expect(outcome(decide('community.members.view', none, { community: OPEN, stint: null }))).toBe(
      'no_ceiling',
    );
    expect(
      outcome(decide('community.members.view', none, { community: OPEN, stint: ownerStint })),
    ).toBe('no_ceiling');
    // An act with no oversight path: the oversight ceiling alone reaches nothing.
    expect(
      outcome(decide('community.members.invite', oversightOnly, { community: null, stint: null })),
    ).toBe('no_ceiling');
  });

  it('answers a missing community and a community one is not in identically', () => {
    const missing = decide('community.view', standingOnly, { community: null, stint: null });
    const notMember = decide('community.view', standingOnly, { community: OPEN, stint: null });
    expect(missing).toEqual(notMember);
    expect(outcome(missing)).toBe('communities.community_not_found');
    // …even for a capability, and even for someone holding every ceiling but oversight.
    expect(decide('community.lock', standingOnly, { community: LOCKED, stint: null })).toEqual(
      missing,
    );
  });

  it('gives participation acts to members by membership — never to non-members', () => {
    for (const act of [
      'community.view',
      'community.chat.read',
      'community.live.join',
      'community.live.raise_hand',
    ] as const) {
      expect(outcome(decide(act, standingOnly, { community: OPEN, stint: memberStint }))).toBe(
        'permit:membership',
      );
      // The owner is a member first.
      expect(outcome(decide(act, standingOnly, { community: OPEN, stint: ownerStint }))).toBe(
        'permit:membership',
      );
    }
  });

  it('gives the owner every capability within its ceiling — and none without it', () => {
    for (const act of [
      'community.members.view',
      'community.members.invite',
      'community.members.remove',
      'community.lock',
      'community.chat.post',
      'community.live.start',
      'community.live.moderate',
      'community.live.host',
    ] as const) {
      expect(outcome(decide(act, standingOnly, { community: OPEN, stint: ownerStint }))).toBe(
        'permit:owner',
      );
    }
    // A demoted owner who still takes part: the owner path needs the ceiling.
    const demoted = decide('community.lock', none, { community: OPEN, stint: ownerStint });
    expect(outcome(demoted)).toBe('no_ceiling');
  });

  it('refuses a member without the capability — naming the act, not hiding the community', () => {
    const decision = decide('community.lock', standingOnly, {
      community: OPEN,
      stint: memberStint,
    });
    expect(decision).toEqual({
      kind: 'refused',
      failure: {
        kind: 'forbidden',
        code: 'communities.capability_required',
        message: expect.any(String) as string,
        details: { act: 'community.lock' },
      },
    });
  });

  it('reaches only the oversight acts without membership, and records no stint', () => {
    for (const act of [
      'community.view',
      'community.members.view',
      'community.members.remove',
      'community.lock',
    ] as const) {
      const decision = decide(act, oversightOnly, { community: OPEN, stint: null });
      expect(decision).toMatchObject({
        kind: 'permit',
        basis: 'oversight',
        membership: null,
        ceiling: ['communities.manage'],
      });
    }
    for (const act of [
      'community.members.invite',
      'community.chat.read',
      'community.chat.post',
      'community.live.start',
      'community.live.join',
      'community.live.moderate',
    ] as const) {
      expect(outcome(decide(act, both, { community: OPEN, stint: null }))).toBe(
        'communities.community_not_found',
      );
    }
  });

  it('prefers standing over oversight, so an owner acting is recorded as the owner', () => {
    const decision = decide('community.lock', both, { community: OPEN, stint: ownerStint });
    expect(decision).toMatchObject({
      kind: 'permit',
      basis: 'owner',
      membership: { membershipId: 'stint-o', joinedAt: new Date(1), version: 1 },
      ceiling: ['communities.moderate'],
    });
    // A plain member with the oversight ceiling acts by oversight.
    expect(outcome(decide('community.lock', both, { community: OPEN, stint: memberStint }))).toBe(
      'permit:oversight',
    );
  });

  it('applies the lifecycle only after the basis, so a non-member never learns the state', () => {
    expect(
      outcome(decide('community.members.invite', standingOnly, { community: LOCKED, stint: null })),
    ).toBe('communities.community_not_found');
    expect(
      outcome(
        decide('community.members.invite', standingOnly, {
          community: LOCKED,
          stint: ownerStint,
        }),
      ),
    ).toBe('communities.community_locked');
  });

  it('never blocks community.lock, so a locked community can always be unlocked', () => {
    expect(
      outcome(decide('community.lock', standingOnly, { community: LOCKED, stint: ownerStint })),
    ).toBe('permit:owner');
    expect(
      outcome(decide('community.lock', oversightOnly, { community: FUTURE, stint: null })),
    ).toBe('permit:oversight');
  });

  it('lets an overseer list and revoke links — and keeps that open while LOCKED', () => {
    expect(
      outcome(decide(LINK_MANAGEMENT_RULE, oversightOnly, { community: LOCKED, stint: null })),
    ).toBe('permit:oversight');
    expect(
      outcome(decide(LINK_MANAGEMENT_RULE, standingOnly, { community: LOCKED, stint: ownerStint })),
    ).toBe('permit:owner');
    // Creating a link is the plain rule: no oversight, closed while LOCKED.
    expect(
      outcome(decide('community.members.invite', oversightOnly, { community: OPEN, stint: null })),
    ).toBe('no_ceiling');
  });

  describe('the grant basis (P3)', () => {
    const delegate = (...capabilities: string[]) => ({
      ...memberStint,
      grants: capabilities.map((capability, i) => ({
        id: `grant-${i}`,
        capability: capability as 'community.lock',
      })),
    });

    it('gives a member exactly the capabilities granted, within the ceiling', () => {
      const read = { community: OPEN, stint: delegate('community.lock', 'community.members.view') };
      expect(decide('community.lock', standingOnly, read)).toMatchObject({
        kind: 'permit',
        basis: 'grant',
        grantId: 'grant-0',
        membership: { membershipId: 'stint-m' },
        ceiling: ['communities.moderate'],
      });
      expect(outcome(decide('community.members.view', standingOnly, read))).toBe('permit:grant');
      // A capability not granted stays refused, naming the act.
      expect(outcome(decide('community.members.remove', standingOnly, read))).toBe(
        'communities.capability_required',
      );
    });

    it('never counts a grant without its ceiling — dormant, not deleted (R4)', () => {
      const read = { community: OPEN, stint: delegate('community.lock') };
      expect(outcome(decide('community.lock', none, read))).toBe('no_ceiling');
      // With only oversight left, the act is taken on oversight, not the dormant grant.
      expect(decide('community.lock', oversightOnly, read)).toMatchObject({
        kind: 'permit',
        basis: 'oversight',
        grantId: null,
        membership: null,
      });
    });

    it('backs community.live.host by a grant of community.live.start', () => {
      const read = { community: OPEN, stint: delegate('community.live.start') };
      expect(decide('community.live.host', standingOnly, read)).toMatchObject({
        basis: 'grant',
        grantId: 'grant-0',
      });
      expect(outcome(decide('community.live.moderate', standingOnly, read))).toBe(
        'communities.capability_required',
      );
    });

    it('never gives a participation act — membership alone does', () => {
      const read = { community: OPEN, stint: delegate('community.chat.post') };
      expect(decide('community.chat.read', standingOnly, read)).toMatchObject({
        basis: 'membership',
        grantId: null,
      });
    });

    it('ranks after the owner and before oversight; the lifecycle still applies after it', () => {
      expect(
        outcome(
          decide('community.lock', both, { community: OPEN, stint: delegate('community.lock') }),
        ),
      ).toBe('permit:grant');
      expect(
        outcome(
          decide('community.members.invite', standingOnly, {
            community: LOCKED,
            stint: delegate('community.members.invite'),
          }),
        ),
      ).toBe('communities.community_locked');
      // A grant on nobody's stint is no basis: the owner path and the grant path both need a stint.
      expect(
        outcome(decide('community.lock', standingOnly, { community: OPEN, stint: null })),
      ).toBe('communities.community_not_found');
    });
  });

  it('closes every new action on a status it does not know, and ejects nobody', () => {
    const read = { community: FUTURE, stint: ownerStint };
    expect(outcome(decide('community.view', standingOnly, read))).toBe('permit:membership');
    expect(outcome(decide('community.members.remove', standingOnly, read))).toBe('permit:owner');
    for (const act of [
      'community.members.invite',
      'community.chat.read',
      'community.chat.post',
      'community.live.start',
      'community.live.join',
    ] as const) {
      expect(outcome(decide(act, standingOnly, read))).toBe('communities.community_locked');
    }
    expect(outcome(decide('community.live.host', standingOnly, read))).toBe('permit:owner');
    expect(outcome(decide('community.live.moderate', standingOnly, read))).toBe('permit:owner');
  });
});
