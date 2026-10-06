import {
  FixedClock,
  asId,
  err,
  failure,
  ok,
  type AuditEntry,
  type AuditLog,
  type DomainEvent,
  type EventPublisher,
  type Id,
  type IdGenerator,
  type Principal,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimiter,
  type Result,
} from '../../../shared';
import {
  type CommunityAuthorization,
  type CommunityPermit,
} from '../../communities/contracts/authorization';
import { COMMUNITY_RESOURCE, type CommunityAct } from '../../communities/contracts/capabilities';
import type { LiveSessionScope, LiveSessions } from '../../live/contracts/live-sessions';
import type { LivePresence, PresenceObservation } from '../../live/contracts/presence';
import type {
  AttendanceSnapshotRepository,
  SnapshotIdempotencyKey,
  SnapshotInsertOutcome,
} from '../domain/ports';
import { CLIENT_REQUEST_ID_INVALID } from '../domain/snapshot';
import type {
  AttendanceSnapshot,
  AttendanceSnapshotHeader,
  SnapshotEntry,
} from '../domain/snapshot';
import { AttendanceAccess } from './attendance-access';
import { AttendanceJournal } from './attendance-journal';
import { ATTENDANCE_SNAPSHOT_POLICY } from './attendance-policy';
import { AttendanceRefusals } from './attendance-settings';
import { RecordAttendanceSnapshotUseCase } from './record-attendance-snapshot.use-case';

const SESSION = 's-1';
const COMMUNITY = 'c-1';
const HOST = 'host-1';
const REC = 'rec-1';
const KEY = 'req_ABCDEFGH';

const CAPABILITY_REQUIRED: Result<CommunityPermit> = err(
  failure('forbidden', 'communities.capability_required', 'no capability'),
);

function grantPermit(act: CommunityAct): CommunityPermit {
  return {
    principalUserId: REC,
    communityId: COMMUNITY,
    scope: COMMUNITY_RESOURCE,
    act,
    basis: 'owner',
    membership: { membershipId: 'm-1', joinedAt: new Date(0), version: 1 },
    grantId: null,
    ceiling: ['communities.moderate'],
  };
}

const OBSERVED: PresenceObservation = {
  kind: 'observed',
  liveSessionId: SESSION,
  communityId: COMMUNITY,
  observationStartedAt: new Date(1_000),
  observedAt: new Date(2_000),
  participants: [
    { userId: 'u-1', connection: 'connected' },
    { userId: 'u-2', connection: 'connecting' },
  ],
};

function header(id: string): AttendanceSnapshotHeader {
  return {
    id: asId<'AttendanceSnapshot'>(id),
    communityId: COMMUNITY,
    liveSessionId: SESSION,
    hostUserId: HOST,
    recordedBy: REC,
    clientRequestId: KEY,
    observationRule: 'provider_registry_v1',
    observationStartedAt: new Date(1_000),
    observedAt: new Date(2_000),
    recordedAt: new Date(2_000),
    connectedCount: 0,
    connectingCount: 0,
  };
}

class FakeAuth implements CommunityAuthorization {
  calls = 0;
  answer: (act: CommunityAct) => Result<CommunityPermit> = (act) =>
    act === 'community.attendance.record' ? ok(grantPermit(act)) : CAPABILITY_REQUIRED;

  authorize(_p: Principal, _c: string, act: CommunityAct): Promise<Result<CommunityPermit>> {
    this.calls += 1;
    return Promise.resolve(this.answer(act));
  }
  authorizeEach(): never {
    throw new Error('unused');
  }
  permittedAmong(): never {
    throw new Error('unused');
  }
}

class FakeLiveSessions implements LiveSessions {
  calls = 0;
  scope: LiveSessionScope | null = {
    liveSessionId: SESSION,
    communityId: COMMUNITY,
    hostUserId: HOST,
    active: true,
  };
  describe(): Promise<LiveSessionScope | null> {
    this.calls += 1;
    return Promise.resolve(this.scope);
  }
}

