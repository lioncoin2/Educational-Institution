import type { CommunityStatus } from '../contracts/vocabulary';
import type { AuthorityRead } from './authority';
import type { Community } from './community';
import type { Invitation } from './invitation';
import type { Stint } from './membership';

export const COMMUNITY_STORE = Symbol('COMMUNITY_STORE');
export const COMMUNITY_READ_MODEL = Symbol('COMMUNITY_READ_MODEL');

/**
 * The evaluator's read, carrying the whole community row — so a response can
 * be built from the same snapshot the decision was made on, with no second
 * read.
 */
export interface CommunityAuthorityRead extends AuthorityRead {
  readonly community: Community | null;
}

/**
 * The standing an act rests on, handed to the store so it can re-verify it
 * UNDER LOCK (ADR 0017): an owner's act locks the owner's stint FOR SHARE and
 * is refused (`basis_lost`) unless it is still the ACTIVE owner stint; an
 * oversight act rests on identity's ceiling alone and locks no stint.
 */
export type ActingBasis =
  | { readonly kind: 'owner'; readonly userId: string; readonly membershipId: string }
  | { readonly kind: 'oversight' };

/** A deadlock victim, after one retry. The in-memory store never answers it. */
export interface Contended {
  readonly kind: 'conflict';
}

/** The acting basis no longer holds at the moment of the write. */
export interface BasisLost {
  readonly kind: 'basis_lost';
}

export type StatusChange =
  | { readonly kind: 'changed'; readonly community: Community }
  | { readonly kind: 'unchanged'; readonly community: Community }
  | { readonly kind: 'not_found' }
  | BasisLost
  | Contended;

export type AddMembersOutcome =
  | {
      readonly kind: 'added';
      /** New stints, in the order their versions were allocated. */
      readonly added: readonly Stint[];
      /** Already ACTIVE members: nothing was written for them. */
      readonly unchanged: readonly string[];
    }
  | { readonly kind: 'locked' }
  | { readonly kind: 'not_found' }
  | BasisLost
  | Contended;

export type RemoveOutcome =
  | { readonly kind: 'removed'; readonly stint: Stint }
  | { readonly kind: 'not_member' }
  | { readonly kind: 'owner' }
  | { readonly kind: 'not_found' }
  | BasisLost
  | Contended;

export type LeaveOutcome =
  | { readonly kind: 'left'; readonly stint: Stint }
  | { readonly kind: 'not_member' }
  | { readonly kind: 'owner' }
  | { readonly kind: 'not_found' }
  | Contended;

export type CreateInvitationOutcome =
  | { readonly kind: 'created' }
  /** Another link already has this token's hash (about 2⁻²⁵⁶): issue once more. */
  | { readonly kind: 'token_collision' }
  | { readonly kind: 'not_found' }
  | BasisLost
  | Contended;

export type RevokeInvitationOutcome =
  | { readonly kind: 'revoked'; readonly invitation: Invitation }
  | { readonly kind: 'unchanged'; readonly invitation: Invitation }
  | { readonly kind: 'not_found' }
  | BasisLost
  | Contended;

/**
 * Every way a redemption ends (§7.3). Every refusal consumed nothing: the
 * use, the counter and the version all roll back together.
 */
export type RedeemOutcome =
  | { readonly kind: 'joined'; readonly stint: Stint }
  /** An ACTIVE member redeeming again: no use consumed, nothing recorded. */
  | { readonly kind: 'already_member' }
  /** The latest stint is REMOVED: only a manager may bring them back (Q49). */
  | { readonly kind: 'removed' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'locked' }
  /** The link's creator no longer holds the standing to admit anyone (Q48). */
  | { readonly kind: 'creator_lost' }
  | { readonly kind: 'not_found' }
  | Contended;

/**
 * Communities' writes, and the one read authorization needs. Every
 * invariant that concurrency could break is decided here, atomically — by a
 * conditional UPDATE, a partial unique index or a lock in Postgres (always
 * in the global lock order, §4), by the single thread in memory — never by a
 * check in the use case followed by a separate write.
 */
export interface CommunityStore {
  /** Evaluator step 2: the community and the user's ACTIVE stint, in one read. */
  authorityOf(communityId: string, userId: string): Promise<CommunityAuthorityRead>;
  /** The same for many communities at once, in one read. Unknown ids have no entry. */
  authorityOfEach(
    communityIds: readonly string[],
    userId: string,
  ): Promise<ReadonlyMap<string, CommunityAuthorityRead>>;

  findCommunity(communityId: string): Promise<Community | null>;

