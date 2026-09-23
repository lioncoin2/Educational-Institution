import type { CommunityCapability } from '../contracts/capabilities';
import type { CommunityStatus } from '../contracts/vocabulary';
import type { AuthorityRead, HeldGrant } from './authority';
import type { Community } from './community';
import type { CapabilityGrant } from './grant';
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
 * is refused (`basis_lost`) unless it is still the ACTIVE owner stint; a
 * delegate's act locks the delegate's stint and ACTIVE grants FOR SHARE and
 * is refused unless the stint is ACTIVE and the grant it rests on is still
 * ACTIVE on it; an oversight act rests on identity's ceiling alone and locks
 * no stint.
 */
export type ActingBasis =
  | { readonly kind: 'owner'; readonly userId: string; readonly membershipId: string }
  | {
      readonly kind: 'grant';
      readonly userId: string;
      readonly membershipId: string;
      readonly grantId: string;
      readonly capability: CommunityCapability;
    }
  | { readonly kind: 'oversight' };

/** The owner, as grant management and a transfer by the owner rest on them. */
export interface OwnerBasis {
  readonly userId: string;
  readonly membershipId: string;
}

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
  /** The stint ended, and with it every grant resting on it (`membership_ended`). */
  | {
      readonly kind: 'removed';
      readonly stint: Stint;
      readonly endedGrants: readonly CapabilityGrant[];
    }
  | { readonly kind: 'not_member' }
  | { readonly kind: 'owner' }
  /** The remover named themself: that is a leave. */
  | { readonly kind: 'self' }
  /** R6: a delegate cannot remove someone holding a capability they do not effectively hold. */
  | { readonly kind: 'holds_more' }
  | { readonly kind: 'not_found' }
  | BasisLost
  | Contended;

export type LeaveOutcome =
  | {
      readonly kind: 'left';
      readonly stint: Stint;
      readonly endedGrants: readonly CapabilityGrant[];
    }
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

export type GrantOutcome =
  | {
      readonly kind: 'granted';
      /** New grants, one per capability the grantee did not already hold. */
      readonly created: readonly CapabilityGrant[];
      /** Grants the grantee already held (R7): nothing was written for them. */
      readonly unchanged: readonly CapabilityGrant[];
    }
  /** R3/R5 under lock: the grantee is not an ACTIVE member, or is the owner. */
  | { readonly kind: 'grantee_ineligible' }
  /** The owner's stint is no longer the ACTIVE owner stint (or the community is gone). */
  | BasisLost
  | Contended;

export type RevokeGrantOutcome =
  | { readonly kind: 'revoked'; readonly grant: CapabilityGrant }
  /** The grant had already ended — revoked, or with its stint: nothing written. */
  | { readonly kind: 'unchanged'; readonly grant: CapabilityGrant }
  /** No such grant in this community. */
  | { readonly kind: 'not_found' }
  | BasisLost
  | Contended;

export type TransferOutcome =
  | {
      readonly kind: 'transferred';
      readonly from: Stint;
      readonly to: Stint;
      /** The new owner's own grants, ended `ownership_changed`: they hold everything now. */
      readonly endedGrants: readonly CapabilityGrant[];
    }
  /** The target already is the owner: nothing written. */
  | { readonly kind: 'unchanged' }
  /** The target is not an ACTIVE member. */
  | { readonly kind: 'target_not_member' }
  /**
   * Ownership, or the target's membership, changed while this transfer
   * waited for its locks: another transfer or a removal won. Nothing written.
   */
  | { readonly kind: 'owner_conflict' }
  | { readonly kind: 'not_found' }
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
  /** The link's creator no longer stands as owner or holds `community.members.invite` (Q48). */
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

  /**
   * Ends someone else's ACTIVE stint as REMOVED, and every grant on it. The
   * owner is never removed, and `removedBy` never removes themself; a
   * delegate is bounded by R6, decided under lock against the delegate's
   * ACTIVE grants and `removerCeilings` — the capabilities whose identity
   * ceiling the remover holds right now.
   */
  removeMember(input: {
    readonly communityId: string;
    readonly userId: string;
    readonly actor: ActingBasis;
    readonly removerCeilings: ReadonlySet<CommunityCapability>;
    readonly removedBy: string | null;
    readonly at: Date;
  }): Promise<RemoveOutcome>;

  /** Ends one's own ACTIVE stint as LEFT, and every grant on it. The owner cannot leave. */
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
   * stint, the link's use, the creator's standing (the owner, or a holder of
   * an ACTIVE `community.members.invite` grant), the lifecycle gate, the
   * counter and version, and the new stint — or nothing at all.
   */
  redeem(input: {
    readonly invitationId: string;
    readonly communityId: string;
    readonly userId: string;
    readonly creatorUserId: string;
    /** The capability a creator who is not the owner must still hold a grant of. */
    readonly creatorCapability: CommunityCapability;
    readonly stintId: string;
    readonly at: Date;
  }): Promise<RedeemOutcome>;

  /**
   * Grants capabilities to one member (S4), atomically: the owner's and the
   * grantee's stints re-read under lock, then one grant per capability not
   * already held. The community row is never touched.
   */
  grant(input: {
    readonly communityId: string;
    readonly owner: OwnerBasis;
    readonly granteeUserId: string;
    readonly capabilities: readonly CommunityCapability[];
    readonly at: Date;
    readonly newId: () => string;
  }): Promise<GrantOutcome>;

  /** One-way: an ended grant stays ended, and a repeat is `unchanged`. */
  revokeGrant(input: {
    readonly communityId: string;
    readonly grantId: string;
    readonly owner: OwnerBasis;
    readonly at: Date;
  }): Promise<RevokeGrantOutcome>;

  /**
   * Hands ownership to an ACTIVE member (§6.9), in one transaction: the
   * owner's and the target's stints FOR UPDATE, demote, promote, and the new
   * owner's grants ended. The actor is the owner or oversight.
   */
  transfer(input: {
    readonly communityId: string;
    readonly toUserId: string;
    readonly actor: ActingBasis;
    readonly transferredBy: string | null;
    readonly at: Date;
  }): Promise<TransferOutcome>;
}

/** A position in a list ordered by (instant, id). */
export interface Keyset {
  readonly at: Date;
  readonly id: string;
}

/** A position in a community's grant list, ordered by (capability, user). */
export interface GrantKey {
  readonly capability: CommunityCapability;
  readonly userId: string;
}

export interface MyCommunity {
  readonly community: Community;
  readonly stint: Stint;
  /** The stint's ACTIVE grants — for the `me` block, from the same statement. */
  readonly grants: readonly HeldGrant[];
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
  /**
   * A community's ACTIVE grants by (capability, user), optionally for one
   * user or one capability — on the ACTIVE-only grant indexes.
   */
  grants(
    communityId: string,
    page: {
      readonly userId?: string;
      readonly capability?: CommunityCapability;
      readonly after?: GrantKey;
      readonly limit: number;
    },
  ): Promise<readonly CapabilityGrant[]>;
  /**
   * Who may hold `capability` by standing, before any ceiling is checked:
   * every ACTIVE grantee of it — and the owner, when `includeOwner` (the act
   * rules say whether the owner holds it implicitly) — in user-id order after
   * `afterUserId`. Never an overseer.
   */
  holderCandidates(
    communityId: string,
    capability: CommunityCapability,
    page: {
      readonly includeOwner: boolean;
      readonly afterUserId?: string;
      readonly limit: number;
    },
  ): Promise<readonly string[]>;
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