class FakeLivePresence implements LivePresence {
  calls = 0;
  result: PresenceObservation = OBSERVED;
  observe(): Promise<PresenceObservation> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

class FakeRateLimiter implements RateLimiter {
  readonly calls: Array<{ key: string; policy: RateLimitPolicy }> = [];
  decision: RateLimitDecision = { allowed: true, remaining: 5, retryAfterSeconds: 0 };
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    this.calls.push({ key, policy });
    return Promise.resolve(this.decision);
  }
  reset(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeRepo implements AttendanceSnapshotRepository {
  readonly stored = new Map<string, AttendanceSnapshotHeader>();
  readonly inserted: AttendanceSnapshot[] = [];
  insertOutcome: SnapshotInsertOutcome = 'created';
  /** A snapshot that "committed" concurrently: findByKey finds it after a duplicate insert. */
  duplicateWinner: AttendanceSnapshotHeader | null = null;

  private keyOf(key: SnapshotIdempotencyKey): string {
    return `${key.liveSessionId}|${key.recordedBy}|${key.clientRequestId}`;
  }

  findByKey(key: SnapshotIdempotencyKey): Promise<AttendanceSnapshotHeader | null> {
    return Promise.resolve(this.stored.get(this.keyOf(key)) ?? null);
  }

  insert(snapshot: AttendanceSnapshot): Promise<SnapshotInsertOutcome> {
    this.inserted.push(snapshot);
    const key = this.keyOf(snapshot);
    if (this.insertOutcome === 'created') this.stored.set(key, snapshot);
    else if (this.duplicateWinner !== null) this.stored.set(key, this.duplicateWinner);
    return Promise.resolve(this.insertOutcome);
  }

  findById(): never {
    throw new Error('unused');
  }
  recordedOrHostedInSession(): never {
    throw new Error('unused');
  }
  listByCommunity(): never {
    throw new Error('unused');
  }
  entries(): never {
    throw new Error('unused');
  }
}

class FakeAudit implements AuditLog {
  readonly entries: AuditEntry[] = [];
  constructor(private readonly order: string[]) {}
  record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    this.order.push('audit');
    return Promise.resolve();
  }
}

class FakeEvents implements EventPublisher {
  readonly published: DomainEvent[] = [];
  constructor(private readonly order: string[]) {}
  publish(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events);
    this.order.push('event');
    return Promise.resolve();
  }
}

class FakeIds implements IdGenerator {
  next<TBrand extends string>(): Id<TBrand> {
    return asId<TBrand>('snap-1');
  }
}

function harness() {
  const auth = new FakeAuth();
  const repo = new FakeRepo();
  const liveSessions = new FakeLiveSessions();
  const presence = new FakeLivePresence();
  const rateLimiter = new FakeRateLimiter();
  const order: string[] = [];
  const audit = new FakeAudit(order);
  const events = new FakeEvents(order);
  const journal = new AttendanceJournal(audit, events);
  const useCase = new RecordAttendanceSnapshotUseCase(
    new AttendanceAccess(auth),
    repo,
    liveSessions,
    presence,
    rateLimiter,
    journal,
    new FixedClock(new Date(5_000)),
    new FakeIds(),
  );
  return { useCase, auth, repo, liveSessions, presence, rateLimiter, audit, events, order };
}

const principal: Principal = { userId: REC, roles: [], permissions: new Set() };
const command = {
  principal,
  meta: { correlationId: 'corr-1' },
  liveSessionId: SESSION,
  clientRequestId: KEY,
};