  /** The community and its owner's stint, together. */
  create(community: Community, owner: Stint): Promise<void>;

  /** Lock or unlock: an absolute target, so a repeat is `unchanged` and writes nothing. */
  changeStatus(input: {
    readonly communityId: string;
    readonly to: CommunityStatus;
    readonly actor: ActingBasis;
    readonly actorUserId: string | null;
    readonly at: Date;
  }): Promise<StatusChange>;

  /**
   * Adds whoever is not already an ACTIVE member — provided the community
   * accepts members AS OF THE WRITE. `newId` names each new stint.
   */
  addMembers(input: {
    readonly communityId: string;
    readonly userIds: readonly string[];
    readonly actor: ActingBasis;
    readonly addedBy: string | null;
    readonly at: Date;
    readonly newId: () => string;
  }): Promise<AddMembersOutcome>;

  /** Ends someone else's ACTIVE stint as REMOVED. The owner is never removed. */
  removeMember(input: {
    readonly communityId: string;
    readonly userId: string;
    readonly actor: ActingBasis;
    readonly removedBy: string | null;
    readonly at: Date;
  }): Promise<RemoveOutcome>;

  /** Ends one's own ACTIVE stint as LEFT. The owner cannot leave. */
  leave(input: {
    readonly communityId: string;
    readonly userId: string;
    readonly at: Date;
  }): Promise<LeaveOutcome>;

  createInvitation(input: {
    readonly invitation: Invitation;
    readonly actor: ActingBasis;
  }): Promise<CreateInvitationOutcome>;

  /** One-way: a revoked link stays revoked, and a repeat is `unchanged`. */
  revokeInvitation(input: {
    readonly communityId: string;
    readonly invitationId: string;
    readonly actor: ActingBasis;
    readonly revokedBy: string | null;
    readonly at: Date;
  }): Promise<RevokeInvitationOutcome>;

  /** The redemption lookup, by the token's hash only. */
  findInvitationByTokenHash(tokenHash: string): Promise<{
    readonly invitationId: string;
    readonly communityId: string;
    readonly createdBy: string;
  } | null>;

  /**
   * The whole redemption, in one transaction (§7.3): the redeemer's latest
   * stint, the link's use, the creator's standing, the lifecycle gate, the
   * counter and version, and the new stint — or nothing at all.
   */
  redeem(input: {
    readonly invitationId: string;
    readonly communityId: string;
    readonly userId: string;
    readonly creatorUserId: string;
    readonly stintId: string;
    readonly at: Date;
  }): Promise<RedeemOutcome>;
}

/** A position in a list ordered by (instant, id). */
export interface Keyset {
  readonly at: Date;
  readonly id: string;
}

export interface MyCommunity {
  readonly community: Community;
  readonly stint: Stint;
}

/**
 * Communities' lists and contract reads. Each is one statement (or one per
 * page), keyset-paged on an index that holds only what it lists — no
 * OFFSET, no count, and no path that loads a whole community.
 */
export interface CommunityReadModel {
  /** The user's ACTIVE memberships, newest join first. */
  myCommunities(
    userId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly MyCommunity[]>;
  /** Every community, newest first — oversight only. */
  allCommunities(page: {
    readonly before?: Keyset;
    readonly limit: number;
  }): Promise<readonly Community[]>;
  /** ACTIVE stints by (joinedAt, userId), oldest first. */
  roster(
    communityId: string,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly Stint[]>;
  /** A community's links, newest first. */
  invitations(
    communityId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly Invitation[]>;
  findInvitation(communityId: string, invitationId: string): Promise<Invitation | null>;

  /** Several communities, by id; unknown ids are absent. */
  communities(ids: readonly string[]): Promise<readonly Community[]>;
  /** Communities by id, after a given id. */
  communitiesAfter(afterId: string | undefined, limit: number): Promise<readonly Community[]>;
  /** The latest stint (highest version) of each user; never-members absent. */
  latestStints(communityId: string, userIds: readonly string[]): Promise<readonly Stint[]>;
  /**
   * The community and every stint whose version is above `afterVersion`, at
   * most `limit` of them, oldest first — one snapshot.
   */
  changesSince(
    communityId: string,
    afterVersion: number,
    limit: number,
  ): Promise<{ readonly community: Community; readonly stints: readonly Stint[] } | null>;
  /** ACTIVE member ids in id order, after `afterUserId`. */
  memberIds(
    communityId: string,
    page: {
      readonly afterUserId?: string;
      readonly onlyUserIds?: readonly string[];
      readonly excludeUserId?: string;
      readonly limit: number;
    },
  ): Promise<readonly string[]>;
}
