import { Injectable } from '@nestjs/common';

import type { CommunityStatus } from '../contracts/vocabulary';
import type { Community } from '../domain/community';
import { invitationState, type Invitation } from '../domain/invitation';
import { effectsOf } from '../domain/lifecycle';
import { endStint, latestStint, memberStint, type Stint } from '../domain/membership';
import type {
  ActingBasis,
  AddMembersOutcome,
  CommunityAuthorityRead,
  CommunityReadModel,
  CommunityStore,
  CreateInvitationOutcome,
  Keyset,
  LeaveOutcome,
  MyCommunity,
  RedeemOutcome,
  RemoveOutcome,
  RevokeInvitationOutcome,
  StatusChange,
} from '../domain/ports';

const pair = (communityId: string, userId: string) => `${communityId}\u0000${userId}`;

const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/** (at, id) ascending. */
function byKey(a: Keyset, b: Keyset): number {
  const t = a.at.getTime() - b.at.getTime();
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Communities in memory — development without a database, and the store the
 * application tests run on. Both ports, one set of maps, so what is written
 * is what is read.
 *
 * Every method is one critical section: nothing is awaited between reading
 * and writing, so on Node's single thread each is atomic, exactly as the
 * Postgres adapter's transaction is — the same outcomes for the same
 * sequence of calls, races included (mock parity, §16). Entities are
 * immutable and replaced, never mutated in place.
 */
@Injectable()
export class InMemoryCommunityStore implements CommunityStore, CommunityReadModel {
  private readonly communityById = new Map<string, Community>();
  private readonly stintById = new Map<string, Stint>();
  private readonly stintsByCommunity = new Map<string, Set<string>>();
  private readonly activeByPair = new Map<string, string>();
  private readonly stintsByPair = new Map<string, string[]>();
  private readonly invitationById = new Map<string, Invitation>();
  private readonly invitationByHash = new Map<string, string>();

  // ── CommunityStore ─────────────────────────────────────────────────────

  async authorityOf(communityId: string, userId: string): Promise<CommunityAuthorityRead> {
    return this.readAuthority(communityId, userId);
  }

  async authorityOfEach(
    communityIds: readonly string[],
    userId: string,
  ): Promise<ReadonlyMap<string, CommunityAuthorityRead>> {
    const reads = new Map<string, CommunityAuthorityRead>();
    for (const communityId of communityIds) {
      if (this.communityById.has(communityId)) {
        reads.set(communityId, this.readAuthority(communityId, userId));
      }
    }
    return reads;
  }

  async findCommunity(communityId: string): Promise<Community | null> {
    return this.communityById.get(communityId) ?? null;
  }

  async create(community: Community, owner: Stint): Promise<void> {
    if (this.communityById.has(community.id)) throw new Error('duplicate community id');
    this.communityById.set(community.id, community);
    this.putStint(owner);
  }

  async changeStatus(input: {
    readonly communityId: string;
    readonly to: CommunityStatus;
    readonly actor: ActingBasis;
    readonly actorUserId: string | null;
    readonly at: Date;
  }): Promise<StatusChange> {
    // The same order as the transaction: the basis first, then the row.
    if (!this.basisHolds(input.communityId, input.actor)) return { kind: 'basis_lost' };
    const community = this.communityById.get(input.communityId);
    if (community === undefined) return { kind: 'not_found' };
    const from: CommunityStatus = input.to === 'LOCKED' ? 'OPEN' : 'LOCKED';
    if (community.status !== from) return { kind: 'unchanged', community };
    const changed: Community = {
      ...community,
      status: input.to,
      lifecycleVersion: community.lifecycleVersion + 1,
      statusChangedAt: input.at,
      statusChangedBy: input.actorUserId,
      updatedAt: later(community.updatedAt, input.at),
    };
    this.communityById.set(changed.id, changed);
    return { kind: 'changed', community: changed };
  }

  async addMembers(input: {
    readonly communityId: string;
    readonly userIds: readonly string[];
    readonly actor: ActingBasis;
    readonly addedBy: string | null;
    readonly at: Date;
    readonly newId: () => string;
  }): Promise<AddMembersOutcome> {
    if (!this.basisHolds(input.communityId, input.actor)) return { kind: 'basis_lost' };
    const community = this.communityById.get(input.communityId);
    if (community === undefined) return { kind: 'not_found' };
    const userIds = [...new Set(input.userIds)];
    const newcomers = userIds.filter(
      (userId) => !this.activeByPair.has(pair(community.id, userId)),
    );
    const unchanged = userIds.filter((userId) => this.activeByPair.has(pair(community.id, userId)));
    if (newcomers.length === 0) return { kind: 'added', added: [], unchanged };
    if (!effectsOf(community.status).acceptsMembers) return { kind: 'locked' };

    const added = newcomers.map((userId, index) =>
      memberStint({
        id: input.newId(),
        communityId: community.id,
        userId,
        source: 'ADDED',
        addedBy: input.addedBy,
        invitationId: null,
        at: input.at,
        version: community.membershipVersion + index + 1,
      }),
    );
    for (const stint of added) this.putStint(stint);
    this.communityById.set(community.id, {
      ...community,
      memberCount: community.memberCount + added.length,
      membershipVersion: community.membershipVersion + added.length,
      updatedAt: later(community.updatedAt, input.at),
    });
    return { kind: 'added', added, unchanged };
  }

  async removeMember(input: {
    readonly communityId: string;
    readonly userId: string;
    readonly actor: ActingBasis;
    readonly removedBy: string | null;
    readonly at: Date;
  }): Promise<RemoveOutcome> {
    if (!this.basisHolds(input.communityId, input.actor)) return { kind: 'basis_lost' };
    const community = this.communityById.get(input.communityId);
    if (community === undefined) return { kind: 'not_found' };
    const stint = this.activeStint(input.communityId, input.userId);
    if (stint === null) return { kind: 'not_member' };
    if (stint.standing === 'OWNER') return { kind: 'owner' };
    const ended = this.end(community, stint, 'REMOVED', input.removedBy, input.at);
    return { kind: 'removed', stint: ended };
  }

  async leave(input: {
    readonly communityId: string;
    readonly userId: string;
    readonly at: Date;
  }): Promise<LeaveOutcome> {
    const community = this.communityById.get(input.communityId);
    if (community === undefined) return { kind: 'not_found' };
    const stint = this.activeStint(input.communityId, input.userId);
    if (stint === null) return { kind: 'not_member' };
    if (stint.standing === 'OWNER') return { kind: 'owner' };
    const ended = this.end(community, stint, 'LEFT', input.userId, input.at);
    return { kind: 'left', stint: ended };
  }

  async createInvitation(input: {
    readonly invitation: Invitation;
    readonly actor: ActingBasis;
  }): Promise<CreateInvitationOutcome> {
    const { invitation } = input;
    if (!this.communityById.has(invitation.communityId)) return { kind: 'not_found' };
    if (!this.basisHolds(invitation.communityId, input.actor)) return { kind: 'basis_lost' };
    if (this.invitationByHash.has(invitation.tokenHash)) return { kind: 'token_collision' };
    if (this.invitationById.has(invitation.id)) throw new Error('duplicate invitation id');
    this.invitationById.set(invitation.id, invitation);
    this.invitationByHash.set(invitation.tokenHash, invitation.id);
    return { kind: 'created' };
  }

  async revokeInvitation(input: {
    readonly communityId: string;
    readonly invitationId: string;
    readonly actor: ActingBasis;
    readonly revokedBy: string | null;
    readonly at: Date;
  }): Promise<RevokeInvitationOutcome> {
    if (!this.basisHolds(input.communityId, input.actor)) return { kind: 'basis_lost' };
    const invitation = this.invitationById.get(input.invitationId);
    if (invitation === undefined || invitation.communityId !== input.communityId) {
      return { kind: 'not_found' };
    }
    if (invitation.revokedAt !== null) return { kind: 'unchanged', invitation };
    const revoked: Invitation = {
      ...invitation,
      revokedAt: later(input.at, invitation.createdAt),
      revokedBy: input.revokedBy,
    };
    this.invitationById.set(revoked.id, revoked);
    return { kind: 'revoked', invitation: revoked };
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<{
    readonly invitationId: string;
    readonly communityId: string;
    readonly createdBy: string;
  } | null> {
    const id = this.invitationByHash.get(tokenHash);
    const invitation = id === undefined ? undefined : this.invitationById.get(id);
    if (invitation === undefined) return null;
    return {
      invitationId: invitation.id,
      communityId: invitation.communityId,
      createdBy: invitation.createdBy,
    };
  }

  async redeem(input: {
    readonly invitationId: string;
    readonly communityId: string;
    readonly userId: string;
    readonly creatorUserId: string;
    readonly stintId: string;
    readonly at: Date;
  }): Promise<RedeemOutcome> {
    // The same steps, in the same order, as the transaction (§7.3).
    const latest = latestStint(this.stintsOf(input.communityId, input.userId));
    if (latest?.status === 'ACTIVE') return { kind: 'already_member' };
    if (latest?.status === 'REMOVED') return { kind: 'removed' };

    const invitation = this.invitationById.get(input.invitationId);
    if (invitation === undefined || invitation.communityId !== input.communityId) {
      return { kind: 'not_found' };
    }
    const state = invitationState(invitation, input.at);
    if (state === 'REVOKED') return { kind: 'revoked' };
    if (state === 'EXPIRED') return { kind: 'expired' };
    if (state === 'EXHAUSTED') return { kind: 'exhausted' };

    const creator = this.activeStint(input.communityId, input.creatorUserId);
    if (creator?.standing !== 'OWNER') return { kind: 'creator_lost' };

    const community = this.communityById.get(input.communityId);
    if (community === undefined) return { kind: 'not_found' };
    if (!effectsOf(community.status).acceptsMembers) return { kind: 'locked' };

    const stint = memberStint({
      id: input.stintId,
      communityId: community.id,
      userId: input.userId,
      source: 'INVITATION',
      addedBy: null,
      invitationId: invitation.id,
      at: input.at,
      version: community.membershipVersion + 1,
    });
    this.invitationById.set(invitation.id, { ...invitation, uses: invitation.uses + 1 });
    this.communityById.set(community.id, {
      ...community,
      memberCount: community.memberCount + 1,
      membershipVersion: stint.version,
      updatedAt: later(community.updatedAt, input.at),
    });
    this.putStint(stint);
    return { kind: 'joined', stint };
  }

  // ── CommunityReadModel ─────────────────────────────────────────────────

  async myCommunities(
    userId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly MyCommunity[]> {
    const rows: MyCommunity[] = [];
    for (const [key, stintId] of this.activeByPair) {
      if (!key.endsWith(`\u0000${userId}`)) continue;
      const stint = this.stintById.get(stintId);
      const community = stint === undefined ? undefined : this.communityById.get(stint.communityId);
      if (stint !== undefined && community !== undefined) rows.push({ community, stint });
    }
    const keyOf = (row: MyCommunity): Keyset => ({ at: row.stint.joinedAt, id: row.community.id });
    return rows
      .filter((row) => page.before === undefined || byKey(keyOf(row), page.before) < 0)
      .sort((a, b) => byKey(keyOf(b), keyOf(a)))
      .slice(0, page.limit);
  }

  async allCommunities(page: {
    readonly before?: Keyset;
    readonly limit: number;
  }): Promise<readonly Community[]> {
    const keyOf = (community: Community): Keyset => ({ at: community.createdAt, id: community.id });
    return [...this.communityById.values()]
      .filter((community) => page.before === undefined || byKey(keyOf(community), page.before) < 0)
      .sort((a, b) => byKey(keyOf(b), keyOf(a)))
      .slice(0, page.limit);
  }

  async roster(
    communityId: string,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly Stint[]> {
    const keyOf = (stint: Stint): Keyset => ({ at: stint.joinedAt, id: stint.userId });
    return this.activeStintsOf(communityId)
      .filter((stint) => page.after === undefined || byKey(keyOf(stint), page.after) > 0)
      .sort((a, b) => byKey(keyOf(a), keyOf(b)))
      .slice(0, page.limit);
  }

  async invitations(
    communityId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly Invitation[]> {
    const keyOf = (invitation: Invitation): Keyset => ({
      at: invitation.createdAt,
      id: invitation.id,
    });
    return [...this.invitationById.values()]
      .filter((invitation) => invitation.communityId === communityId)
      .filter(
        (invitation) => page.before === undefined || byKey(keyOf(invitation), page.before) < 0,
      )
      .sort((a, b) => byKey(keyOf(b), keyOf(a)))
      .slice(0, page.limit);
  }

  async findInvitation(communityId: string, invitationId: string): Promise<Invitation | null> {
    const invitation = this.invitationById.get(invitationId);
    return invitation?.communityId === communityId ? invitation : null;
  }

  async communities(ids: readonly string[]): Promise<readonly Community[]> {
    return ids.flatMap((id) => {
      const community = this.communityById.get(id);
      return community === undefined ? [] : [community];
    });
  }

  async communitiesAfter(
    afterId: string | undefined,
    limit: number,
  ): Promise<readonly Community[]> {
    return [...this.communityById.values()]
      .filter((community) => afterId === undefined || community.id > afterId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  async latestStints(communityId: string, userIds: readonly string[]): Promise<readonly Stint[]> {
    return [...new Set(userIds)].flatMap((userId) => {
      const latest = latestStint(this.stintsOf(communityId, userId));
      return latest === null ? [] : [latest];
    });
  }

  async changesSince(
    communityId: string,
    afterVersion: number,
    limit: number,
  ): Promise<{ readonly community: Community; readonly stints: readonly Stint[] } | null> {
    const community = this.communityById.get(communityId);
    if (community === undefined) return null;
    const stints = [...(this.stintsByCommunity.get(communityId) ?? [])]
      .map((id) => this.stintById.get(id))
      .filter((stint): stint is Stint => stint !== undefined && stint.version > afterVersion)
      .sort((a, b) => a.version - b.version)
      .slice(0, limit);
    return { community, stints };
  }

  async memberIds(
    communityId: string,
    page: {
      readonly afterUserId?: string;
      readonly onlyUserIds?: readonly string[];
      readonly excludeUserId?: string;
      readonly limit: number;
    },
  ): Promise<readonly string[]> {
    const only = page.onlyUserIds === undefined ? null : new Set(page.onlyUserIds);
    return this.activeStintsOf(communityId)
      .map((stint) => stint.userId)
      .filter((userId) => page.afterUserId === undefined || userId > page.afterUserId)
      .filter((userId) => only === null || only.has(userId))
      .filter((userId) => userId !== page.excludeUserId)
      .sort()
      .slice(0, page.limit);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private readAuthority(communityId: string, userId: string): CommunityAuthorityRead {
    const community = this.communityById.get(communityId) ?? null;
    const stint = community === null ? null : this.activeStint(communityId, userId);
    return {
      community,
      stint:
        stint === null
          ? null
          : {
              id: stint.id,
              standing: stint.standing,
              joinedAt: stint.joinedAt,
              version: stint.version,
            },
    };
  }

  /** The owner's act needs the owner's stint to still be the ACTIVE owner stint. */
  private basisHolds(communityId: string, actor: ActingBasis): boolean {
    if (actor.kind === 'oversight') return true;
    const stint = this.stintById.get(actor.membershipId);
    return (
      stint !== undefined &&
      stint.communityId === communityId &&
      stint.userId === actor.userId &&
      stint.status === 'ACTIVE' &&
      stint.standing === 'OWNER'
    );
  }

  private activeStint(communityId: string, userId: string): Stint | null {
    const id = this.activeByPair.get(pair(communityId, userId));
    return id === undefined ? null : (this.stintById.get(id) ?? null);
  }

  private activeStintsOf(communityId: string): Stint[] {
    return [...(this.stintsByCommunity.get(communityId) ?? [])]
      .map((id) => this.stintById.get(id))
      .filter((stint): stint is Stint => stint?.status === 'ACTIVE');
  }

  private stintsOf(communityId: string, userId: string): Stint[] {
    return (this.stintsByPair.get(pair(communityId, userId)) ?? [])
      .map((id) => this.stintById.get(id))
      .filter((stint): stint is Stint => stint !== undefined);
  }

  private putStint(stint: Stint): void {
    const key = pair(stint.communityId, stint.userId);
    if (stint.status === 'ACTIVE') {
      const current = this.activeByPair.get(key);
      if (current !== undefined && current !== stint.id) {
        throw new Error('a second ACTIVE stint for one person in one community');
      }
      this.activeByPair.set(key, stint.id);
    } else if (this.activeByPair.get(key) === stint.id) {
      this.activeByPair.delete(key);
    }
    if (!this.stintById.has(stint.id)) {
      const ofCommunity = this.stintsByCommunity.get(stint.communityId) ?? new Set<string>();
      ofCommunity.add(stint.id);
      this.stintsByCommunity.set(stint.communityId, ofCommunity);
      this.stintsByPair.set(key, [...(this.stintsByPair.get(key) ?? []), stint.id]);
    }
    this.stintById.set(stint.id, stint);
  }

  /** Ends a stint and moves the community's count and version, together. */
  private end(
    community: Community,
    stint: Stint,
    status: 'LEFT' | 'REMOVED',
    by: string | null,
    at: Date,
  ): Stint {
    const version = community.membershipVersion + 1;
    const ended = endStint(stint, { status, by, at, version });
    this.putStint(ended);
    this.communityById.set(community.id, {
      ...community,
      memberCount: community.memberCount - 1,
      membershipVersion: version,
      updatedAt: later(community.updatedAt, at),
    });
    return ended;
  }
}
