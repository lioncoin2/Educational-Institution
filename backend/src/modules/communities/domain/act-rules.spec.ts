import { ALL_PERMISSIONS, isPermission } from '../../identity/contracts/permissions';
import {
  COMMUNITY_ACTS,
  COMMUNITY_CAPABILITIES,
  COMMUNITY_CHAT_READ_CEILING,
  COMMUNITY_DERIVED_ACTS,
  COMMUNITY_OPERATIONS,
  COMMUNITY_PARTICIPATION,
  COMMUNITY_VIEW_CEILING,
  isCommunityAct,
  isCommunityCapability,
  isCommunityOperation,
  isCommunityParticipationAct,
} from '../contracts/capabilities';
import {
  ACT_RULES,
  LINK_MANAGEMENT_RULE,
  MANAGE_GRANTS,
  TRANSFER_OWNERSHIP,
  backingCapability,
} from './act-rules';

/**
 * Pins the PROVISIONAL act rules (§6.4). Answering Q43, Q44, Q46, Q51 or Q54
 * edits the table and this test together — never a consumer.
 */
describe('the act rules (PROVISIONAL)', () => {
  const table = Object.fromEntries(
    COMMUNITY_ACTS.map((act) => {
      const rule = ACT_RULES[act];
      return [
        act,
        {
          standing: rule.standingCeiling.join(' + '),
          oversight: rule.oversightCeiling?.join(' + ') ?? null,
          owner: rule.ownerImplicit,
          gate: rule.gate,
        },
      ];
    }),
  );

  it('asks a chat reader for exactly the published read ceiling — the one messaging narrows recipients by', () => {
    expect(COMMUNITY_CHAT_READ_CEILING).toEqual(['communities.read', 'messaging.read']);
    expect(ACT_RULES['community.chat.read'].standingCeiling).toEqual(COMMUNITY_CHAT_READ_CEILING);
    expect(Object.isFrozen(COMMUNITY_CHAT_READ_CEILING)).toBe(true);
  });

  it('asks a viewer for exactly the published view ceiling — the one realtime narrows community frames by', () => {
    expect(COMMUNITY_VIEW_CEILING).toEqual(['communities.read']);
    expect(ACT_RULES['community.view'].standingCeiling).toEqual(COMMUNITY_VIEW_CEILING);
    expect(ACT_RULES['community.view'].oversightCeiling).toEqual(['communities.manage']);
    expect(Object.isFrozen(COMMUNITY_VIEW_CEILING)).toBe(true);
  });

  it('is exactly the table the design states', () => {
    expect(table).toEqual({
      'community.view': {
        standing: 'communities.read',
        oversight: 'communities.manage',
        owner: false,
        gate: 'always',
      },
      'community.members.view': {
        standing: 'communities.moderate',
        oversight: 'communities.manage',
        owner: true,
        gate: 'always',
      },
      'community.members.invite': {
        standing: 'communities.moderate',
        oversight: null,
        owner: true,
        gate: 'acceptsMembers',
      },
      'community.members.remove': {
        standing: 'communities.moderate',
        oversight: 'communities.manage',
        owner: true,
        gate: 'always',
      },
      'community.lock': {
        standing: 'communities.moderate',
        oversight: 'communities.manage',
        owner: true,
        gate: 'always',
      },
      'community.chat.read': {
        standing: 'communities.read + messaging.read',
        oversight: null,
        owner: false,
        gate: 'chatReadable',
      },
      'community.chat.post': {
        standing: 'communities.moderate + messaging.send',
        oversight: null,
        owner: true,
        gate: 'chatPostingOpen',
      },
      'community.messages.moderate': {
        standing: 'communities.moderate',
        oversight: null,
        owner: true,
        gate: 'always',
      },
      'community.live.start': {
        standing: 'communities.moderate + live.moderate',
        oversight: null,
        owner: true,
        gate: 'liveStartOpen',
      },
      'community.live.host': {
        standing: 'communities.moderate + live.moderate',
        oversight: null,
        owner: true,
        gate: 'runningLiveContinues',
      },
      'community.live.moderate': {
        standing: 'communities.moderate + live.moderate',
        oversight: null,
        owner: true,
        gate: 'always',
      },
      'community.live.join': {
        standing: 'communities.read + live.join',
        oversight: null,
        owner: false,
        gate: 'liveJoinOpen',
      },
      'community.live.remain': {
        standing: 'communities.read + live.join',
        oversight: null,
        owner: false,
        gate: 'runningLiveContinues',
      },
      'community.live.raise_hand': {
        standing: 'communities.read + live.raise_hand',
        oversight: null,
        owner: false,
        gate: 'liveJoinOpen',
      },
      'community.attendance.record': {
        standing: 'communities.moderate',
        oversight: null,
        owner: true,
        gate: 'always',
      },
      'community.attendance.view': {
        standing: 'communities.moderate',
        oversight: null,
        owner: true,
        gate: 'always',
      },
    });
  });

  it('names catalogued identity permissions only', () => {
    for (const rule of [...Object.values(ACT_RULES), LINK_MANAGEMENT_RULE]) {
      for (const permission of [...rule.standingCeiling, ...(rule.oversightCeiling ?? [])]) {
        expect({ act: rule.act, permission, catalogued: isPermission(permission) }).toEqual({
          act: rule.act,
          permission,
          catalogued: true,
        });
      }
    }
  });

  it('requires communities.moderate for every capability and every derived act backed by one', () => {
    const backed = COMMUNITY_ACTS.filter((act) => backingCapability(act) !== null);
    expect(backed).toEqual([...COMMUNITY_CAPABILITIES, 'community.live.host']);
    for (const act of backed) {
      expect(ACT_RULES[act].standingCeiling).toContain('communities.moderate');
      expect(ACT_RULES[act].ownerImplicit).toBe(true);
    }
  });

  it('gives the membership-basis acts by membership only — never by owner or grant', () => {
    const membershipBasis = COMMUNITY_ACTS.filter((act) => ACT_RULES[act].kind === 'participation');
    expect(membershipBasis).toEqual([...COMMUNITY_PARTICIPATION, 'community.live.remain']);
    for (const act of membershipBasis) {
      expect(ACT_RULES[act]).toMatchObject({ kind: 'participation', ownerImplicit: false });
      expect(ACT_RULES[act].standingCeiling).toContain('communities.read');
    }
  });

  it('keeps community.live.remain on community.live.join’s ceiling and basis, gated to stay', () => {
    const remain = ACT_RULES['community.live.remain'];
    const join = ACT_RULES['community.live.join'];
    // Listed as a derived act — neither a participation act nor a capability.
    expect(COMMUNITY_DERIVED_ACTS).toEqual(['community.live.host', 'community.live.remain']);
    expect(isCommunityParticipationAct('community.live.remain')).toBe(false);
    expect(isCommunityCapability('community.live.remain')).toBe(false);
    // Its whole row: the membership basis, whatever its name would suggest.
    expect(remain).toEqual({
      act: 'community.live.remain',
      kind: 'participation',
      standingCeiling: ['communities.read', 'live.join'],
      ownerImplicit: false,
      oversightCeiling: null,
      gate: 'runningLiveContinues',
    });
    expect(remain.standingCeiling).toEqual(join.standingCeiling);
    expect({ ...remain, act: join.act, gate: join.gate }).toEqual(join);
    // No capability backs it, so no grant ever gives it.
    expect(backingCapability('community.live.remain')).toBeNull();
    expect(Object.isFrozen(remain)).toBe(true);
    expect(Object.isFrozen(remain.standingCeiling)).toBe(true);
  });

  it('reaches exactly the oversight acts of §6.11 — never adding, never chat or live', () => {
    const reached = Object.values(ACT_RULES)
      .filter((rule) => rule.oversightCeiling !== null)
      .map((rule) => rule.act)
      .sort();
    expect(reached).toEqual([
      'community.lock',
      'community.members.remove',
      'community.members.view',
      'community.view',
    ]);
    // The one operation override: listing and revoking links.
    expect(LINK_MANAGEMENT_RULE).toMatchObject({
      act: 'community.members.invite',
      oversightCeiling: ['communities.manage'],
      gate: 'always',
    });
  });

  it('backs community.live.host by community.live.start', () => {
    expect(backingCapability('community.live.host')).toBe('community.live.start');
    // A capability rests on itself; a participation act on none — no grant ever gives one.
    for (const capability of COMMUNITY_CAPABILITIES) {
      expect(backingCapability(capability)).toBe(capability);
    }
    for (const act of COMMUNITY_PARTICIPATION) expect(backingCapability(act)).toBeNull();
    expect(ACT_RULES['community.live.host'].standingCeiling).toEqual(
      ACT_RULES['community.live.start'].standingCeiling,
    );
  });
});

