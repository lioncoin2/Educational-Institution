import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';

import { KeyedMutex } from '../../../platform/concurrency/keyed-mutex';
import {
  DATABASE,
  isUniqueViolation,
  postgresErrorCode,
  type Database,
} from '../../../platform/database';
import {
  HANDS_PAGE_MAX,
  LIVE_SESSIONS_PAGE_MAX,
  PENDING_HANDS_COUNT_CAP,
} from '../domain/live-limits';
import { endSession, isLive, type LiveSession, type LiveSessionKey } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import type {
  EndInput,
  EndOutcome,
  GrantOutcome,
  IneligibleExpiry,
  LiveSessionRepository,
  PresenterCloseInput,
  PresenterCloseOutcome,
  PresenterGrantRepository,
  PresenterOpenOutcome,
  RaiseOutcome,
  SpeakerRequestRepository,
  StartOutcome,
  TransitionInput,
  TransitionOutcome,
} from '../domain/ports';
import { isOpenGrant, type PresenterGrant } from '../domain/presenter-grant';
import {
  judgeTransition,
  transition,
  type QueueKey,
  type SpeakerRequest,
} from '../domain/speaker-request';
import {
  liveSessionRow,
  moderationActionRow,
  presenterGrantRow,
  speakerRequestRow,
  toLiveSession,
  toPresenterGrant,
  toSpeakerRequest,
} from './row-mapping';
import {
  liveModerationActions,
  livePresenterGrants,
  liveSessions,
  liveSpeakerRequests,
} from './schema';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** What a read needs: the pool's handle or a transaction's. */
type Reader = Pick<Database, 'select'>;

const DEADLOCK = '40P01';

/** The presenter slot's partial unique index (P1): the claim's backstop. */
const PRESENTER_SLOT = 'live_presenter_grants_one_open_per_session';

/*
 * The partial unique indexes' predicates, unqualified — as an ON CONFLICT
 * clause names them to infer its arbiter index.
 */
const ONE_LIVE_PER_COMMUNITY = sql`state = 'live'`;
const ONE_OPEN_PER_PERSON = sql`state in ('pending', 'granted')`;

/** An open request — pending or granted (R1) — as the one-open index states it. */
const OPEN_REQUEST = sql`${liveSpeakerRequests.state} in ('pending', 'granted')`;

/** A request that held the floor and lost it, as the watch index states it. */
const FLOOR_CLOSED = sql`${liveSpeakerRequests.grantedAt} is not null and ${liveSpeakerRequests.state} in ('revoked', 'withdrawn', 'expired')`;

const iso = (at: Date) => sql`${at.toISOString()}::timestamptz`;

/**
 * Live in Postgres: the three repository ports over one store, as the
 * in-memory twin has them — the same outcome for the same sequence of calls,
 * races included (test/support/live-contract-suite.ts runs against both).
 *
 * Every change a session sees is one transaction under the session's lock
 * (live.md §10.2), in one order:
 *
 *   1 the per-session admission mutex, before a pool connection is taken,
 *     so a hand storm queues in memory holding at most one connection
 *   2 the session row, FOR UPDATE — the transaction's first statement — and
 *     `state = 'live'` required where the port says so
 *   3 the child rows: requests, then the presenter grant
 *   4 `state_version + 1`, only when something a moderator can observe
 *     changed — never for a no-op, never for the reconciler's bookkeeping
 *   5 the moderation row, only when the change happened
 *
 * Methods addressed by a request resolve its session with a plain read first
 * (a request never changes session), then take that session's lock and read
 * the request again before deciding. `start` has no row to lock: the partial
 * unique index alone decides racing starts. `markEmpty` and `noteViolation`
 * are single statements, themselves conditional on `live`. No transaction
 * spans anything but SQL: provider calls happen after commit, in the use
 * cases.
 *
 * Everything runs at READ COMMITTED. A deadlock victim — which the one lock
 * order should make impossible — is retried once, counted and logged; a
 * second is thrown, since no port has a "contended" answer.
 */
@Injectable()
export class DrizzleLiveStore {
  readonly sessions: LiveSessionRepository;
  readonly requests: SpeakerRequestRepository;
  readonly presenters: PresenterGrantRepository;
  private readonly store: LiveTransactions;

