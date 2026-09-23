/** DI token. */
export const COMMUNITY_MEMBERSHIP = Symbol('COMMUNITY_MEMBERSHIP');

/** The most ids, or members, any one call returns or accepts. */
export const MAX_MEMBER_PAGE = 1000;

/**
 * What a community's lifecycle allows right now — the only view of its state
 * another module ever gets (§8.3). A consumer never sees the raw status, so
 * a status added later (ARCHIVED, Q47) changes no consumer. PROVISIONAL:
 * which effects LOCKED switches off is Q46.
 */
export interface LifecycleEffects {
  /** New members may join, by any path. */
  readonly acceptsMembers: boolean;
  readonly chatReadable: boolean;
  readonly chatPostingOpen: boolean;
  readonly liveStartOpen: boolean;
  readonly liveJoinOpen: boolean;
  /** A running live session may continue. True even for a status this build does not know. */
  readonly runningLiveContinues: boolean;
}

export interface CommunityHead {
  readonly communityId: string;
  /** The last version allocated to a membership change. */
  readonly membershipVersion: number;
  /** Increases on every real lock or unlock; lets a consumer drop a stale frame. */
  readonly lifecycleVersion: number;
  readonly effects: LifecycleEffects;
}

/** One account's latest stint in a community. */
export interface MemberState {
  readonly communityId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly active: boolean;
  /** This stint's start; a rejoin is a new stint with its own. */
  readonly joinedAt: Date;
  /** > 0, unique per community, in commit order. */
  readonly version: number;
}

export interface MembershipChanges {
  /** Ascending version; the latest state per user within the page. */
  readonly states: readonly MemberState[];
  /** The community as of the same snapshot. */
  readonly head: CommunityHead;
  /** Resume after this version; everything up to it has been returned. */
  readonly throughVersion: number;
  readonly hasMore: boolean;
}

/**
 * Membership FACTS, for trusted in-process consumers with no principal —
 * Messaging's projection, Realtime's audience (the MESSAGE_RECIPIENTS
 * stance). It answers who belongs, never who may act: a consumer acting for
 * a person asks COMMUNITY_AUTHORIZATION.
 *
 * Nothing here loads a whole community or reports its size: every call is a
 * point lookup, a keyset page or an ordered feed, whatever the membership.
 */
export interface CommunityMembership {
  /** At most MAX_MEMBER_PAGE ids; unknown ids are absent. */
  heads(communityIds: readonly string[]): Promise<readonly CommunityHead[]>;

  /** Every community, keyset-paged by id. */
  listHeads(page: {
    readonly afterCommunityId?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly CommunityHead[]; readonly next: string | null }>;

  /** The latest stint of each of up to MAX_MEMBER_PAGE users; never-members are absent. */
  statesOf(communityId: string, userIds: readonly string[]): Promise<readonly MemberState[]>;

  /**
   * Every membership change after `afterVersion`, oldest first, in ONE
   * statement: a reader that has applied everything up to v sees every later
   * change by asking again from v. Null for an unknown community.
   */
  changesSince(
    communityId: string,
    afterVersion: number,
    limit: number,
  ): Promise<MembershipChanges | null>;

  /**
   * Current ACTIVE members in user-id order, a page at a time. RangeError on
   * a cursor this contract did not issue, a limit outside 1..MAX_MEMBER_PAGE,
   * or more than MAX_MEMBER_PAGE `onlyUserIds`.
   */
  members(
    communityId: string,
    page: {
      readonly onlyUserIds?: readonly string[];
      readonly excludeUserId?: string;
      readonly cursor?: string | null;
      readonly limit: number;
    },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
}
