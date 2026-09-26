import { ALL_PERMISSIONS, isPermission } from '../../identity/contracts/permissions';
import {
  COMMUNITY_ACTS,
  COMMUNITY_CAPABILITIES,
  COMMUNITY_CHAT_READ_CEILING,
  COMMUNITY_OPERATIONS,
  COMMUNITY_PARTICIPATION,
  COMMUNITY_VIEW_CEILING,
  isCommunityAct,
  isCommunityCapability,
  isCommunityOperation,
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
      'community.live.raise_hand': {
        standing: 'communities.read + live.raise_hand',
        oversight: null,
        owner: false,
        gate: 'liveJoinOpen',
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

  it('requires communities.moderate for every capability and derived act', () => {
    for (const act of [...COMMUNITY_CAPABILITIES, 'community.live.host'] as const) {
      expect(ACT_RULES[act].standingCeiling).toContain('communities.moderate');
      expect(ACT_RULES[act].ownerImplicit).toBe(true);
    }
  });

  it('gives participation acts by membership only — never by owner or grant', () => {
    for (const act of COMMUNITY_PARTICIPATION) {
      expect(ACT_RULES[act]).toMatchObject({ kind: 'participation', ownerImplicit: false });
      expect(ACT_RULES[act].standingCeiling).toContain('communities.read');
    }
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
      'community.live.start',
      'community.live.moderate',
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

  it('keeps the reserved names out until the migration that allows them', () => {
    for (const reserved of [
      'community.attendance.record',
      'community.attendance.view',
      'community.messages.moderate',
    ]) {
      expect(isCommunityAct(reserved)).toBe(false);
      expect(isCommunityCapability(reserved)).toBe(false);
    }
  });
});