  constructor(@Inject(DATABASE) db: Database) {
    this.store = new LiveTransactions(db);
    this.sessions = new DrizzleLiveSessions(this.store);
    this.requests = new DrizzleSpeakerRequests(this.store);
    this.presenters = new DrizzlePresenterGrants(this.store);
  }

  /**
   * How many transactions were retried as deadlock victims, across the three
   * ports. The lock order should keep this zero: each retry is logged, and
   * the concurrency suite asserts it stayed zero — a retry that succeeds
   * would otherwise hide a deadlock from every outcome.
   */
  get deadlockRetries(): number {
    return this.store.retries;
  }
}

/**
 * What the three ports share — one handle, one admission mutex keyed by
 * session id, one retry count — so a session's transitions queue in one line
 * whichever port they come through.
 */
class LiveTransactions {
  private readonly logger = new Logger(DrizzleLiveStore.name);
  private readonly admission = new KeyedMutex();
  retries = 0;

  constructor(readonly db: Database) {}

  /** A transition under the session's lock: admitted, then one transaction. */
  locked<T>(sessionId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.admission.run(sessionId, () => this.transaction(work));
  }

  /** Admission alone, for a transition that may run a second transaction under it. */
  admitted<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return this.admission.run(sessionId, work);
  }

  /** One transaction, retried once as a deadlock victim. */
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(work);
    } catch (error) {
      if (postgresErrorCode(error) !== DEADLOCK) throw error;
      this.retries += 1;
      this.logger.warn({ sqlstate: DEADLOCK }, 'deadlock victim; retrying once');
    }
    return this.db.transaction(work);
  }
}

class DrizzleLiveSessions implements LiveSessionRepository {
  constructor(private readonly store: LiveTransactions) {}

  async findById(id: string): Promise<LiveSession | null> {
    const [row] = await this.store.db.select().from(liveSessions).where(eq(liveSessions.id, id));
    return row === undefined ? null : toLiveSession(row);
  }

  async findLiveByCommunity(communityId: string): Promise<LiveSession | null> {
    return liveSessionOf(this.store.db, communityId);
  }

  async start(session: LiveSession, moderation: ModerationAction): Promise<StartOutcome> {
    // No session row exists to lock, and no admission: of any number of racing
    // starts, the partial unique index lets exactly one insert (§4.1, S1).
    return this.store.transaction(async (tx) => {
      for (;;) {
        if (isLive(session)) {
          const [inserted] = await tx
            .insert(liveSessions)
            .values(liveSessionRow(session))
            .onConflictDoNothing({
              target: liveSessions.communityId,
              where: ONE_LIVE_PER_COMMUNITY,
            })
            .returning();
          if (inserted !== undefined) {
            await record(tx, moderation);
            return { created: true, session: toLiveSession(inserted) };
          }
        }
        // One already runs: nothing is written, and it is the answer. Each
        // statement reads what has committed by then, so the winner is seen.
        const running = await liveSessionOf(tx, session.communityId);
        if (running !== null) return { created: false, session: running };
        if (!isLive(session)) throw new RangeError('a start stores a live session');
        // The winner ended between the two statements: the community has no
        // live session any more, so this start tries again.
      }
    });
  }

  async end(input: EndInput): Promise<EndOutcome | null> {
    return this.store.locked(input.sessionId, async (tx) => {
      const session = await lockSession(tx, input.sessionId);
      if (session === null) return null;
      if (!isLive(session)) return { ended: false, session };
      // The domain's rule first — a moderator's end names the moderator (S2) —
      // so a refused end writes nothing.
      const ended = endSession(session, input);
      const [row] = await tx
        .update(liveSessions)
        .set({
          state: ended.state,
          stateVersion: sql`${liveSessions.stateVersion} + 1`,
          endedAt: ended.endedAt,
          endedBy: ended.endedBy,
          endReason: ended.endReason,
        })
        .where(and(eq(liveSessions.id, session.id), eq(liveSessions.state, 'live')))
        .returning();
      if (row === undefined) throw new Error(`live session ${session.id} ended while locked`);
      // Every open hand expires, by nobody — one statement however many there
      // are (S5): the one `live.session.ended` implies them all…
      await tx
        .update(liveSpeakerRequests)
        .set({ state: 'expired', decidedAt: input.at, decidedBy: null })
        .where(and(eq(liveSpeakerRequests.sessionId, session.id), OPEN_REQUEST));
      // …and the open presenter grant closes, one statement.
      await tx
        .update(livePresenterGrants)
        .set({ endedAt: input.at, endedBy: input.endedBy, endReason: 'session_ended' })
        .where(
          and(eq(livePresenterGrants.sessionId, session.id), isNull(livePresenterGrants.endedAt)),
        );
      await record(tx, input.moderation);
      return { ended: true, session: toLiveSession(row) };
    });
  }

