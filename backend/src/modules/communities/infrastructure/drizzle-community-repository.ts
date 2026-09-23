import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { DATABASE, postgresErrorCode, type Database } from '../../../platform/database';
import { COMMUNITY_CAPABILITIES, type CommunityCapability } from '../contracts/capabilities';
import { COMMUNITY_STATUSES, type CommunityStatus } from '../contracts/vocabulary';
import type { HeldGrant } from '../domain/authority';
import type { Community } from '../domain/community';
import { effectiveCapabilities, mayGrant, mayRemove } from '../domain/delegation';
import { newGrant, type CapabilityGrant, type GrantEndReason } from '../domain/grant';
import { invitationState, type Invitation } from '../domain/invitation';
import { effectsOf } from '../domain/lifecycle';
import { memberStint, type Stint } from '../domain/membership';
import type {
  ActingBasis,
  AddMembersOutcome,
  CommunityAuthorityRead,
  CommunityStore,
  Contended,
  CreateInvitationOutcome,
  GrantOutcome,
  LeaveOutcome,
  OwnerBasis,
  RedeemOutcome,
  RemoveOutcome,
  RevokeGrantOutcome,
  RevokeInvitationOutcome,
  StatusChange,
  TransferOutcome,
} from '../domain/ports';
import { KeyedMutex } from './keyed-mutex';
import {
  communityRow,
  grantRow,
  invitationRow,
  stintRow,
  toCommunity,
  toGrant,
  toInvitation,
  toStint,
} from './row-mapping';
import {
  communities,
  communityCapabilityGrants,
  communityInvitations,
  communityMembers,
} from './schema';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The class key of Communities' per-pair advisory locks: the two-key form,
 * `pg_advisory_xact_lock(class, hashtext('<community>:<user>'))`, lives in a
 * key space academic's single-key locks never share. ("Comm", as an int4.)
 */
const PAIR_LOCK_CLASS = 1_131_375_981;

/** The statuses that accept new members, from the lifecycle table — never hard-coded. */
const ACCEPTING: readonly CommunityStatus[] = COMMUNITY_STATUSES.filter(
  (status) => effectsOf(status).acceptsMembers,
);

const DEADLOCK = '40P01';

/** Ends a transaction with a rollback and an outcome, rather than an error. */
class Rollback<T> extends Error {
  constructor(readonly outcome: T) {
    super('rolled back');
  }
}

const iso = (at: Date) => sql`${at.toISOString()}::timestamptz`;

/** `greatest(column, at)` — a stored instant never moves backwards on a lagging clock. */
const notBefore = (column: unknown, at: Date) => sql`greatest(${column}, ${iso(at)})`;

/** The capabilities in the vocabulary's own order: every grant batch inserts in it (see `grant`). */
const CAPABILITY_ORDER = new Map<string, number>(
  COMMUNITY_CAPABILITIES.map((capability, index) => [capability, index]),
);

/** A grant's ACTIVE predicate, unqualified — as the partial unique index states it. */
const GRANT_ACTIVE = sql`ended_at is null`;

interface VerifiedBasis {
  readonly holds: boolean;
  /** The actor's ACTIVE grants, locked — for the grant basis only (R6 reads them). */
  readonly grants: readonly HeldGrant[];
}

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Communities in Postgres. Every invariant that concurrency could break is
 * decided by the database, and every transaction takes its locks in the one
 * global order (§4), so no interleaving deadlocks:
 *
 *   1 per-pair advisory locks, sorted by computed key and deduplicated
 *   2 the invitation row
 *   3 existing stint rows, in ascending id
 *   4 grant rows: an actor's, FOR SHARE; those that end with a stint, FOR UPDATE
 *   5 the community row — last: its UPDATE allocates membership versions and
 *     moves member_count, so versions are unique and in commit order
 *   6 new rows
 *
 * No transaction takes a row FOR SHARE and later updates it: a stint or a
 * grant that will change is locked FOR UPDATE first. Grant, revoke and
 * transfer never reach the community row. Every transaction that reaches it
 * first passes the per-community admission mutex, before it takes a pool
 * connection. A deadlock victim — which the order should make impossible —
 * retries once, then reports `conflict`.
 *
 * Everything runs at READ COMMITTED: a conditional UPDATE re-evaluates its
 * WHERE on the newest row version after waiting, which is what makes the
 * last use of a link, a lock racing a join, and a revocation racing a
 * redemption come out exactly one way.
 */
