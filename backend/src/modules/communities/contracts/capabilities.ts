/**
 * What one may do in one community — the act vocabulary, owned by Communities
 * and closed (docs/architecture/communities.md §6.3).
 *
 * An act is never an identity permission. Identity's permissions are
 * role-wide ceilings (`communities.moderate`, `live.moderate`, …); an act is
 * something done in ONE community, allowed only when the ceiling is held AND
 * Communities' own records give a basis (membership, ownership, oversight)
 * AND the community's lifecycle permits it. The two vocabularies are kept
 * apart three ways, each tested: no act is a catalogued permission, no
 * identity namespace is `community` (singular), and the TypeScript unions
 * share no member — passing an act to identity's `AuthorizationService` does
 * not compile.
 */
export const COMMUNITY_RESOURCE = 'communities.community';

/**
 * Capabilities: the acts an owner holds implicitly (within their ceilings)
 * and may delegate to a member, one grant per capability.
 *
 * Reserved, and added only with the migration that allows them:
 * `community.attendance.record` and `community.attendance.view` (P9, held),
 * `community.messages.moderate` (Q51/Q23).
 */
export const COMMUNITY_CAPABILITIES = [
  'community.members.view',
  'community.members.invite',
  'community.members.remove',
  'community.lock',
  'community.chat.post',
  'community.live.start',
  'community.live.moderate',
] as const;

export type CommunityCapability = (typeof COMMUNITY_CAPABILITIES)[number];

/** Participation: satisfied by ACTIVE membership alone, never by a grant. */
export const COMMUNITY_PARTICIPATION = [
  'community.view',
  'community.chat.read',
  'community.live.join',
  'community.live.raise_hand',
] as const;

export type CommunityParticipationAct = (typeof COMMUNITY_PARTICIPATION)[number];

/**
 * Derived acts, backed by a capability rather than granted themselves.
 *
 * `community.live.host`: the host of a live session moderating their own
 * session — backed by `community.live.start`, and allowed while a running
 * session continues. (`community.live.remain`, staying in a running session,
 * joins this list with community-scoped live sessions in P6.)
 */
export const COMMUNITY_DERIVED_ACTS = ['community.live.host'] as const;

export type CommunityDerivedAct = (typeof COMMUNITY_DERIVED_ACTS)[number];

export type CommunityAct = CommunityCapability | CommunityParticipationAct | CommunityDerivedAct;

export const COMMUNITY_ACTS: readonly CommunityAct[] = Object.freeze([
  ...COMMUNITY_PARTICIPATION,
  ...COMMUNITY_CAPABILITIES,
  ...COMMUNITY_DERIVED_ACTS,
]);

const CAPABILITIES = new Set<string>(COMMUNITY_CAPABILITIES);
const PARTICIPATION = new Set<string>(COMMUNITY_PARTICIPATION);
const ACTS = new Set<string>(COMMUNITY_ACTS);

export function isCommunityCapability(value: string): value is CommunityCapability {
  return CAPABILITIES.has(value);
}

export function isCommunityParticipationAct(value: string): value is CommunityParticipationAct {
  return PARTICIPATION.has(value);
}

export function isCommunityAct(value: string): value is CommunityAct {
  return ACTS.has(value);
}