  async listLive(after: LiveSessionKey | null, limit: number): Promise<readonly LiveSession[]> {
    requireLimit('listLive', limit, LIVE_SESSIONS_PAGE_MAX);
    const rows = await this.store.db
      .select()
      .from(liveSessions)
      .where(
        and(
          eq(liveSessions.state, 'live'),
          after === null
            ? undefined
            : sql`(${liveSessions.startedAt}, ${liveSessions.id}) > (${iso(after.startedAt)}, ${after.id})`,
        ),
      )
      .orderBy(asc(liveSessions.startedAt), asc(liveSessions.id))
      .limit(limit);
    return rows.map(toLiveSession);
  }

  async markEmpty(id: string, emptySince: Date | null): Promise<void> {
    // One statement, conditional on live. The first observation stands: a
    // date is written only where none is set, so a repeated mark never
    // restarts the idle clock — and never rewrites the row — while null
    // clears one that is.
    await this.store.db
      .update(liveSessions)
      .set({ emptySince })
      .where(
        and(
          eq(liveSessions.id, id),
          eq(liveSessions.state, 'live'),
          emptySince === null
            ? isNotNull(liveSessions.emptySince)
            : isNull(liveSessions.emptySince),
        ),
      );
  }

  async noteViolation(id: string, at: Date): Promise<number> {
    const [row] = await this.store.db
      .update(liveSessions)
      .set({
        enforcementViolations: sql`${liveSessions.enforcementViolations} + 1`,
        lastViolationAt: at,
      })
      .where(and(eq(liveSessions.id, id), eq(liveSessions.state, 'live')))
      .returning({ violations: liveSessions.enforcementViolations });
    return row?.violations ?? 0;
  }

  async bumpEpoch(
    id: string,
    expected: number,
    moderation: ModerationAction,
  ): Promise<LiveSession | null> {
    return this.store.locked(id, async (tx) => {
      const session = await lockSession(tx, id);
      if (session === null || !isLive(session) || session.mediaRoomEpoch !== expected) return null;
      // Compare-and-set on the epoch; bookkeeping, so no version step.
      const [row] = await tx
        .update(liveSessions)
        .set({ mediaRoomEpoch: expected + 1 })
        .where(
          and(
            eq(liveSessions.id, id),
            eq(liveSessions.state, 'live'),
            eq(liveSessions.mediaRoomEpoch, expected),
          ),
        )
        .returning();
      if (row === undefined) return null;
      await record(tx, moderation);
      return toLiveSession(row);
    });
  }
}

class DrizzleSpeakerRequests implements SpeakerRequestRepository {
  constructor(private readonly store: LiveTransactions) {}

  async raise(request: SpeakerRequest): Promise<RaiseOutcome> {
    return this.store.locked(request.sessionId, async (tx) => {
      const session = await lockSession(tx, request.sessionId);
      if (session === null || !isLive(session)) return 'session_not_live';
      if (request.state === 'pending') {
        const [inserted] = await tx
          .insert(liveSpeakerRequests)
          .values(speakerRequestRow(request))
          .onConflictDoNothing({
            target: [liveSpeakerRequests.sessionId, liveSpeakerRequests.userId],
            where: ONE_OPEN_PER_PERSON,
          })
          .returning();
        if (inserted !== undefined) {
          const stateVersion = await stepVersion(tx, session.id);
          return { created: true, request: toSpeakerRequest(inserted), stateVersion };
        }
      }
      // The person's open request stands, and nothing is written (R1).
      const open = await openRequestOf(tx, request.sessionId, request.userId);
      if (open !== null) {
        return { created: false, request: open, stateVersion: session.stateVersion };
      }
      if (request.state !== 'pending') throw new RangeError('a raise stores a pending request');
      throw new Error(`an open request in live session ${session.id} closed while locked`);
    });
  }

