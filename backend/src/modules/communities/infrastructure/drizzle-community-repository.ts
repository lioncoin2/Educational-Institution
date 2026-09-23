import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { DATABASE, postgresErrorCode, type Database } from '../../../platform/database';
import { COMMUNITY_STATUSES, type CommunityStatus } from '../contracts/vocabulary';
import type { Community } from '../domain/community';
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
  LeaveOutcome,
  RedeemOutcome,
  RemoveOutcome,
  RevokeInvitationOutcome,
  StatusChange,
} from '../domain/ports';
import { KeyedMutex } from './keyed-mutex';
import {
  communityRow,
  invitationRow,
  stintRow,
  toCommunity,
  toInvitation,
  toStint,
} from './row-mapping';
import { communities, communityInvitations, communityMembers } from './schema';

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
 *   5 the community row — last: its UPDATE allocates membership versions and
 *     moves member_count, so versions are unique and in commit order
 *   6 new rows
 *
 * (4, grant rows, arrives with delegation in P3.) Every transaction that
 * reaches the community row first passes the per-community admission mutex,
 * before it takes a pool connection. A deadlock victim — which the order
 * should make impossible — retries once, then reports `conflict`.
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
    // user's ACTIVE stint — two unique-index probes per id, whatever the size.
    const rows = await this.db
      .select({
        community: communities,
        stintId: communityMembers.id,
        standing: communityMembers.standing,
        joinedAt: communityMembers.joinedAt,
        version: communityMembers.version,
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
      .where(inArray(communities.id, [...new Set(communityIds)]));
    for (const row of rows) {
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
      // 3: the actor's basis, re-verified under lock (not on oversight).
      if (!(await this.holdsBasis(tx, input.communityId, input.actor))) {
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
      // 3: the actor's basis.
      if (!(await this.holdsBasis(tx, input.communityId, input.actor))) {
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
    readonly removedBy: string | null;
    readonly at: Date;
  }): Promise<RemoveOutcome> {
    return this.write(input.communityId, async (tx) => {
      await this.pairLocks(tx, input.communityId, [input.userId]);
      const target = await this.activeStint(tx, input.communityId, input.userId);
      // 3: the actor's stint FOR SHARE and the target's FOR UPDATE, in ascending id.
      const locks: { id: string; mode: 'share' | 'update' }[] = [];
      if (target !== null) locks.push({ id: target.id, mode: 'update' });
      if (input.actor.kind === 'owner' && input.actor.membershipId !== target?.id) {
        locks.push({ id: input.actor.membershipId, mode: 'share' });
      }
      await this.lockStints(tx, locks);
      if (!(await this.holdsBasis(tx, input.communityId, input.actor))) {
        return { kind: 'basis_lost' };
      }
      if (target === null) {
        return (await this.exists(tx, input.communityId))
          ? { kind: 'not_member' }
          : { kind: 'not_found' };
      }
      if (target.standing === 'OWNER') return { kind: 'owner' };
      const ended = await this.endStint(tx, target, 'REMOVED', input.removedBy, input.at);
      return { kind: 'removed', stint: ended };
    });
  }

  async leave(input: {
    readonly communityId: string;
    readonly userId: string;
    readonly at: Date;
  }): Promise<LeaveOutcome> {
    return this.write(input.communityId, async (tx) => {
      await this.pairLocks(tx, input.communityId, [input.userId]);
      const own = await this.activeStint(tx, input.communityId, input.userId);
      if (own === null) {
        return (await this.exists(tx, input.communityId))
          ? { kind: 'not_member' }
          : { kind: 'not_found' };
      }
      await this.lockStints(tx, [{ id: own.id, mode: 'update' }]);
      if (own.standing === 'OWNER') return { kind: 'owner' };
      const ended = await this.endStint(tx, own, 'LEFT', input.userId, input.at);
      return { kind: 'left', stint: ended };
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
        if (!(await this.holdsBasis(tx, invitation.communityId, input.actor))) {
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
        // 3: the actor's basis; losing it undoes the revocation.
        if (!(await this.holdsBasis(tx, input.communityId, input.actor))) {
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

      // 3: the creator still stands as owner, under lock (P3 adds the grant lookup).
      const [creator] = await tx
        .select({ standing: communityMembers.standing })
        .from(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, input.communityId),
            eq(communityMembers.userId, input.creatorUserId),
            eq(communityMembers.status, 'ACTIVE'),
          ),
        )
        .for('share');
      if (creator?.standing !== 'OWNER') {
        throw new Rollback<RedeemOutcome>({ kind: 'creator_lost' });
      }

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

  /** Step 3: existing stint rows, in ascending id. */
  private async lockStints(
    tx: Transaction,
    locks: readonly { readonly id: string; readonly mode: 'share' | 'update' }[],
  ): Promise<void> {
    for (const lock of [...locks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      await tx
        .select({ id: communityMembers.id })
        .from(communityMembers)
        .where(eq(communityMembers.id, lock.id))
        .for(lock.mode);
    }
  }

  /**
   * An owner's act holds only while the owner's stint is still the ACTIVE
   * owner stint — read FOR SHARE, so a concurrent change serializes with the
   * act. Oversight rests on identity's ceiling and locks no stint.
   */
  private async holdsBasis(
    tx: Transaction,
    communityId: string,
    actor: ActingBasis,
  ): Promise<boolean> {
    if (actor.kind === 'oversight') return true;
    const [row] = await tx
      .select({ id: communityMembers.id })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.id, actor.membershipId),
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.userId, actor.userId),
          eq(communityMembers.status, 'ACTIVE'),
          eq(communityMembers.standing, 'OWNER'),
        ),
      )
      .for('share');
    return row !== undefined;
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
