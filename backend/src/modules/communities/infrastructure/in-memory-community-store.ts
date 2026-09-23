import { Injectable } from '@nestjs/common';

import { COMMUNITY_CAPABILITIES, type CommunityCapability } from '../contracts/capabilities';
import type { CommunityStatus } from '../contracts/vocabulary';
import type { Community } from '../domain/community';
import { effectiveCapabilities, mayGrant, mayRemove } from '../domain/delegation';
import {
  endGrant,
  isActiveGrant,
  newGrant,
  type CapabilityGrant,
  type GrantEndReason,
} from '../domain/grant';
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
  GrantKey,
  GrantOutcome,
  Keyset,
  LeaveOutcome,
  MyCommunity,
  OwnerBasis,
  RedeemOutcome,
  RemoveOutcome,
  RevokeGrantOutcome,
  RevokeInvitationOutcome,
  StatusChange,
  TransferOutcome,
} from '../domain/ports';

const pair = (communityId: string, userId: string) => `${communityId}\u0000${userId}`;

const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/** (at, id) ascending. */
function byKey(a: Keyset, b: Keyset): number {
  const t = a.at.getTime() - b.at.getTime();
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** (capability, user) ascending — Postgres' text order for these ASCII values. */
function byGrantKey(a: GrantKey, b: GrantKey): number {
  const c = compare(a.capability, b.capability);
  return c !== 0 ? c : compare(a.userId, b.userId);
}

const CAPABILITY_ORDER = new Map<string, number>(
  COMMUNITY_CAPABILITIES.map((capability, index) => [capability, index]),
);

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
  private readonly grantById = new Map<string, CapabilityGrant>();
  /** Stint id → the ids of its ACTIVE grants (at most one per capability). */
  private readonly activeGrantsByStint = new Map<string, Set<string>>();

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
    if (!this.basis(input.communityId, input.actor).holds) return { kind: 'basis_lost' };
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
    if (!this.basis(input.communityId, input.actor).holds) return { kind: 'basis_lost' };
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
    readonly removerCeilings: ReadonlySet<CommunityCapability>;
    readonly removedBy: string | null;
    readonly at: Date;
  }): Promise<RemoveOutcome> {
    const basis = this.basis(input.communityId, input.actor);
    if (!basis.holds) return { kind: 'basis_lost' };
    const community = this.communityById.get(input.communityId);
    if (community === undefined) return { kind: 'not_found' };
    const stint = this.activeStint(input.communityId, input.userId);
    if (stint === null) return { kind: 'not_member' };
    const decision = mayRemove({
      basis: input.actor.kind,
      target: stint,
      targetGrants: this.activeGrantsOf(stint.id).map((grant) => grant.capability),
      removerEffective: effectiveCapabilities(basis.capabilities, input.removerCeilings),
    });
    if (decision === 'owner') return { kind: 'owner' };
    if (decision === 'holds_more') return { kind: 'holds_more' };
    const endedGrants = this.endGrantsOf(stint.id, 'membership_ended', input.removedBy, input.at);
    const ended = this.end(community, stint, 'REMOVED', input.removedBy, input.at);
    return { kind: 'removed', stint: ended, endedGrants };
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
    const endedGrants = this.endGrantsOf(stint.id, 'membership_ended', input.userId, input.at);
    const ended = this.end(community, stint, 'LEFT', input.userId, input.at);
    return { kind: 'left', stint: ended, endedGrants };
  }

  async createInvitation(input: {
    readonly invitation: Invitation;
    readonly actor: ActingBasis;
  }): Promise<CreateInvitationOutcome> {
    const { invitation } = input;
    if (!this.communityById.has(invitation.communityId)) return { kind: 'not_found' };
    if (!this.basis(invitation.communityId, input.actor).holds) return { kind: 'basis_lost' };
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
    if (!this.basis(input.communityId, input.actor).holds) return { kind: 'basis_lost' };
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
    readonly creatorCapability: CommunityCapability;
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
    const admits =
      creator !== null &&
      (creator.standing === 'OWNER' ||
        this.activeGrantsOf(creator.id).some(
          (grant) => grant.capability === input.creatorCapability,
        ));
    if (!admits) return { kind: 'creator_lost' };

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

  async grant(input: {
    readonly communityId: string;
    readonly owner: OwnerBasis;
    readonly granteeUserId: string;
    readonly capabilities: readonly CommunityCapability[];
    readonly at: Date;
    readonly newId: () => string;
  }): Promise<GrantOutcome> {
    if (!this.ownerHolds(input.communityId, input.owner)) return { kind: 'basis_lost' };
    const grantee = this.activeStint(input.communityId, input.granteeUserId);
    if (grantee === null || !mayGrant({ grantorUserId: input.owner.userId, grantee })) {
      return { kind: 'grantee_ineligible' };
    }
    const capabilities = [...new Set(input.capabilities)].sort(
      (a, b) => (CAPABILITY_ORDER.get(a) ?? 0) - (CAPABILITY_ORDER.get(b) ?? 0),
    );
    const created: CapabilityGrant[] = [];
    const unchanged: CapabilityGrant[] = [];
    for (const capability of capabilities) {
      const held = this.activeGrantsOf(grantee.id).find((grant) => grant.capability === capability);
      if (held !== undefined) {
        unchanged.push(held);
        continue;
      }
      const grant = newGrant({
        id: input.newId(),
        communityId: input.communityId,
        membershipId: grantee.id,
        userId: grantee.userId,
        capability,
        grantedBy: input.owner.userId,
        at: input.at,
      });
      this.putGrant(grant);
      created.push(grant);
    }
    return { kind: 'granted', created, unchanged };
  }

  async revokeGrant(input: {
    readonly communityId: string;
    readonly grantId: string;
    readonly owner: OwnerBasis;
    readonly at: Date;
  }): Promise<RevokeGrantOutcome> {
    if (!this.ownerHolds(input.communityId, input.owner)) return { kind: 'basis_lost' };
    const grant = this.grantById.get(input.grantId);
    if (grant === undefined || grant.communityId !== input.communityId) {
      return { kind: 'not_found' };
    }
    if (!isActiveGrant(grant)) return { kind: 'unchanged', grant };
    const revoked = endGrant(grant, { reason: 'revoked', by: input.owner.userId, at: input.at });
    this.putGrant(revoked);
    return { kind: 'revoked', grant: revoked };
  }

  async transfer(input: {
    readonly communityId: string;
    readonly toUserId: string;
    readonly actor: ActingBasis;
    readonly transferredBy: string | null;
    readonly at: Date;
  }): Promise<TransferOutcome> {
    const { actor } = input;
    if (actor.kind === 'grant') throw new Error('a grant never transfers ownership');
    const owner = this.activeStintsOf(input.communityId).find(
      (stint) => stint.standing === 'OWNER',
    );
    if (owner === undefined) return { kind: 'not_found' };
    const target = this.activeStint(input.communityId, input.toUserId);
    if (target === null) return { kind: 'target_not_member' };
    if (actor.kind === 'owner' && owner.id !== actor.membershipId) {
      return { kind: 'owner_conflict' };
    }
    if (target.id === owner.id) return { kind: 'unchanged' };
    const endedGrants = this.endGrantsOf(
      target.id,
      'ownership_changed',
      input.transferredBy,
      input.at,
    );
    const from: Stint = { ...owner, standing: 'MEMBER' };
    const to: Stint = { ...target, standing: 'OWNER' };
    this.putStint(from);
    this.putStint(to);
    return { kind: 'transferred', from, to, endedGrants };
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
      if (stint !== undefined && community !== undefined) {
        const grants = this.activeGrantsOf(stint.id).map((grant) => ({
          id: grant.id,
          capability: grant.capability,
        }));
        rows.push({ community, stint, grants });
      }
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

  async grants(
    communityId: string,
    page: {
      readonly userId?: string;
      readonly capability?: CommunityCapability;
      readonly after?: GrantKey;
      readonly limit: number;
    },
  ): Promise<readonly CapabilityGrant[]> {
    return [...this.activeGrantsByStint.values()]
      .flatMap((ids) => [...ids])
      .map((id) => this.grantById.get(id))
      .filter((grant): grant is CapabilityGrant => grant?.communityId === communityId)
      .filter((grant) => page.userId === undefined || grant.userId === page.userId)
      .filter((grant) => page.capability === undefined || grant.capability === page.capability)
      .filter((grant) => page.after === undefined || byGrantKey(grant, page.after) > 0)
      .sort(byGrantKey)
      .slice(0, page.limit);
  }

  async holderCandidates(
    communityId: string,
    capability: CommunityCapability,
    page: { readonly afterUserId?: string; readonly limit: number },
  ): Promise<readonly string[]> {
    const holders = new Set<string>();
    for (const stint of this.activeStintsOf(communityId)) {
      if (
        stint.standing === 'OWNER' ||
        this.activeGrantsOf(stint.id).some((grant) => grant.capability === capability)
      ) {
        holders.add(stint.userId);
      }
    }
    return [...holders]
      .filter((userId) => page.afterUserId === undefined || userId > page.afterUserId)
      .sort(compare)
      .slice(0, page.limit);
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
              grants: this.activeGrantsOf(stint.id).map((grant) => ({
                id: grant.id,
                capability: grant.capability,
              })),
            },
    };
  }

  /**
   * The act's basis, as the transaction re-verifies it under lock: the
   * owner's stint still the ACTIVE owner stint; a delegate's stint still
   * ACTIVE with the grant the act rests on still ACTIVE on it (and, for R6,
   * the capabilities of all its ACTIVE grants); oversight, nothing to check.
   */
  private basis(
    communityId: string,
    actor: ActingBasis,
  ): { readonly holds: boolean; readonly capabilities: readonly CommunityCapability[] } {
    if (actor.kind === 'oversight') return { holds: true, capabilities: [] };
    if (actor.kind === 'owner')
      return { holds: this.ownerHolds(communityId, actor), capabilities: [] };
    const stint = this.stintById.get(actor.membershipId);
    if (
      stint === undefined ||
      stint.communityId !== communityId ||
      stint.userId !== actor.userId ||
      stint.status !== 'ACTIVE'
    ) {
      return { holds: false, capabilities: [] };
    }
    const grants = this.activeGrantsOf(stint.id);
    return {
      holds: grants.some(
        (grant) => grant.id === actor.grantId && grant.capability === actor.capability,
      ),
      capabilities: grants.map((grant) => grant.capability),
    };
  }

  /** The owner's act needs the owner's stint to still be the ACTIVE owner stint. */
  private ownerHolds(communityId: string, owner: OwnerBasis): boolean {
    const stint = this.stintById.get(owner.membershipId);
    return (
      stint !== undefined &&
      stint.communityId === communityId &&
      stint.userId === owner.userId &&
      stint.status === 'ACTIVE' &&
      stint.standing === 'OWNER'
    );
  }

  private activeGrantsOf(membershipId: string): CapabilityGrant[] {
    return [...(this.activeGrantsByStint.get(membershipId) ?? [])]
      .map((id) => this.grantById.get(id))
      .filter((grant): grant is CapabilityGrant => grant !== undefined)
      .sort((a, b) => compare(a.id, b.id));
  }

  private putGrant(grant: CapabilityGrant): void {
    const active = this.activeGrantsByStint.get(grant.membershipId) ?? new Set<string>();
    if (isActiveGrant(grant)) {
      const clash = [...active]
        .map((id) => this.grantById.get(id))
        .find((held) => held?.capability === grant.capability && held.id !== grant.id);
      if (clash !== undefined)
        throw new Error('a second ACTIVE grant of one capability on one stint');
      active.add(grant.id);
    } else {
      active.delete(grant.id);
    }
    this.activeGrantsByStint.set(grant.membershipId, active);
    this.grantById.set(grant.id, grant);
  }

  /** Ends every ACTIVE grant on a stint, in id order — as the transaction reports them. */
  private endGrantsOf(
    membershipId: string,
    reason: GrantEndReason,
    by: string | null,
    at: Date,
  ): CapabilityGrant[] {
    return this.activeGrantsOf(membershipId).map((grant) => {
      const ended = endGrant(grant, { reason, by, at });
      this.putGrant(ended);
      return ended;
    });
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
