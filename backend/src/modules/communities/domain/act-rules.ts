import { Permissions, type Permission } from '../../identity/contracts/permissions';
import {
  COMMUNITY_CHAT_READ_CEILING,
  isCommunityCapability,
  isCommunityParticipationAct,
  type CommunityAct,
  type CommunityCapability,
} from '../contracts/capabilities';
import { GATE_OF_ACT, type LifecycleGate } from './lifecycle';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PROVISIONAL ACT RULES — NOT CONFIRMED BY THE INSTITUTION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Who may do what in a community (§6.4). Each rule names:
 *
 *   standing ceiling   identity permissions ALL required on the membership
 *                      or owner path — role-wide, never sufficient alone
 *   owner              whether the owner holds the act implicitly (within
 *                      the ceiling); participation acts come from membership
 *   oversight ceiling  identity permissions that reach the act WITHOUT
 *                      membership (`communities.manage`), or none
 *   gate               the lifecycle effect the act needs (lifecycle.ts)
 *
 * Decided by Q43 (oversight reach), Q44 (ceilings), Q46 (the gate), Q51 (who
 * posts) and Q54 (who starts and moderates live sessions). Answering any of
 * them edits this table and its pinning test; no consumer changes.
 *
 * Kept inside Communities: no other module holds a copy of these rules —
 * they ask COMMUNITY_AUTHORIZATION.
 */
export interface ActRule {
  readonly act: CommunityAct;
  readonly kind: 'participation' | 'capability' | 'derived';
  readonly standingCeiling: readonly Permission[];
  readonly ownerImplicit: boolean;
  readonly oversightCeiling: readonly Permission[] | null;
  readonly gate: LifecycleGate;
}

const { communities, messaging, live } = Permissions;

function rule(
  act: CommunityAct,
  standingCeiling: readonly Permission[],
  oversightCeiling: readonly Permission[] | null,
): ActRule {
  const participation = isCommunityParticipationAct(act);
  return Object.freeze({
    act,
    kind: participation
      ? 'participation'
      : act === 'community.live.host'
        ? 'derived'
        : 'capability',
    standingCeiling: Object.freeze([...standingCeiling]),
    // The owner is a member, so participation needs no owner path.
    ownerImplicit: !participation,
    oversightCeiling: oversightCeiling === null ? null : Object.freeze([...oversightCeiling]),
    gate: GATE_OF_ACT[act],
  });
}

export const ACT_RULES: Readonly<Record<CommunityAct, ActRule>> = Object.freeze({
  'community.view': rule('community.view', [communities.read], [communities.manage]),
  'community.members.view': rule(
    'community.members.view',
    [communities.moderate],
    [communities.manage],
  ),
  // Oversight never adds a member, by any path (§6.11).
  'community.members.invite': rule('community.members.invite', [communities.moderate], null),
  'community.members.remove': rule(
    'community.members.remove',
    [communities.moderate],
    [communities.manage],
  ),
  'community.lock': rule('community.lock', [communities.moderate], [communities.manage]),
  // The published constant, so messaging's principal-less recipient pages
  // narrow by exactly the ceiling this rule asks of a person (§7.3).
  'community.chat.read': rule('community.chat.read', COMMUNITY_CHAT_READ_CEILING, null),
  'community.chat.post': rule('community.chat.post', [communities.moderate, messaging.send], null),
  'community.live.start': rule('community.live.start', [communities.moderate, live.moderate], null),
  // Backed by live.start: the same ceiling and the same holders.
  'community.live.host': rule('community.live.host', [communities.moderate, live.moderate], null),
  'community.live.moderate': rule(
    'community.live.moderate',
    [communities.moderate, live.moderate],
    null,
  ),
  'community.live.join': rule('community.live.join', [communities.read, live.join], null),
  'community.live.raise_hand': rule(
    'community.live.raise_hand',
    [communities.read, live.raiseHand],
    null,
  ),
});

/**
 * The one operation-level override (§6.6): listing and revoking a
 * community's links are `community.members.invite` — but reachable by
 * oversight too, so an overseer can kill a leaked link, and managed like
 * management, so revoking a link stays possible while the community is
 * LOCKED. Creating a link is not: it takes the plain rule. No new act name.
 */
export const LINK_MANAGEMENT_RULE: ActRule = Object.freeze({
  ...ACT_RULES['community.members.invite'],
  oversightCeiling: Object.freeze([communities.manage]),
  gate: 'always',
});

export function ruleFor(act: CommunityAct): ActRule {
  return ACT_RULES[act];
}

/**
 * The capability a grant must name for an act (§6.3): a capability is its
 * own; `community.live.host` is backed by `community.live.start`; a
 * participation act rests on no capability — membership alone gives it,
 * and no grant ever does.
 */
export function backingCapability(act: CommunityAct): CommunityCapability | null {
  if (act === 'community.live.host') return 'community.live.start';
  return isCommunityCapability(act) ? act : null;
}

/**
 * The owner's own operations (P3, §6.6): managing grants, and handing
 * ownership over. They are not acts — no grant can give them, so there is no
 * sub-delegation (R1) — and no lifecycle status closes them: they are
 * management, as removing a member or unlocking is (PROVISIONAL, Q46).
 *
 *   ownerCeiling      what the owner must hold: `communities.moderate`, the
 *                     single ceiling of ownership and of every delegable
 *                     capability (ADR 0017; PROVISIONAL, Q42, Q44)
 *   oversightCeiling  reach without ownership: only a transfer, by a
 *                     `communities.manage` holder naming someone other than
 *                     themself — the recovery path (PROVISIONAL, Q42, Q43)
 */
export interface OwnerOperation {
  readonly name: 'community.grants.manage' | 'community.ownership.transfer';
  readonly ownerCeiling: readonly Permission[];
  readonly oversightCeiling: readonly Permission[] | null;
}

export const MANAGE_GRANTS: OwnerOperation = Object.freeze({
  name: 'community.grants.manage',
  ownerCeiling: Object.freeze([communities.moderate]),
  oversightCeiling: null,
});

export const TRANSFER_OWNERSHIP: OwnerOperation = Object.freeze({
  name: 'community.ownership.transfer',
  ownerCeiling: Object.freeze([communities.moderate]),
  oversightCeiling: Object.freeze([communities.manage]),
});