@Injectable()
export class DrizzleCommunityRepository implements CommunityStore {
  private readonly logger = new Logger(DrizzleCommunityRepository.name);
  private readonly admission = new KeyedMutex();
  private retries = 0;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // ── The evaluator's read ───────────────────────────────────────────────

  async authorityOf(communityId: string, userId: string): Promise<CommunityAuthorityRead> {
    const reads = await this.authorityOfEach([communityId], userId);
    return reads.get(communityId) ?? { community: null, stint: null };
  }

  async authorityOfEach(
    communityIds: readonly string[],
    userId: string,
  ): Promise<ReadonlyMap<string, CommunityAuthorityRead>> {
    const reads = new Map<string, CommunityAuthorityRead>();
    if (communityIds.length === 0) return reads;
    // One statement on the primary: the communities by id, LEFT JOIN the
    // user's ACTIVE stint, LEFT JOIN that stint's ACTIVE grants (at most one
    // per capability) — unique-index probes per id, whatever the size.
    const rows = await this.db
      .select({
        community: communities,
        stintId: communityMembers.id,
        standing: communityMembers.standing,
        joinedAt: communityMembers.joinedAt,
        version: communityMembers.version,
        grantId: communityCapabilityGrants.id,
        capability: communityCapabilityGrants.capability,
      })
      .from(communities)
      .leftJoin(
        communityMembers,
        and(
          eq(communityMembers.communityId, communities.id),
          eq(communityMembers.userId, userId),
          eq(communityMembers.status, 'ACTIVE'),
        ),
      )
      .leftJoin(
        communityCapabilityGrants,
        and(
          eq(communityCapabilityGrants.membershipId, communityMembers.id),
          isNull(communityCapabilityGrants.endedAt),
        ),
      )
      .where(inArray(communities.id, [...new Set(communityIds)]));
    const grantsOf = new Map<string, HeldGrant[]>();
    for (const row of rows) {
      const grants = grantsOf.get(row.community.id) ?? [];
      grantsOf.set(row.community.id, grants);
      if (row.grantId !== null && row.capability !== null) {
        grants.push({ id: row.grantId, capability: row.capability });
      }
      if (reads.has(row.community.id)) continue;
      reads.set(row.community.id, {
        community: toCommunity(row.community),
        stint:
          row.stintId === null ||
          row.standing === null ||
          row.joinedAt === null ||
          row.version === null
            ? null
            : {
                id: row.stintId,
                standing: row.standing,
                joinedAt: row.joinedAt,
                version: Number(row.version),
                grants,
              },
      });
    }
    return reads;
  }