  async findById(id: string): Promise<SpeakerRequest | null> {
    return requestOf(this.store.db, id);
  }

  async findOpen(sessionId: string, userId: string): Promise<SpeakerRequest | null> {
    return openRequestOf(this.store.db, sessionId, userId);
  }

  async granted(sessionId: string): Promise<readonly SpeakerRequest[]> {
    const rows = await this.store.db
      .select()
      .from(liveSpeakerRequests)
      .where(
        and(eq(liveSpeakerRequests.sessionId, sessionId), eq(liveSpeakerRequests.state, 'granted')),
      )
      .orderBy(asc(liveSpeakerRequests.requestedAt), asc(liveSpeakerRequests.id));
    return rows.map(toSpeakerRequest);
  }

  async pendingPage(
    sessionId: string,
    after: QueueKey | null,
    limit: number,
  ): Promise<readonly SpeakerRequest[]> {
    requireLimit('pendingPage', limit, HANDS_PAGE_MAX);
    const rows = await this.store.db
      .select()
      .from(liveSpeakerRequests)
      .where(
        and(
          eq(liveSpeakerRequests.sessionId, sessionId),
          eq(liveSpeakerRequests.state, 'pending'),
          after === null
            ? undefined
            : sql`(${liveSpeakerRequests.requestedAt}, ${liveSpeakerRequests.id}) > (${iso(after.requestedAt)}, ${after.id})`,
        ),
      )
      .orderBy(asc(liveSpeakerRequests.requestedAt), asc(liveSpeakerRequests.id))
      .limit(limit);
    return rows.map(toSpeakerRequest);
  }

