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

/**
 * The chat posting mode (ADR 0039) — product identity AND, for a group, its
 * posting policy, in one value:
 *
 *   GROUP_OPEN        a group where every active member may post (the default
 *                     for a new group).
 *   GROUP_RESTRICTED  a group an admin has made read-only for ordinary members;
 *                     it is still a group (owner + delegated posters write).
 *   CHANNEL           only the owner and delegated publishers write; members
 *                     read and follow.
 *
 * It never decides posting by itself — `COMMUNITY_AUTHORIZATION` does, re-asked
 * on every send (a locked community still blocks everyone, whatever the mode).
 * Consumers treat an unknown value as `unknown`; a later migration may add one.
 */
export const COMMUNITY_CHAT_MODES = ['GROUP_OPEN', 'GROUP_RESTRICTED', 'CHANNEL'] as const;
export type CommunityChatMode = (typeof COMMUNITY_CHAT_MODES)[number];

/** The two product kinds a chat mode expresses, for display. */
export const COMMUNITY_KINDS = ['GROUP', 'CHANNEL'] as const;
export type CommunityKind = (typeof COMMUNITY_KINDS)[number];

/** A new group opens posting to members; a new channel restricts it to publishers. */
export function chatModeForKind(kind: CommunityKind): CommunityChatMode {
  return kind === 'CHANNEL' ? 'CHANNEL' : 'GROUP_OPEN';
}

/** The product kind a mode belongs to (a restricted group is still a GROUP). */
export function kindOfChatMode(mode: CommunityChatMode): CommunityKind {
  return mode === 'CHANNEL' ? 'CHANNEL' : 'GROUP';
}

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
export const isCommunityChatMode = guard(COMMUNITY_CHAT_MODES);
export const isCommunityKind = guard(COMMUNITY_KINDS);
export const isMembershipStatus = guard(MEMBERSHIP_STATUSES);
export const isMembershipStanding = guard(MEMBERSHIP_STANDINGS);
export const isMembershipSource = guard(MEMBERSHIP_SOURCES);
export const isInvitationState = guard(INVITATION_STATES);