describe('RecordAttendanceSnapshotUseCase (attendance.md §18 S1/S2/S3)', () => {
  describe('happy path', () => {
    it('authorizes, observes, builds, persists, then audits before publishing', async () => {
      const h = harness();
      const result = await h.useCase.execute(command);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.created).toBe(true);
      expect(result.value.snapshot).toMatchObject({
        id: 'snap-1',
        communityId: COMMUNITY,
        liveSessionId: SESSION,
        connectedCount: 1,
        connectingCount: 1,
      });

      expect(h.presence.calls).toBe(1);
      expect(h.repo.inserted).toHaveLength(1);
      expect(h.repo.inserted[0]?.entries).toEqual<readonly SnapshotEntry[]>([
        { userId: 'u-1', connection: 'CONNECTED' },
        { userId: 'u-2', connection: 'CONNECTING' },
      ]);
      expect(h.order).toEqual(['audit', 'event']);
    });

    it('audits the created snapshot with the permit it ran on, and no participant data', async () => {
      const h = harness();
      await h.useCase.execute(command);

      expect(h.audit.entries).toHaveLength(1);
      expect(h.audit.entries[0]).toEqual({
        actorUserId: REC,
        action: 'attendance.snapshot.recorded',
        resourceType: 'attendance.snapshot',
        resourceId: 'snap-1',
        at: new Date(5_000),
        metadata: {
          communityId: COMMUNITY,
          liveSessionId: SESSION,
          connectedCount: 1,
          connectingCount: 1,
          observationRule: 'provider_registry_v1',
          authority: {
            act: 'community.attendance.record',
            basis: 'owner',
            membershipId: 'm-1',
            grantId: null,
            ceiling: ['communities.moderate'],
          },
        },
        correlationId: 'corr-1',
      });
      expect(JSON.stringify(h.audit.entries[0])).not.toContain('u-1');
      expect(JSON.stringify(h.audit.entries[0])).not.toContain('u-2');
    });

    it('charges the rate limiter once, per recorder, under the attendance policy', async () => {
      const h = harness();
      await h.useCase.execute(command);
      expect(h.rateLimiter.calls).toEqual([{ key: REC, policy: ATTENDANCE_SNAPSHOT_POLICY }]);
    });
  });

  describe('the event', () => {
    it('is attendance.snapshot.recorded, keyed on the session, with ids and counts only', async () => {
      const h = harness();
      await h.useCase.execute(command);

      expect(h.events.published).toHaveLength(1);
      expect(h.events.published[0]).toEqual({
        name: 'attendance.snapshot.recorded',
        aggregateId: SESSION,
        occurredAt: new Date(5_000),
        correlationId: 'corr-1',
        payload: {
          snapshotId: 'snap-1',
          communityId: COMMUNITY,
          liveSessionId: SESSION,
          recordedBy: REC,
          observedAt: new Date(2_000).toISOString(),
          connectedCount: 1,
          connectingCount: 1,
        },
      });
      const text = JSON.stringify(h.events.published[0]);
      expect(text).not.toContain('u-1');
      expect(text).not.toContain('u-2');
    });
  });

  describe('authorization', () => {
    it('answers 404 session_not_found for an unknown session, with no observe or charge', async () => {
      const h = harness();
      h.liveSessions.scope = null;
      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error).toBe(AttendanceRefusals.sessionNotFound);
      expect(h.presence.calls).toBe(0);
      expect(h.rateLimiter.calls).toHaveLength(0);
    });

    it('propagates AttendanceAccess’s refusal (403 not_allowed), with no observe or charge', async () => {
      const h = harness();
      h.auth.answer = () => CAPABILITY_REQUIRED; // a member with no record basis
      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error).toBe(AttendanceRefusals.notAllowed);
      expect(h.presence.calls).toBe(0);
      expect(h.rateLimiter.calls).toHaveLength(0);
    });
  });

  describe('idempotency', () => {
    it('returns the stored snapshot on a sequential replay — no observe, charge, audit or event', async () => {
      const h = harness();
      const stored = header('prior-1');
      h.repo.stored.set(`${SESSION}|${REC}|${KEY}`, stored);

      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value).toEqual({ created: false, snapshot: stored });
      expect(h.presence.calls).toBe(0);
      expect(h.rateLimiter.calls).toHaveLength(0);
      expect(h.repo.inserted).toHaveLength(0);
      expect(h.order).toEqual([]);
    });

    it('on a concurrent same-key race, returns the winner — one insert, no audit or event', async () => {
      const h = harness();
      const winner = header('winner-1');
      h.repo.insertOutcome = 'duplicate';
      h.repo.duplicateWinner = winner;

      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value).toEqual({ created: false, snapshot: winner });
      expect(h.presence.calls).toBe(1); // it did observe before losing the race
      expect(h.repo.inserted).toHaveLength(1);
      expect(h.order).toEqual([]); // nothing audited or published
    });
  });

  describe('presence states', () => {
    it('maps not_active to 412 session_not_live', async () => {
      const h = harness();
      h.presence.result = { kind: 'not_active' };
      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('attendance.session_not_live');
      expect(result.error.kind).toBe('precondition_failed');
      expect(h.repo.inserted).toHaveLength(0);
    });

    it('maps unavailable to 503 observation_unavailable, with nothing stored but still charged', async () => {
      const h = harness();
      h.presence.result = { kind: 'unavailable' };
      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('attendance.observation_unavailable');
      expect(result.error.kind).toBe('unavailable');
      expect(h.repo.inserted).toHaveLength(0);
      expect(h.rateLimiter.calls).toHaveLength(1); // charged before the failed observation
    });

    it('maps not_found to 404 session_not_found', async () => {
      const h = harness();
      h.presence.result = { kind: 'not_found' };
      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error).toBe(AttendanceRefusals.sessionNotFound);
      expect(h.repo.inserted).toHaveLength(0);
    });
  });

  describe('integrity and the pre-observe live check', () => {
    it('faults (throws) on a community mismatch, storing nothing', async () => {
      const h = harness();
      h.presence.result = { ...OBSERVED, communityId: 'other-community' };
      await expect(h.useCase.execute(command)).rejects.toThrow();
      expect(h.repo.inserted).toHaveLength(0);
      expect(h.order).toEqual([]);
    });

    it('refuses a session that is already not live (412), before any charge or observe', async () => {
      const h = harness();
      h.liveSessions.scope = {
        liveSessionId: SESSION,
        communityId: COMMUNITY,
        hostUserId: HOST,
        active: false,
      };
      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('attendance.session_not_live');
      expect(h.rateLimiter.calls).toHaveLength(0);
      expect(h.presence.calls).toBe(0);
    });
  });

  describe('rate limit', () => {
    it('answers 429 too_many_snapshots with retryAfterSeconds, without observing', async () => {
      const h = harness();
      h.rateLimiter.decision = { allowed: false, remaining: 0, retryAfterSeconds: 42 };
      const result = await h.useCase.execute(command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('attendance.too_many_snapshots');
      expect(result.error.kind).toBe('rate_limited');
      expect(result.error.details).toEqual({ retryAfterSeconds: 42 });
      expect(h.presence.calls).toBe(0);
    });
  });

  describe('no cache', () => {
    it('observes afresh for each distinct call', async () => {
      const h = harness();
      await h.useCase.execute({ ...command, clientRequestId: 'req_AAAAAAAA' });
      await h.useCase.execute({ ...command, clientRequestId: 'req_BBBBBBBB' });
      expect(h.presence.calls).toBe(2);
      expect(h.repo.inserted).toHaveLength(2);
    });
  });

  describe('client request id validation ordering (§18 S1 step 2)', () => {
    // A malformed clientRequestId is refused first — before the session lookup,
    // the authorization, the idempotency lookup, the rate-limit charge and the
    // observation — so none of those side effects occur.
    const malformed = ['short', 'has space', 'bad*char', 'a'.repeat(65)];

    for (const bad of malformed) {
      it(`refuses ${JSON.stringify(bad)} with 422 before any lookup, charge or observation`, async () => {
        const h = harness();
        const result = await h.useCase.execute({ ...command, clientRequestId: bad });

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected refusal');
        expect(result.error).toBe(CLIENT_REQUEST_ID_INVALID);
        expect(result.error.code).toBe('attendance.client_request_id_invalid');
        expect(result.error.kind).toBe('validation');

        // Nothing downstream ran: no session lookup, no authorization, no
        // idempotency lookup, no rate charge, no observation, no persistence,
        // no audit and no event.
        expect(h.liveSessions.calls).toBe(0);
        expect(h.auth.calls).toBe(0);
        expect(h.rateLimiter.calls).toHaveLength(0);
        expect(h.presence.calls).toBe(0);
        expect(h.repo.inserted).toHaveLength(0);
        expect(h.order).toEqual([]);
      });
    }

    it('lets a well-formed clientRequestId through to the full S1 path', async () => {
      const h = harness();
      const result = await h.useCase.execute({ ...command, clientRequestId: 'req_AAAAAAAA' });

      expect(result.ok).toBe(true);
      expect(h.liveSessions.calls).toBe(1);
      expect(h.auth.calls).toBe(1);
      expect(h.presence.calls).toBe(1);
      expect(h.repo.inserted).toHaveLength(1);
      expect(h.order).toEqual(['audit', 'event']);
    });
  });
});