describe('the act vocabulary', () => {
  it('is closed and fixed', () => {
    expect(COMMUNITY_CAPABILITIES).toEqual([
      'community.members.view',
      'community.members.invite',
      'community.members.remove',
      'community.lock',
      'community.chat.post',
      'community.messages.moderate',
      'community.live.start',
      'community.live.moderate',
      'community.attendance.record',
      'community.attendance.view',
    ]);
    expect(COMMUNITY_PARTICIPATION).toEqual([
      'community.view',
      'community.chat.read',
      'community.live.join',
      'community.live.raise_hand',
    ]);
    expect(new Set(COMMUNITY_ACTS).size).toBe(COMMUNITY_ACTS.length);
  });

  it('never overlaps identity’s permissions — three guards', () => {
    // 1. No act is a catalogued permission, so identity's can() denies one.
    for (const act of COMMUNITY_ACTS) expect(isPermission(act)).toBe(false);
    // 2. No identity namespace is `community` (singular).
    const namespaces = new Set(ALL_PERMISSIONS.map((permission) => permission.split('.')[0]));
    expect(namespaces.has('community')).toBe(false);
    // 3. And no permission reads as an act.
    for (const permission of ALL_PERMISSIONS) expect(isCommunityAct(permission)).toBe(false);
  });

  it('keeps the operations apart from the acts and from identity’s permissions', () => {
    for (const operation of COMMUNITY_OPERATIONS) {
      expect(isCommunityAct(operation)).toBe(false);
      expect(isPermission(operation)).toBe(false);
    }
    for (const act of COMMUNITY_ACTS) expect(isCommunityOperation(act)).toBe(false);
    // The owner's own operations are reported under their own names.
    expect(isCommunityOperation(MANAGE_GRANTS.name)).toBe(true);
    expect(isCommunityOperation(TRANSFER_OWNERSHIP.name)).toBe(true);
  });

  it('has activated every once-reserved name — the vocabulary is closed with nothing reserved', () => {
    // Moved from reserved to active: message moderation on 2026-10-07 (Q51/Q23,
    // P12); the attendance acts on 2026-10-05 (the P9 prerequisite). All are now
    // delegable capabilities and acts.
    for (const act of [
      'community.messages.moderate',
      'community.attendance.record',
      'community.attendance.view',
    ]) {
      expect(isCommunityCapability(act)).toBe(true);
      expect(isCommunityAct(act)).toBe(true);
    }
    // A name the vocabulary does not list is still no act: the union stays closed.
    for (const unknown of [
      'community.messages.pin',
      'community.secrets.read',
      'community.messages',
    ]) {
      expect(isCommunityAct(unknown)).toBe(false);
      expect(isCommunityCapability(unknown)).toBe(false);
    }
  });
});