  async countPending(sessionId: string, cap: number): Promise<number> {
    requireLimit('countPending', cap, PENDING_HANDS_COUNT_CAP);
    // Never more than `cap` rows read, however long the queue (audit D8).
    const result = await this.store.db.execute(sql`
      select count(*)::int as count from (
        select 1 from ${liveSpeakerRequests}
        where ${liveSpeakerRequests.sessionId} = ${sessionId}
          and ${liveSpeakerRequests.state} = 'pending'
        limit ${cap}
      ) capped
    `);
    return Number((result.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
  }

  async grantWithinCap(input: {
    readonly requestId: string;
    readonly cap: number;
    readonly at: Date;
    readonly by: string;
    readonly moderation: ModerationAction;
  }): Promise<GrantOutcome | null> {
    const sessionId = await this.sessionOf(input.requestId);
    if (sessionId === null) return null;
    return this.store.locked(sessionId, async (tx) => {
      const { session, request } = await lockedRequest(tx, sessionId, input.requestId);
      const answer = (kind: GrantOutcome['kind']): GrantOutcome => ({
        kind,
        request,
        stateVersion: session.stateVersion,
      });
      if (request.state === 'granted') return answer('unchanged');
      if (!isLive(session)) return answer('session_not_live');
      if (request.state !== 'pending') return answer('invalid');
      // The cap, counted under the session's lock, in the grant's own
      // transaction (R2): a racing grant waits on the lock, then counts this one.
      // Never more than `cap` rows are read: a request path counts nothing
      // unbounded (audit §15).
      const held = tx
        .select({ one: sql<number>`1`.as('one') })
        .from(liveSpeakerRequests)
        .where(
          and(
            eq(liveSpeakerRequests.sessionId, sessionId),
            eq(liveSpeakerRequests.state, 'granted'),
          ),
        )
        .limit(input.cap)
        .as('held');
      const [floor] = await tx.select({ granted: sql<number>`count(*)::int` }).from(held);
      if ((floor?.granted ?? 0) >= input.cap) return answer('slots_full');
      const granted = transition(request, 'granted', input.at, input.by);
      if (granted === null) return answer('invalid');
      // Compare-and-set: still pending. The floor was given when it was decided.
      const [row] = await tx
        .update(liveSpeakerRequests)
        .set({
          state: granted.state,
          grantedAt: granted.grantedAt,
          decidedAt: granted.decidedAt,
          decidedBy: granted.decidedBy,
        })
        .where(
          and(
            eq(liveSpeakerRequests.id, input.requestId),
            eq(liveSpeakerRequests.state, 'pending'),
          ),
        )
        .returning();
      if (row === undefined) {
        throw new Error(`speaker request ${input.requestId} changed while its session was locked`);
      }
      const stateVersion = await stepVersion(tx, sessionId);
      await record(tx, input.moderation);
      return { kind: 'granted', request: toSpeakerRequest(row), stateVersion };
    });
  }

  async transition(input: TransitionInput): Promise<TransitionOutcome | null> {
    if (input.to === 'pending' || input.to === 'granted') {
      throw new RangeError(`a transition never moves a request to ${input.to}`);
    }
    if ((input.to === 'expired') !== (input.by === null)) {
      throw new RangeError('a request is decided by a person, except an expiry');
    }
    const sessionId = await this.sessionOf(input.requestId);
    if (sessionId === null) return null;
    return this.store.locked(sessionId, async (tx) => {
      const { session, request } = await lockedRequest(tx, sessionId, input.requestId);
      const answer = (kind: TransitionOutcome['kind']): TransitionOutcome => ({
        kind,
        request,
        stateVersion: session.stateVersion,
      });
      // A repeat is a repeat, even after the end (audit D6).
      if (request.state === input.to) return answer('unchanged');
      if (!isLive(session)) return answer('session_not_live');
      if (
        !input.from.includes(request.state) ||
        judgeTransition(request.state, input.to) !== 'apply'
      ) {
        return answer('invalid');
      }
      const moved = transition(request, input.to, input.at, input.by);
      if (moved === null) return answer('invalid');
      // Compare-and-set: from one of the states the caller named, and only those.
      const [row] = await tx
        .update(liveSpeakerRequests)
        .set({ state: moved.state, decidedAt: moved.decidedAt, decidedBy: moved.decidedBy })
        .where(
          and(
            eq(liveSpeakerRequests.id, input.requestId),
            sql`${liveSpeakerRequests.state} = any(${sql.param([...input.from])}::text[])`,
          ),
        )
        .returning();
      if (row === undefined) {
        throw new Error(`speaker request ${input.requestId} changed while its session was locked`);
      }
      const stateVersion = await stepVersion(tx, sessionId);
      if (input.moderation !== null) await record(tx, input.moderation);
      return { kind: 'applied', request: toSpeakerRequest(row), stateVersion };
    });
  }

  async expireIneligible(sessionId: string, userId: string, at: Date): Promise<IneligibleExpiry> {
    return this.store.locked(sessionId, async (tx) => {
      const session = await lockSession(tx, sessionId);
      if (session === null) return { request: null, presenter: null, stateVersion: 0 };
      const nothing = { request: null, presenter: null, stateVersion: session.stateVersion };
      // End has already closed everything in a session that is not live.
      if (!isLive(session)) return nothing;
      const [expired] = await tx
        .update(liveSpeakerRequests)
        .set({ state: 'expired', decidedAt: at, decidedBy: null })
        .where(
          and(
            eq(liveSpeakerRequests.sessionId, sessionId),
            eq(liveSpeakerRequests.userId, userId),
            OPEN_REQUEST,
          ),
        )
        .returning();
      const [closed] = await tx
        .update(livePresenterGrants)
        .set({ endedAt: at, endedBy: null, endReason: 'ineligible' })
        .where(
          and(
            eq(livePresenterGrants.sessionId, sessionId),
            eq(livePresenterGrants.userId, userId),
            isNull(livePresenterGrants.endedAt),
          ),
        )
        .returning();
      if (expired === undefined && closed === undefined) return nothing;
      const stateVersion = await stepVersion(tx, sessionId);
      return {
        request: expired === undefined ? null : toSpeakerRequest(expired),
        presenter: closed === undefined ? null : toPresenterGrant(closed),
        stateVersion,
      };
    });
  }

  async floorClosedSince(sessionId: string, since: Date): Promise<readonly string[]> {
    const rows = await this.store.db
      .selectDistinct({ userId: liveSpeakerRequests.userId })
      .from(liveSpeakerRequests)
      .where(
        and(
          eq(liveSpeakerRequests.sessionId, sessionId),
          FLOOR_CLOSED,
          gte(liveSpeakerRequests.decidedAt, since),
        ),
      )
      .orderBy(asc(liveSpeakerRequests.userId));
    return rows.map((row) => row.userId);
  }

  /** The session a request belongs to — which never changes — by a plain read; null if unknown. */
  private async sessionOf(requestId: string): Promise<string | null> {
    const [row] = await this.store.db
      .select({ sessionId: liveSpeakerRequests.sessionId })
      .from(liveSpeakerRequests)
      .where(eq(liveSpeakerRequests.id, requestId));
    return row?.sessionId ?? null;
  }
}

class DrizzlePresenterGrants implements PresenterGrantRepository {
  constructor(private readonly store: LiveTransactions) {}

  async active(sessionId: string): Promise<PresenterGrant | null> {
    return openGrantOf(this.store.db, sessionId);
  }

  async open(grant: PresenterGrant, moderation: ModerationAction): Promise<PresenterOpenOutcome> {
    return this.store.admitted(grant.sessionId, async () => {
      try {
        return await this.store.transaction((tx) => claim(tx, grant, moderation));
      } catch (error) {
        if (!isUniqueViolation(error, PRESENTER_SLOT)) throw error;
        // The backstop held: a writer that bypassed the session's lock took
        // the slot between this claim's read and its insert. The transaction
        // rolled back, writing nothing; the claim is decided again, and the
        // slot's holder now answers it — held or occupied.
        return this.store.transaction((tx) => claim(tx, grant, moderation));
      }
    });
  }

  async close(input: PresenterCloseInput): Promise<PresenterCloseOutcome> {
    return this.store.locked(input.sessionId, async (tx) => {
      const session = await lockSession(tx, input.sessionId);
      if (session === null) return { grant: null, stateVersion: 0 };
      // End has already closed it in a session that is not live.
      if (!isLive(session)) return { grant: null, stateVersion: session.stateVersion };
      // Only the grant of the holder the caller decided about: if the slot has
      // passed to someone else, nothing closes.
      const [closed] = await tx
        .update(livePresenterGrants)
        .set({ endedAt: input.at, endedBy: input.by, endReason: input.reason })
        .where(
          and(
            eq(livePresenterGrants.sessionId, input.sessionId),
            eq(livePresenterGrants.userId, input.userId),
            isNull(livePresenterGrants.endedAt),
          ),
        )
        .returning();
      if (closed === undefined) return { grant: null, stateVersion: session.stateVersion };
      const stateVersion = await stepVersion(tx, input.sessionId);
      if (input.moderation !== null) await record(tx, input.moderation);
      return { grant: toPresenterGrant(closed), stateVersion };
    });
  }

  async closedSince(sessionId: string, since: Date): Promise<readonly string[]> {
    const rows = await this.store.db
      .selectDistinct({ userId: livePresenterGrants.userId })
      .from(livePresenterGrants)
      .where(
        and(eq(livePresenterGrants.sessionId, sessionId), gte(livePresenterGrants.endedAt, since)),
      )
      .orderBy(asc(livePresenterGrants.userId));
    return rows.map((row) => row.userId);
  }
}

/** Claims the presenter slot, in a transaction under the session's lock. */
async function claim(
  tx: Transaction,
  grant: PresenterGrant,
  moderation: ModerationAction,
): Promise<PresenterOpenOutcome> {
  const session = await lockSession(tx, grant.sessionId);
  if (session === null) return { kind: 'session_not_live', grant: null, stateVersion: 0 };
  if (!isLive(session)) {
    return { kind: 'session_not_live', grant: null, stateVersion: session.stateVersion };
  }
  // The open grant is read under the lock first, so a repeat by the holder
  // and a rival are told apart — which a unique violation cannot do.
  const holding = await openGrantOf(tx, grant.sessionId);
  if (holding !== null) {
    return {
      kind: holding.userId === grant.userId ? 'held' : 'occupied',
      grant: holding,
      stateVersion: session.stateVersion,
    };
  }
  if (!isOpenGrant(grant)) throw new RangeError('a claim stores an open grant');
  const [row] = await tx.insert(livePresenterGrants).values(presenterGrantRow(grant)).returning();
  if (row === undefined) throw new Error(`presenter grant ${grant.id} was not stored`);
  const stateVersion = await stepVersion(tx, grant.sessionId);
  await record(tx, moderation);
  return { kind: 'opened', grant: toPresenterGrant(row), stateVersion };
}

/**
 * The first statement of every locked transition: the session row, FOR
 * UPDATE. Everything the transition decides about the session is decided on
 * this read.
 */
async function lockSession(tx: Transaction, id: string): Promise<LiveSession | null> {
  const [row] = await tx.select().from(liveSessions).where(eq(liveSessions.id, id)).for('update');
  return row === undefined ? null : toLiveSession(row);
}

/**
 * A request-addressed transition's reads: the session locked, then the
 * request read again under that lock. Both exist — nothing is deleted, and
 * the foreign key keeps a request's session.
 */
async function lockedRequest(
  tx: Transaction,
  sessionId: string,
  requestId: string,
): Promise<{ readonly session: LiveSession; readonly request: SpeakerRequest }> {
  const session = await lockSession(tx, sessionId);
  if (session === null) throw new Error('a speaker request without its session');
  const request = await requestOf(tx, requestId);
  if (request === null) throw new Error(`speaker request ${requestId} vanished`);
  return { session, request };
}

/** The community's live session, if one runs — at most one does (S1). */
async function liveSessionOf(db: Reader, communityId: string): Promise<LiveSession | null> {
  const [row] = await db
    .select()
    .from(liveSessions)
    .where(and(eq(liveSessions.communityId, communityId), eq(liveSessions.state, 'live')));
  return row === undefined ? null : toLiveSession(row);
}

async function requestOf(db: Reader, id: string): Promise<SpeakerRequest | null> {
  const [row] = await db.select().from(liveSpeakerRequests).where(eq(liveSpeakerRequests.id, id));
  return row === undefined ? null : toSpeakerRequest(row);
}

/** The person's open request in the session, if any — at most one is (R1). */
async function openRequestOf(
  db: Reader,
  sessionId: string,
  userId: string,
): Promise<SpeakerRequest | null> {
  const [row] = await db
    .select()
    .from(liveSpeakerRequests)
    .where(
      and(
        eq(liveSpeakerRequests.sessionId, sessionId),
        eq(liveSpeakerRequests.userId, userId),
        OPEN_REQUEST,
      ),
    );
  return row === undefined ? null : toSpeakerRequest(row);
}

/** The session's open presenter grant, if any — at most one is (P1). */
async function openGrantOf(db: Reader, sessionId: string): Promise<PresenterGrant | null> {
  const [row] = await db
    .select()
    .from(livePresenterGrants)
    .where(and(eq(livePresenterGrants.sessionId, sessionId), isNull(livePresenterGrants.endedAt)));
  return row === undefined ? null : toPresenterGrant(row);
}

/**
 * One version later (§4.5): the step every change a moderator can observe
 * takes, in its own transaction, on the session it has locked and found live.
 */
async function stepVersion(tx: Transaction, sessionId: string): Promise<number> {
  const [row] = await tx
    .update(liveSessions)
    .set({ stateVersion: sql`${liveSessions.stateVersion} + 1` })
    .where(and(eq(liveSessions.id, sessionId), eq(liveSessions.state, 'live')))
    .returning({ stateVersion: liveSessions.stateVersion });
  if (row === undefined) throw new Error(`live session ${sessionId} ended while locked`);
  return row.stateVersion;
}

/** The moderation record, written by the transaction that makes the change it records. */
async function record(tx: Transaction, action: ModerationAction): Promise<void> {
  await tx.insert(liveModerationActions).values(moderationActionRow(action));
}

function requireLimit(method: string, limit: number, max: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new RangeError(`${method} takes a whole number from 1 to ${max}`);
  }
}