  async findCommunity(communityId: string): Promise<Community | null> {
    const [row] = await this.db.select().from(communities).where(eq(communities.id, communityId));
    return row === undefined ? null : toCommunity(row);
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  async create(community: Community, owner: Stint): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(communities).values(communityRow(community));
      await tx.insert(communityMembers).values(stintRow(owner));
    });
  }

  async changeStatus(input: {
    readonly communityId: string;
    readonly to: CommunityStatus;
    readonly actor: ActingBasis;
    readonly actorUserId: string | null;
    readonly at: Date;
  }): Promise<StatusChange> {
    const from: CommunityStatus = input.to === 'LOCKED' ? 'OPEN' : 'LOCKED';
    return this.write(input.communityId, async (tx) => {
      // 3, 4: the actor's basis, re-verified under lock (not on oversight).
      if (!(await this.verifyBasis(tx, input.communityId, input.actor)).holds) {
        return { kind: 'basis_lost' };
      }
      // 5: an absolute target, so the conditional UPDATE is the whole race.
      const [row] = await tx
        .update(communities)
        .set({
          status: input.to,
          lifecycleVersion: sql`${communities.lifecycleVersion} + 1`,
          statusChangedAt: input.at,
          statusChangedBy: input.actorUserId,
          updatedAt: notBefore(communities.updatedAt, input.at),
        })
        .where(and(eq(communities.id, input.communityId), eq(communities.status, from)))
        .returning();
      if (row !== undefined) return { kind: 'changed', community: toCommunity(row) };
      const [current] = await tx
        .select()
        .from(communities)
        .where(eq(communities.id, input.communityId));
      return current === undefined
        ? { kind: 'not_found' }
        : { kind: 'unchanged', community: toCommunity(current) };
    });
  }

  async addMembers(input: {
    readonly communityId: string;
    readonly userIds: readonly string[];
    readonly actor: ActingBasis;
    readonly addedBy: string | null;
    readonly at: Date;
    readonly newId: () => string;
  }): Promise<AddMembersOutcome> {
    const userIds = [...new Set(input.userIds)];
    return this.write(input.communityId, async (tx) => {
      // 1: every (community, person) pair, in computed-key order.
      await this.pairLocks(tx, input.communityId, userIds);
      // 3, 4: the actor's basis.
      if (!(await this.verifyBasis(tx, input.communityId, input.actor)).holds) {
        return { kind: 'basis_lost' };
      }
      // Who is already in — stable under the pair locks.
      const current = await tx
        .select({ userId: communityMembers.userId })
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, input.communityId),
            inArray(communityMembers.userId, userIds),
            eq(communityMembers.status, 'ACTIVE'),
          ),
        );
      const members = new Set(current.map((row) => row.userId));
      const newcomers = userIds.filter((userId) => !members.has(userId));
      const unchanged = userIds.filter((userId) => members.has(userId));
      if (newcomers.length === 0) {
        return (await this.exists(tx, input.communityId))
          ? { kind: 'added', added: [], unchanged }
          : { kind: 'not_found' };
      }
      // 5: the lifecycle gate, the counter and n versions, in one statement.
      const allocated = await this.allocate(
        tx,
        input.communityId,
        newcomers.length,
        input.at,
        true,
      );
      if (allocated === null) {
        return (await this.exists(tx, input.communityId))
          ? { kind: 'locked' }
          : { kind: 'not_found' };
      }
      // 6: the new stints take the last n versions, in order.
      const first = allocated - newcomers.length + 1;
      const added = newcomers.map((userId, index) =>
        memberStint({
          id: input.newId(),
          communityId: input.communityId,
          userId,
          source: 'ADDED',
          addedBy: input.addedBy,
          invitationId: null,
          at: input.at,
          version: first + index,
        }),
      );
      await tx.insert(communityMembers).values(added.map(stintRow));
      return { kind: 'added', added, unchanged };
    });
  }

  async removeMember(input: {
    readonly communityId: string;
    readonly userId: string;
    readonly actor: ActingBasis;
    readonly removerCeilings: ReadonlySet<CommunityCapability>;
    readonly removedBy: string | null;
    readonly at: Date;
  }): Promise<RemoveOutcome> {
    const { actor } = input;
    return this.write(input.communityId, async (tx) => {
      await this.pairLocks(tx, input.communityId, [input.userId]);
      const found = await this.activeStint(tx, input.communityId, input.userId);
      // 3: the target's stint FOR UPDATE and the actor's FOR SHARE, in ascending id.
      const locks: { id: string; mode: 'share' | 'update' }[] = [];
      if (found !== null) locks.push({ id: found.id, mode: 'update' });
      if (actor.kind !== 'oversight' && actor.membershipId !== found?.id) {
        locks.push({ id: actor.membershipId, mode: 'share' });
      }
      const locked = await this.lockStints(tx, locks);
      // Decide on the row as it is now: the pair lock kept its status, but a
      // transfer may have made the target the owner while this waited.
      const target = found === null ? null : (locked.get(found.id) ?? null);
      // 4: the target's grants FOR UPDATE — they end with the stint, and R6
      // reads them — then the actor's basis (a delegate removing themself
      // already holds these rows FOR UPDATE, so nothing is upgraded).
      const targetGrants = target === null ? [] : await this.lockGrantsOf(tx, target.id);
      const basis = await this.verifyBasis(tx, input.communityId, actor);
      if (!basis.holds) return { kind: 'basis_lost' };
      if (target === null) {
        return (await this.exists(tx, input.communityId))
          ? { kind: 'not_member' }
          : { kind: 'not_found' };
      }
      const decision = mayRemove({
        basis: actor.kind,
        target,
        targetGrants: targetGrants.map((grant) => grant.capability),
        removerEffective: effectiveCapabilities(
          basis.grants.map((grant) => grant.capability),
          input.removerCeilings,
        ),
      });
      if (decision === 'owner') return { kind: 'owner' };
      if (decision === 'holds_more') return { kind: 'holds_more' };
      const endedGrants = await this.endGrantsOf(
        tx,
        target.id,
        'membership_ended',
        input.removedBy,
        input.at,
      );
      const ended = await this.endStint(tx, target, 'REMOVED', input.removedBy, input.at);
      return { kind: 'removed', stint: ended, endedGrants };
    });
  }

  async leave(input: {
    readonly communityId: string;
    readonly userId: string;
    readonly at: Date;
  }): Promise<LeaveOutcome> {
    return this.write(input.communityId, async (tx) => {
      await this.pairLocks(tx, input.communityId, [input.userId]);
      const found = await this.activeStint(tx, input.communityId, input.userId);
      if (found === null) {
        return (await this.exists(tx, input.communityId))
          ? { kind: 'not_member' }
          : { kind: 'not_found' };
      }
      // 3: as it is once locked — a transfer may have made them the owner meanwhile.
      const own = (await this.lockStints(tx, [{ id: found.id, mode: 'update' }])).get(found.id);
      if (own === undefined) throw new Error(`stint ${found.id} vanished under its pair lock`);
      if (own.standing === 'OWNER') return { kind: 'owner' };
      // 4: every grant on the stint ends with it.
      const endedGrants = await this.endGrantsOf(
        tx,
        own.id,
        'membership_ended',
        input.userId,
        input.at,
      );
      const ended = await this.endStint(tx, own, 'LEFT', input.userId, input.at);
      return { kind: 'left', stint: ended, endedGrants };
    });
  }

  async createInvitation(input: {
    readonly invitation: Invitation;
    readonly actor: ActingBasis;
  }): Promise<CreateInvitationOutcome> {
    const { invitation } = input;
    // No community row: a link does not need admission.
    return this.retrying(() =>
      this.transact(async (tx) => {
        if (!(await this.exists(tx, invitation.communityId))) return { kind: 'not_found' };
        if (!(await this.verifyBasis(tx, invitation.communityId, input.actor)).holds) {
          return { kind: 'basis_lost' };
        }
        const inserted = await tx
          .insert(communityInvitations)
          .values(invitationRow(invitation))
          .onConflictDoNothing({ target: communityInvitations.tokenHash })
          .returning({ id: communityInvitations.id });
        return inserted.length === 0 ? { kind: 'token_collision' } : { kind: 'created' };
      }),
    );
  }

  async revokeInvitation(input: {
    readonly communityId: string;
    readonly invitationId: string;
    readonly actor: ActingBasis;
    readonly revokedBy: string | null;
    readonly at: Date;
  }): Promise<RevokeInvitationOutcome> {
    return this.retrying(() =>
      this.transact(async (tx) => {
        // 2: the invitation row — one-way, and linearized with redemption.
        const [row] = await tx
          .update(communityInvitations)
          .set({
            revokedAt: notBefore(communityInvitations.createdAt, input.at),
            revokedBy: input.revokedBy,
          })
          .where(
            and(
              eq(communityInvitations.id, input.invitationId),
              eq(communityInvitations.communityId, input.communityId),
              sql`${communityInvitations.revokedAt} is null`,
            ),
          )
          .returning();
        // 3, 4: the actor's basis; losing it undoes the revocation.
        if (!(await this.verifyBasis(tx, input.communityId, input.actor)).holds) {
          throw new Rollback<RevokeInvitationOutcome>({ kind: 'basis_lost' });
        }
        if (row !== undefined) return { kind: 'revoked', invitation: toInvitation(row) };
        const [current] = await tx
          .select()
          .from(communityInvitations)
          .where(
            and(
              eq(communityInvitations.id, input.invitationId),
              eq(communityInvitations.communityId, input.communityId),
            ),
          );
        return current === undefined
          ? { kind: 'not_found' }
          : { kind: 'unchanged', invitation: toInvitation(current) };
      }),
    );
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<{
    readonly invitationId: string;
    readonly communityId: string;
    readonly createdBy: string;
  } | null> {
    const [row] = await this.db
      .select({
        invitationId: communityInvitations.id,
        communityId: communityInvitations.communityId,
        createdBy: communityInvitations.createdBy,
      })
      .from(communityInvitations)
      .where(eq(communityInvitations.tokenHash, tokenHash));
    return row ?? null;
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
    return this.write(input.communityId, async (tx) => {
      // 1: the pair lock serializes everything that changes (C, U).
      await this.pairLocks(tx, input.communityId, [input.userId]);
      const [latest] = await tx
        .select({ status: communityMembers.status })
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, input.communityId),
            eq(communityMembers.userId, input.userId),
          ),
        )
        .orderBy(sql`${communityMembers.version} desc`)
        .limit(1);
      if (latest?.status === 'ACTIVE') return { kind: 'already_member' };
      if (latest?.status === 'REMOVED') return { kind: 'removed' };

      // 2: the invitation's gate and its use, in one statement.
      const [used] = await tx
        .update(communityInvitations)
        .set({ uses: sql`${communityInvitations.uses} + 1` })
        .where(
          and(
            eq(communityInvitations.id, input.invitationId),
            eq(communityInvitations.communityId, input.communityId),
            sql`${communityInvitations.revokedAt} is null`,
            sql`${communityInvitations.expiresAt} > ${iso(input.at)}`,
            sql`(${communityInvitations.maxUses} is null or ${communityInvitations.uses} < ${communityInvitations.maxUses})`,
          ),
        )
        .returning({ id: communityInvitations.id });
      if (used === undefined) {
        // Re-read with the same instant: why the link refused.
        const [link] = await tx
          .select()
          .from(communityInvitations)
          .where(
            and(
              eq(communityInvitations.id, input.invitationId),
              eq(communityInvitations.communityId, input.communityId),
            ),
          );
        if (link === undefined) return { kind: 'not_found' };
        switch (invitationState(toInvitation(link), input.at)) {
          case 'REVOKED':
            return { kind: 'revoked' };
          case 'EXPIRED':
            return { kind: 'expired' };
          case 'EXHAUSTED':
            return { kind: 'exhausted' };
          case 'ACTIVE':
            return { kind: 'conflict' };
        }
      }

      // 3: the creator still stands, under lock: as the owner — or, 4, as the
      // holder of an ACTIVE grant of the capability a link needs.
      const [creator] = await tx
        .select({ id: communityMembers.id, standing: communityMembers.standing })
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, input.communityId),
            eq(communityMembers.userId, input.creatorUserId),
            eq(communityMembers.status, 'ACTIVE'),
          ),
        )
        .for('share');
      let admits = creator?.standing === 'OWNER';
      if (!admits && creator !== undefined) {
        const [grant] = await tx
          .select({ id: communityCapabilityGrants.id })
          .from(communityCapabilityGrants)
          .where(
            and(
              eq(communityCapabilityGrants.membershipId, creator.id),
              eq(communityCapabilityGrants.capability, input.creatorCapability),
              isNull(communityCapabilityGrants.endedAt),
            ),
          )
          .for('share');
        admits = grant !== undefined;
      }
      if (!admits) throw new Rollback<RedeemOutcome>({ kind: 'creator_lost' });

      // 5: the lifecycle gate, the counter and the version, in one statement.
      const version = await this.allocate(tx, input.communityId, 1, input.at, true);
      if (version === null) throw new Rollback<RedeemOutcome>({ kind: 'locked' });

      // 6: the new stint.
      const stint = memberStint({
        id: input.stintId,
        communityId: input.communityId,
        userId: input.userId,
        source: 'INVITATION',
        addedBy: null,
        invitationId: input.invitationId,
        at: input.at,
        version,
      });
      await tx.insert(communityMembers).values(stintRow(stint));
      return { kind: 'joined', stint };
    });
  }

  // ── Delegation and ownership (P3) ──────────────────────────────────────

  async grant(input: {
    readonly communityId: string;
    readonly owner: OwnerBasis;
    readonly granteeUserId: string;
    readonly capabilities: readonly CommunityCapability[];
    readonly at: Date;
    readonly newId: () => string;
  }): Promise<GrantOutcome> {
    // One order for every batch: two batches naming the same capabilities
    // for one grantee insert them in the same order, so the second waits on
    // the first's row instead of each waiting on the other's.
    const capabilities = [...new Set(input.capabilities)].sort(
      (a, b) => (CAPABILITY_ORDER.get(a) ?? 0) - (CAPABILITY_ORDER.get(b) ?? 0),
    );
    // No community row, no admission: a grant never touches it.
    return this.retrying(() =>
      this.transact(async (tx) => {
        // 3: the owner's and the grantee's ACTIVE stints, FOR SHARE, in ascending id.
        const stints = await tx
          .select({
            id: communityMembers.id,
            userId: communityMembers.userId,
            standing: communityMembers.standing,
          })
          .from(communityMembers)
          .where(
            and(
              eq(communityMembers.communityId, input.communityId),
              inArray(communityMembers.userId, [input.owner.userId, input.granteeUserId]),
              eq(communityMembers.status, 'ACTIVE'),
            ),
          )
          .orderBy(asc(communityMembers.id))
          .for('share');
        const owner = stints.find((stint) => stint.userId === input.owner.userId);
        if (owner?.id !== input.owner.membershipId || owner.standing !== 'OWNER') {
          return { kind: 'basis_lost' };
        }
        const grantee =
          stints.find((stint) => stint.userId === input.granteeUserId && stint.id !== owner.id) ??
          null;
        if (grantee === null || !mayGrant({ grantorUserId: owner.userId, grantee })) {
          return { kind: 'grantee_ineligible' };
        }
        // 6: one row per capability not already held; an identical grant in
        // flight is waited for on the partial unique index, then skipped (R7).
        const inserted = await tx
          .insert(communityCapabilityGrants)
          .values(
            capabilities.map((capability) =>
              grantRow(
                newGrant({
                  id: input.newId(),
                  communityId: input.communityId,
                  membershipId: grantee.id,
                  userId: grantee.userId,
                  capability,
                  grantedBy: owner.userId,
                  at: input.at,
                }),
              ),
            ),
          )
          .onConflictDoNothing({
            target: [communityCapabilityGrants.membershipId, communityCapabilityGrants.capability],
            where: GRANT_ACTIVE,
          })
          .returning();
        const created = inserted.map(toGrant);
        const createdCapabilities = new Set(created.map((grant) => grant.capability));
        const held = capabilities.filter((capability) => !createdCapabilities.has(capability));
        const unchanged =
          held.length === 0
            ? []
            : (
                await tx
                  .select()
                  .from(communityCapabilityGrants)
                  .where(
                    and(
                      eq(communityCapabilityGrants.membershipId, grantee.id),
                      inArray(communityCapabilityGrants.capability, held),
                      isNull(communityCapabilityGrants.endedAt),
                    ),
                  )
              ).map(toGrant);
        return { kind: 'granted', created, unchanged };
      }),
    );
  }

  async revokeGrant(input: {
    readonly communityId: string;
    readonly grantId: string;
    readonly owner: OwnerBasis;
    readonly at: Date;
  }): Promise<RevokeGrantOutcome> {
    return this.retrying(() =>
      this.transact(async (tx) => {
        // 3: the owner's standing.
        if (!(await this.ownerHolds(tx, input.communityId, input.owner))) {
          return { kind: 'basis_lost' };
        }
        // 4: the grant — one-way, and linearized with every act resting on it.
        const [row] = await tx
          .update(communityCapabilityGrants)
          .set({
            endedAt: notBefore(communityCapabilityGrants.grantedAt, input.at),
            endedBy: input.owner.userId,
            endReason: 'revoked',
          })
          .where(
            and(
              eq(communityCapabilityGrants.id, input.grantId),
              eq(communityCapabilityGrants.communityId, input.communityId),
              isNull(communityCapabilityGrants.endedAt),
            ),
          )
          .returning();
        if (row !== undefined) return { kind: 'revoked', grant: toGrant(row) };
        const [current] = await tx
          .select()
          .from(communityCapabilityGrants)
          .where(
            and(
              eq(communityCapabilityGrants.id, input.grantId),
              eq(communityCapabilityGrants.communityId, input.communityId),
            ),
          );
        return current === undefined
          ? { kind: 'not_found' }
          : { kind: 'unchanged', grant: toGrant(current) };
      }),
    );
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
    return this.retrying(() =>
      this.transact(async (tx) => {
        // Who the owner and the target are now…
        const [owner] = await tx
          .select()
          .from(communityMembers)
          .where(
            and(
              eq(communityMembers.communityId, input.communityId),
              eq(communityMembers.standing, 'OWNER'),
            ),
          );
        if (owner === undefined) return { kind: 'not_found' };
        const target = await this.activeStint(tx, input.communityId, input.toUserId);
        if (target === null) return { kind: 'target_not_member' };
        if (actor.kind === 'owner' && owner.id !== actor.membershipId) {
          return { kind: 'owner_conflict' };
        }
        if (target.id === owner.id) return { kind: 'unchanged' };
        // …then 3: both stints FOR UPDATE in ascending id, and re-read. A
        // transfer or removal that committed while this one waited wins.
        const locked = await this.lockStints(tx, [
          { id: owner.id, mode: 'update' },
          { id: target.id, mode: 'update' },
        ]);
        const from = locked.get(owner.id);
        const to = locked.get(target.id);
        if (from?.status !== 'ACTIVE' || from.standing !== 'OWNER' || to?.status !== 'ACTIVE') {
          return { kind: 'owner_conflict' };
        }
        // 4: the new owner's grants end — they hold everything now.
        const endedGrants = await this.endGrantsOf(
          tx,
          to.id,
          'ownership_changed',
          input.transferredBy,
          input.at,
        );
        // Demote, then promote: the one-owner index cannot be deferred.
        const [demoted] = await tx
          .update(communityMembers)
          .set({ standing: 'MEMBER' })
          .where(eq(communityMembers.id, from.id))
          .returning();
        const [promoted] = await tx
          .update(communityMembers)
          .set({ standing: 'OWNER' })
          .where(eq(communityMembers.id, to.id))
          .returning();
        if (demoted === undefined || promoted === undefined) {
          throw new Error(`stints of ${input.communityId} vanished while locked`);
        }
        return {
          kind: 'transferred',
          from: toStint(demoted),
          to: toStint(promoted),
          endedGrants,
        };
      }),
    );
  }

  // ── Transaction plumbing ───────────────────────────────────────────────

  /**
   * A transaction that reaches the community row: admitted per community,
   * retried once as a deadlock victim, and able to roll back with an outcome.
   */
  private write<T extends { readonly kind: string }>(
    communityId: string,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T | Contended> {
    return this.admission.run(communityId, () => this.retrying(() => this.transact(work)));
  }

  private async transact<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(work);
    } catch (error) {
      if (error instanceof Rollback) return error.outcome as T;
      throw error;
    }
  }

  /**
   * How many transactions were retried as deadlock victims. The lock order
   * should make this zero: each retry is logged, and the concurrency suite
   * asserts it stayed zero — a retry that succeeds would otherwise hide a
   * deadlock from every outcome.
   */
  get deadlockRetries(): number {
    return this.retries;
  }

  private async retrying<T>(work: () => Promise<T>): Promise<T | Contended> {
    try {
      return await work();
    } catch (error) {
      if (postgresErrorCode(error) !== DEADLOCK) throw error;
      this.retries += 1;
      this.logger.warn({ sqlstate: DEADLOCK }, 'deadlock victim; retrying once');
    }
    try {
      return await work();
    } catch (error) {
      if (postgresErrorCode(error) === DEADLOCK) return { kind: 'conflict' };
      throw error;
    }
  }

  /** Step 1: pair locks, sorted by the computed key — never by user id — and deduplicated. */
  private async pairLocks(
    tx: Transaction,
    communityId: string,
    userIds: readonly string[],
  ): Promise<void> {
    if (userIds.length === 0) return;
    await tx.execute(sql`
      select pg_advisory_xact_lock(${PAIR_LOCK_CLASS}::int4, keys.k)
        from (select distinct hashtext(${communityId}::text || ':' || u) as k
                from unnest(${textArray(userIds)}) as u) as keys
       order by keys.k`);
  }

  /**
   * Step 3: existing stint rows, in ascending id — each returned as it is once
   * locked. Anything decided about a stint is decided on this read, never on
   * one made before the lock: a row read earlier may have changed while this
   * transaction waited for it.
   */
  private async lockStints(
    tx: Transaction,
    locks: readonly { readonly id: string; readonly mode: 'share' | 'update' }[],
  ): Promise<ReadonlyMap<string, Stint>> {
    const rows = new Map<string, Stint>();
    for (const lock of [...locks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const [row] = await tx
        .select()
        .from(communityMembers)
        .where(eq(communityMembers.id, lock.id))
        .for(lock.mode);
      if (row !== undefined) rows.set(row.id, toStint(row));
    }
    return rows;
  }

  /**
   * The actor's basis, re-verified under lock (ADR 0017), so a concurrent
   * change serializes with the act: it commits first, authorized at that
   * instant, or the act finds its basis gone.
   *
   *   owner      the owner's stint, FOR SHARE: still the ACTIVE owner stint
   *   grant      the delegate's stint, FOR SHARE: still ACTIVE; then 4, every
   *              ACTIVE grant on it, FOR SHARE: the one the act rests on among
   *              them (R6 reads the rest)
   *   oversight  identity's ceiling alone: nothing to lock
   */
  private async verifyBasis(
    tx: Transaction,
    communityId: string,
    actor: ActingBasis,
  ): Promise<VerifiedBasis> {
    if (actor.kind === 'oversight') return { holds: true, grants: [] };
    if (actor.kind === 'owner') {
      return { holds: await this.ownerHolds(tx, communityId, actor), grants: [] };
    }
    const [stint] = await tx
      .select({ id: communityMembers.id })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.id, actor.membershipId),
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.userId, actor.userId),
          eq(communityMembers.status, 'ACTIVE'),
        ),
      )
      .for('share');
    if (stint === undefined) return { holds: false, grants: [] };
    const grants = await tx
      .select({
        id: communityCapabilityGrants.id,
        capability: communityCapabilityGrants.capability,
      })
      .from(communityCapabilityGrants)
      .where(
        and(
          eq(communityCapabilityGrants.membershipId, actor.membershipId),
          isNull(communityCapabilityGrants.endedAt),
        ),
      )
      .orderBy(asc(communityCapabilityGrants.id))
      .for('share');
    return {
      holds: grants.some(
        (grant) => grant.id === actor.grantId && grant.capability === actor.capability,
      ),
      grants,
    };
  }

  /** The owner's act holds only while the owner's stint is still the ACTIVE owner stint. */
  private async ownerHolds(
    tx: Transaction,
    communityId: string,
    owner: OwnerBasis,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: communityMembers.id })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.id, owner.membershipId),
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.userId, owner.userId),
          eq(communityMembers.status, 'ACTIVE'),
          eq(communityMembers.standing, 'OWNER'),
        ),
      )
      .for('share');
    return row !== undefined;
  }

  /** Step 4: a stint's ACTIVE grants, FOR UPDATE in ascending id — they are about to end. */
  private async lockGrantsOf(tx: Transaction, membershipId: string): Promise<CapabilityGrant[]> {
    const rows = await tx
      .select()
      .from(communityCapabilityGrants)
      .where(
        and(
          eq(communityCapabilityGrants.membershipId, membershipId),
          isNull(communityCapabilityGrants.endedAt),
        ),
      )
      .orderBy(asc(communityCapabilityGrants.id))
      .for('update');
    return rows.map(toGrant);
  }

  /** Ends every ACTIVE grant on a stint whose rows this transaction may lock or already holds. */
  private async endGrantsOf(
    tx: Transaction,
    membershipId: string,
    reason: GrantEndReason,
    by: string | null,
    at: Date,
  ): Promise<CapabilityGrant[]> {
    const rows = await tx
      .update(communityCapabilityGrants)
      .set({
        endedAt: notBefore(communityCapabilityGrants.grantedAt, at),
        endedBy: by,
        endReason: reason,
      })
      .where(
        and(
          eq(communityCapabilityGrants.membershipId, membershipId),
          isNull(communityCapabilityGrants.endedAt),
        ),
      )
      .returning();
    return rows.map(toGrant).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private async activeStint(
    tx: Transaction,
    communityId: string,
    userId: string,
  ): Promise<Stint | null> {
    const [row] = await tx
      .select()
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.userId, userId),
          eq(communityMembers.status, 'ACTIVE'),
        ),
      );
    return row === undefined ? null : toStint(row);
  }

  private async exists(tx: Transaction, communityId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.id, communityId));
    return row !== undefined;
  }

  /**
   * Step 5: moves the community row's counter and allocates `n` membership
   * versions — the last of which is returned. The row lock is held until
   * commit, so versions are unique and in commit order. `joining` adds the
   * lifecycle gate; null means the gate refused (or the row is missing).
   */
  private async allocate(
    tx: Transaction,
    communityId: string,
    delta: number,
    at: Date,
    joining: boolean,
  ): Promise<number | null> {
    const n = Math.abs(delta);
    const [row] = await tx
      .update(communities)
      .set({
        memberCount: sql`${communities.memberCount} + ${delta}`,
        membershipVersion: sql`${communities.membershipVersion} + ${n}`,
        updatedAt: notBefore(communities.updatedAt, at),
      })
      .where(
        joining
          ? and(eq(communities.id, communityId), inArray(communities.status, [...ACCEPTING]))
          : eq(communities.id, communityId),
      )
      .returning({ membershipVersion: communities.membershipVersion });
    return row === undefined ? null : Number(row.membershipVersion);
  }

  /** Ends a locked ACTIVE stint: the counter down, a new version, the stint stamped. */
  private async endStint(
    tx: Transaction,
    stint: Stint,
    status: 'LEFT' | 'REMOVED',
    by: string | null,
    at: Date,
  ): Promise<Stint> {
    const version = await this.allocate(tx, stint.communityId, -1, at, false);
    if (version === null) throw new Error(`community ${stint.communityId} vanished while locked`);
    const [row] = await tx
      .update(communityMembers)
      .set({
        status,
        endedAt: notBefore(communityMembers.joinedAt, at),
        endedBy: status === 'LEFT' ? stint.userId : by,
        version,
      })
      .where(and(eq(communityMembers.id, stint.id), eq(communityMembers.status, 'ACTIVE')))
      .returning();
    if (row === undefined) throw new Error(`stint ${stint.id} ended while locked`);
    return toStint(row);
  }
}
