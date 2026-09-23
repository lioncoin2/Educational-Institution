/**
 * Communities' wire vocabulary. Clients must treat an unknown value as
 * `unknown`, never as an error: a later migration may add one (ARCHIVED, a
 * SYNC source) and an older app must keep working.
 */

/**
 * OPEN or LOCKED (§8). Consumers never branch on a status — they read
 * `CommunityHead.effects` or ask `COMMUNITY_AUTHORIZATION` — so a status
 * added later changes no consumer. ARCHIVED is deferred (Q47).
 */
export const COMMUNITY_STATUSES = ['OPEN', 'LOCKED'] as const;
export type CommunityStatus = (typeof COMMUNITY_STATUSES)[number];

/** One stay of one account in one community. Terminal once ended; a rejoin is a new stint. */
export const MEMBERSHIP_STATUSES = ['ACTIVE', 'LEFT', 'REMOVED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** Belonging, and the one ownership mark — not a role, not a capability. Exactly one OWNER. */
export const MEMBERSHIP_STANDINGS = ['OWNER', 'MEMBER'] as const;
export type MembershipStanding = (typeof MEMBERSHIP_STANDINGS)[number];

/**
 * How a stint began: a manager added the person, or they redeemed a link.
 * Never exposed through the API (Q22). `SYNC` is reserved for Q50.
 */
export const MEMBERSHIP_SOURCES = ['ADDED', 'INVITATION'] as const;
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];

/** Derived at request time from the row and the clock — never stored (§3.3). */
export const INVITATION_STATES = ['ACTIVE', 'EXPIRED', 'EXHAUSTED', 'REVOKED'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

const guard =
  <T extends string>(values: readonly T[]) =>
  (value: string): value is T =>
    (values as readonly string[]).includes(value);

export const isCommunityStatus = guard(COMMUNITY_STATUSES);
export const isMembershipStatus = guard(MEMBERSHIP_STATUSES);
export const isMembershipStanding = guard(MEMBERSHIP_STANDINGS);
export const isMembershipSource = guard(MEMBERSHIP_SOURCES);
export const isInvitationState = guard(INVITATION_STATES);
