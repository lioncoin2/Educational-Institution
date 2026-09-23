import { asId, ok, type Id, type IdGenerator, type Principal } from '../../src/shared';
import type {
  AccountDirectory,
  AccountSummary,
  AuthorizationService,
  Permission,
} from '../../src/modules/identity/contracts';
// The real decision point and the provisional rules — test-only reach into
// identity's internals, so room scoping is tested end to end.
import { PolicyAuthorizationService } from '../../src/modules/identity/application/authorization.service';
import {
  PROVISIONAL_POLICY_RULES,
  PROVISIONAL_ROLE_PERMISSIONS,
} from '../../src/modules/identity/domain/provisional-policy';
import type { KnownRoleCode } from '../../src/modules/identity/domain/role';
import { CapabilityConvergence } from '../../src/modules/live/application/capability-convergence';
import { JoinLiveSessionUseCase } from '../../src/modules/live/application/join-live-session.use-case';
import { LiveJournal } from '../../src/modules/live/application/live-journal';
import { LiveStanding } from '../../src/modules/live/application/live-standing';
import { LowerHandUseCase } from '../../src/modules/live/application/lower-hand.use-case';
import { ModerateSpeakerUseCase } from '../../src/modules/live/application/moderate-speaker.use-case';
import { RaiseHandUseCase } from '../../src/modules/live/application/raise-hand.use-case';
import type { LiveRoom, LiveSession } from '../../src/modules/live/domain/live-room';
import type { SpeakerRequest } from '../../src/modules/live/domain/speaker-request';
import { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import {
  InMemoryLiveRoomRepository,
  InMemoryLiveSessionRepository,
  InMemorySpeakerRequestRepository,
} from '../../src/modules/live/infrastructure/in-memory-live-repositories';
import { AdjustableClock, RecordingAuditLog, RecordingEvents } from './identity-harness';

export const HOST = 'teacher-1';
export const SESSION = 'session-1';
export const ROOM = 'room-1';

export class CountingIdGenerator implements IdGenerator {
  private n = 0;
  next<TBrand extends string>(): Id<TBrand> {
    this.n += 1;
    return asId<TBrand>(`generated-${this.n}`);
  }
}

/**
 * The account directory as live sees it: names, and identity's answer to
 * "may this account speak?". Unknown ids are absent, as in production.
 */
export class StubDirectory implements AccountDirectory {
  readonly names = new Map<string, string>([
    [HOST, 'الأستاذة عائشة'],
    ['student-1', 'مريم'],
    ['student-2', 'زينب'],
  ]);
  /** Accounts that may speak (hold live.speak), as identity would answer. */
  readonly speakers = new Set<string>([HOST]);

  async describe(userIds: readonly string[]): Promise<readonly AccountSummary[]> {
    return userIds.flatMap((userId) => {
      const displayName = this.names.get(userId);
      return displayName === undefined ? [] : [{ userId, displayName, active: true }];
    });
  }

  async withPermission(
    userIds: readonly string[],
    permission: Permission,
  ): Promise<ReadonlySet<string>> {
    return new Set(
      userIds.filter((userId) => permission !== 'live.speak' || this.speakers.has(userId)),
    );
  }
}

export const allowAll: AuthorizationService = {
  can: () => true,
  authorize: () => ok(undefined),
};

/** identity's real authorization service, with its provisional rules. */
export const identityPolicy = (): AuthorizationService =>
  new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);

export function principalOf(userId: string, role: KnownRoleCode): Principal {
  return {
    userId,
    roles: [role],
    permissions: new Set<string>(PROVISIONAL_ROLE_PERMISSIONS[role]),
  };
}

export const room: LiveRoom = {
  id: asId<'LiveRoom'>(ROOM),
  halaqaId: 'halaqa-1',
  title: 'Tajweed',
  hostUserId: HOST,
  maxParticipants: 2500,
  createdAt: new Date(0),
};

export const liveSession: LiveSession = {
  id: asId<'LiveSession'>(SESSION),
  roomId: room.id,
  state: 'live',
  startedAt: new Date(0),
  endedAt: null,
};

export function pending(id: string, userId: string, requestedAt = new Date(1)): SpeakerRequest {
  return {
    id: asId<'SpeakerRequest'>(id),
    sessionId: SESSION,
    userId,
    state: 'pending',
    requestedAt,
    grantedAt: null,
    decidedAt: null,
    decidedBy: null,
  };
}

/**
 * Live, assembled exactly as the module wires it — in-memory stores, the
 * fake provider, a recording journal — with identity's real policy unless a
 * test swaps it.
 */
export function liveHarness(
  options: {
    readonly authorization?: AuthorizationService;
    readonly session?: LiveSession;
    readonly requests?: readonly SpeakerRequest[];
  } = {},
) {
  const authorization = options.authorization ?? identityPolicy();
  const clock = new AdjustableClock(new Date(1_700_000_000_000));
  const ids = new CountingIdGenerator();
  const audit = new RecordingAuditLog();
  const events = new RecordingEvents();
  const rtc = new FakeRtcProvider();
  const directory = new StubDirectory();
  const sessions = new InMemoryLiveSessionRepository([options.session ?? liveSession]);
  const rooms = new InMemoryLiveRoomRepository([room]);
  const requests = new InMemorySpeakerRequestRepository(options.requests ?? []);
  const journal = new LiveJournal(audit, events);
  const standing = new LiveStanding(authorization, directory, sessions, rooms, requests);
  const convergence = new CapabilityConvergence(standing, rtc, clock);

  return {
    clock,
    audit,
    events,
    rtc,
    directory,
    sessions,
    requests,
    convergence,
    join: new JoinLiveSessionUseCase(authorization, directory, sessions, rooms, rtc, standing),
    raise: new RaiseHandUseCase(authorization, sessions, requests, clock, ids, journal),
    lower: new LowerHandUseCase(sessions, requests, clock, convergence, journal),
    moderate: new ModerateSpeakerUseCase(
      authorization,
      requests,
      sessions,
      rooms,
      clock,
      ids,
      convergence,
      journal,
    ),
    eventNames: () => events.published.map((event) => event.name),
  };
}

export type LiveHarness = ReturnType<typeof liveHarness>;
