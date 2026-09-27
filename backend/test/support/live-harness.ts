import { Logger } from '@nestjs/common';

import type { Principal, RateLimiter } from '../../src/shared';
import type { AuthorizationService } from '../../src/modules/identity/contracts';
import type { KnownRoleCode } from '../../src/modules/identity/domain/role';
import type { CommunityCapability } from '../../src/modules/communities/contracts/capabilities';
import type { CommunityStatus } from '../../src/modules/communities/contracts/vocabulary';
import { EndLiveSessionUseCase } from '../../src/modules/live/application/end-live-session.use-case';
import { GetCurrentLiveSessionUseCase } from '../../src/modules/live/application/get-current-live-session.use-case';
import { GetLiveSessionUseCase } from '../../src/modules/live/application/get-live-session.use-case';
import { JoinLiveSessionUseCase } from '../../src/modules/live/application/join-live-session.use-case';
import { ListHandsUseCase } from '../../src/modules/live/application/list-hands.use-case';
import { LiveAccess } from '../../src/modules/live/application/live-access';
import { LiveJournal } from '../../src/modules/live/application/live-journal';
import { LiveMedia } from '../../src/modules/live/application/live-media';
import { LiveMediaReadiness } from '../../src/modules/live/application/live-media-readiness';
import { LiveReconciler } from '../../src/modules/live/application/live-reconciler';
import { LiveSessionLifecycle } from '../../src/modules/live/application/live-session-lifecycle';
import type { LiveSettings } from '../../src/modules/live/application/live-settings';
import { LiveStanding } from '../../src/modules/live/application/live-standing';
import { LowerHandUseCase } from '../../src/modules/live/application/lower-hand.use-case';
import { ModerateSpeakerUseCase } from '../../src/modules/live/application/moderate-speaker.use-case';
import { PresenterUseCase } from '../../src/modules/live/application/presenter.use-case';
import { RaiseHandUseCase } from '../../src/modules/live/application/raise-hand.use-case';
import { RoomOccupancy } from '../../src/modules/live/application/room-occupancy';
import { LiveSessionViews } from '../../src/modules/live/application/session-views';
import { StartLiveSessionUseCase } from '../../src/modules/live/application/start-live-session.use-case';
import type { LiveSessionView, SpeakerRequestView } from '../../src/modules/live/application/views';
import { JOIN_TOKEN_TTL_SECONDS } from '../../src/modules/live/domain/live-limits';
import { mediaRoomName, type LiveSession } from '../../src/modules/live/domain/live-session';
import type { RtcProvider } from '../../src/modules/live/domain/rtc-provider';
import { FakeRtcProvider } from '../../src/modules/live/infrastructure/fake-rtc-provider';
import { InMemoryLiveStore } from '../../src/modules/live/infrastructure/in-memory-live-repositories';
import type { LiveStore } from '../../src/modules/live/live.module';
import { Journal, META, communitiesHarness, type CommunitiesHarness } from './communities-harness';
import { principalWith } from './principals';

export { META, codeOf } from './communities-harness';

/** The settings the module binds for the fake — a test overrides what it is about. */
export const LIVE_TEST_SETTINGS: LiveSettings = Object.freeze({
  roomNamePrefix: 'live-',
  participantCap: 300,
  moderatorReserve: 10,
  joinTokenTtlSeconds: JOIN_TOKEN_TTL_SECONDS,
});

/**
 * Live, assembled exactly as the module wires it without a database — over
 * the REAL Communities: its authorization service on its in-memory store,
 * membership, delegation and the lifecycle, all driven through Communities'
 * own use cases, and identity's real policy (with its now-empty rule list).
 * So Live is tested against Communities' actual rules, never a copy of them.
 *
 * Live's side: the in-memory repositories, the extended fake provider (and
 * its self-check, behind the provider's readiness), the Communities harness's
 * adjustable clock, sequential uuid-shaped ids and in-process rate limiter,
 * and a journal of its own that records audit entries and events in the
 * order written (Communities' own go to `communities.journal`).
 *
 * Sessions are ALWAYS started through StartLiveSession — never written into
 * a repository — so every test sees a session exactly as production makes
 * one.
 */
export function liveHarness(options: LiveHarnessOptions = {}) {
  return assemble(new InMemoryLiveStore(), options);
}

/**
 * The same assembly over another store behind Live's three ports — the
 * Drizzle store, say, for a suite on Postgres. Everything else is new.
 */
export function liveHarnessOver<S extends LiveStore>(store: S, options: LiveHarnessOptions = {}) {
  return assemble(store, options);
}

export interface LiveHarnessOptions {
  /** Identity's authorization service, for Communities and Live alike — a spy, say. */
  readonly identity?: AuthorizationService;
  /**
   * The Communities to run over — its clock, ids and directory become Live's
   * too; by default a new in-memory one, with `identity`.
   */
  readonly communities?: CommunitiesHarness;
  /** The provider the use cases get; the fake by default (the disabled provider, say). */
  readonly provider?: RtcProvider;
  /**
   * The limiter Live's use cases consume — another process's own, say, since
   * the limits are per process; the Communities harness's by default.
   */
  readonly limiter?: RateLimiter;
  readonly settings?: Partial<LiveSettings>;
}

function assemble<S extends LiveStore>(store: S, options: LiveHarnessOptions) {
  const communities = options.communities ?? communitiesHarness({ identity: options.identity });
  const { clock, ids, accounts, identity } = communities;
  const limiter = options.limiter ?? communities.limiter;
  const authorization = communities.authorization;
  const journal = new Journal();
  const rtc = new FakeRtcProvider(clock);
  const provider = options.provider ?? rtc;
  const settings: LiveSettings = { ...LIVE_TEST_SETTINGS, ...options.settings };

  const liveJournal = new LiveJournal(journal, journal);
  const access = new LiveAccess(authorization);
  const standing = new LiveStanding(
    identity,
    accounts,
    authorization,
    store.requests,
    store.presenters,
  );
  const media = new LiveMedia(provider, standing, settings, clock);
  const readiness = new LiveMediaReadiness(provider, clock);
  const occupancy = new RoomOccupancy(provider, clock);
  const views = new LiveSessionViews(access, standing, store.requests);
  const lifecycle = new LiveSessionLifecycle(
    store.sessions,
    provider,
    settings,
    clock,
    ids,
    media,
    liveJournal,
  );
  /**
   * The reconciler over the harness's stores, clock, standing and journal —
   * and `media` (the provider it reconciles; the harness's by default, the
   * disabled one, say). Its room sweep refreshes `readiness_` — the
   * harness's, Start's, by default, whichever provider it reconciles; a
   * readiness over `media` itself when a test needs that provider's own
   * self-check. Never started: a test calls its ticks itself, so no timer
   * runs unless it calls `onApplicationBootstrap`.
   */
  const reconcilerWith = (
    media_: RtcProvider = provider,
    readiness_: LiveMediaReadiness = readiness,
  ) =>
    new LiveReconciler(
      store.sessions,
      store.requests,
      store.presenters,
      media_,
      media_,
      media_,
      communities.membership,
      standing,
      media,
      occupancy,
      lifecycle,
      liveJournal,
      settings,
      clock,
      ids,
      readiness_,
    );

  const h = {
    communities,
    clock,
    ids,
    accounts,
    limiter,
    identity,
    authorization,
    journal,
    rtc,
    provider,
    store,
    sessions: store.sessions,
    requests: store.requests,
    presenters: store.presenters,
    settings,
    access,
    standing,
    media,
    readiness,
    occupancy,
    views,
    lifecycle,
    reconciler: reconcilerWith(),
    reconcilerWith,

    start: new StartLiveSessionUseCase(
      identity,
      access,
      store.sessions,
      provider,
      limiter,
      settings,
      clock,
      ids,
      views,
      liveJournal,
      readiness,
    ),
    end: new EndLiveSessionUseCase(identity, access, store.sessions, lifecycle, views),
    get: new GetLiveSessionUseCase(identity, access, store.sessions, views),
    current: new GetCurrentLiveSessionUseCase(identity, access, store.sessions, views),
    join: new JoinLiveSessionUseCase(
      identity,
      accounts,
      access,
      standing,
      occupancy,
      store.sessions,
      provider,
      provider,
      limiter,
      settings,
    ),
    raise: new RaiseHandUseCase(
      identity,
      access,
      store.sessions,
      store.requests,
      limiter,
      clock,
      ids,
      liveJournal,
    ),
    lower: new LowerHandUseCase(access, store.sessions, store.requests, clock, media, liveJournal),
    moderate: new ModerateSpeakerUseCase(
      identity,
      access,
      standing,
      store.requests,
      store.sessions,
      clock,
      ids,
      media,
      liveJournal,
    ),
    hands: new ListHandsUseCase(identity, accounts, access, store.sessions, store.requests, media),
    presenter: new PresenterUseCase(
      identity,
      access,
      store.sessions,
      store.presenters,
      clock,
      ids,
      media,
      views,
      liveJournal,
    ),

    /** A signed-in person with these roles, known to the directory by `name`. */
    person(userId: string, roles: readonly KnownRoleCode[], name = userId): Principal {
      accounts.add(userId, roles, name);
      return principalWith(userId, roles);
    },

    /**
     * A community owned by a TEACHER, with STUDENT members. Only OWNER and
     * ADMIN create communities (Q41), so an ADMIN creates it, hands it to the
     * teacher and leaves: nobody but the people named here has any standing
     * in it.
     */
    async community(
      ownerId = 'teacher-1',
      ...studentIds: string[]
    ): Promise<{
      readonly id: string;
      readonly owner: Principal;
      readonly students: readonly Principal[];
    }> {
      const admin = h.person('admin-1', ['ADMIN']);
      const id = await communities.community(admin);
      const owner = h.person(ownerId, ['TEACHER']);
      const students = studentIds.map((studentId) => h.person(studentId, ['STUDENT']));
      await communities.addPeople(admin, id, ownerId, ...studentIds);
      const transferred = await communities.transfer.execute({
        principal: admin,
        communityId: id,
        userId: ownerId,
        meta: META,
      });
      if (!transferred.ok) throw new Error(`could not transfer: ${transferred.error.code}`);
      const left = await communities.leave.execute({
        principal: admin,
        communityId: id,
        meta: META,
      });
      if (!left.ok) throw new Error(`the admin could not leave: ${left.error.code}`);
      return { id, owner, students };
    },

    /** Someone added to the community by its owner — a STUDENT unless roles say otherwise. */
    async member(
      communityId: string,
      owner: Principal,
      userId: string,
      roles: readonly KnownRoleCode[] = ['STUDENT'],
    ): Promise<Principal> {
      const principal = h.person(userId, roles);
      await communities.addPeople(owner, communityId, userId);
      return principal;
    },

    /** A TEACHER member to whom the owner delegated these capabilities. */
    async delegate(
      communityId: string,
      owner: Principal,
      userId: string,
      ...capabilities: CommunityCapability[]
    ): Promise<Principal> {
      const principal = await h.member(communityId, owner, userId, ['TEACHER']);
      await communities.delegate(owner, communityId, userId, ...capabilities);
      return principal;
    },

    /**
     * The ids of `userId`'s ACTIVE grants of these capabilities, in the order
     * named — through the grant use case, which answers a grant already held
     * as unchanged, so nothing changes.
     */
    async grantsOf(
      communityId: string,
      owner: Principal,
      userId: string,
      ...capabilities: CommunityCapability[]
    ): Promise<string[]> {
      return communities.delegate(owner, communityId, userId, ...capabilities);
    },

    async lock(communityId: string, by: Principal): Promise<void> {
      await h.setStatus(communityId, by, 'LOCKED');
    },

    async unlock(communityId: string, by: Principal): Promise<void> {
      await h.setStatus(communityId, by, 'OPEN');
    },

    async setStatus(communityId: string, by: Principal, to: 'OPEN' | 'LOCKED'): Promise<void> {
      const changed = await communities.status.execute({
        principal: by,
        communityId,
        to,
        meta: META,
      });
      if (!changed.ok) throw new Error(`could not set ${to}: ${changed.error.code}`);
    },

    /** Removes a member, as the owner would. */
    async remove(communityId: string, by: Principal, userId: string): Promise<void> {
      const removed = await communities.remove.execute({
        principal: by,
        communityId,
        userId,
        meta: META,
      });
      if (!removed.ok) throw new Error(`could not remove: ${removed.error.code}`);
    },

    /** Suspends an account: identity's directory no longer vouches for it. */
    suspend(userId: string): void {
      accounts.suspend(userId);
    },

    /** A session started through StartLiveSession, as `by` starts it. */
    async startSession(by: Principal, communityId: string): Promise<LiveSessionView> {
      const started = await h.start.execute({ principal: by, communityId, meta: META });
      if (!started.ok) throw new Error(`could not start: ${started.error.code}`);
      return started.value.session;
    },

    /** A hand raised through RaiseHand. */
    async raised(by: Principal, sessionId: string): Promise<SpeakerRequestView> {
      const raised = await h.raise.execute({ principal: by, sessionId, meta: META });
      if (!raised.ok) throw new Error(`could not raise: ${raised.error.code}`);
      return raised.value.request;
    },

    /** The session as stored now. */
    async session(sessionId: string): Promise<LiveSession> {
      const session = await store.sessions.findById(sessionId);
      if (session === null) throw new Error(`no session ${sessionId}`);
      return session;
    },

    /** A session's media room at an epoch (0 until a media reset). */
    room(sessionId: string, epoch = 0): string {
      return mediaRoomName(settings.roomNamePrefix, sessionId, epoch);
    },

    /** Live's audit actions, in order. */
    audits: () => journal.actions(),
    /** Live's event names, in order. */
    eventNames: () => journal.eventNames(),
  };
  return h;
}

export type LiveHarness = ReturnType<typeof liveHarness>;

/**
 * Makes Communities read every community as carrying a status this build
 * does not know — one a later migration added, say. Communities then closes
 * joining and raising, and keeps management open and a running session
 * going: nobody already in is ejected (Q46, `runningLiveContinues`). Live
 * never sees the status itself, only the answers — authorization's, and the
 * lifecycle effects `COMMUNITY_MEMBERSHIP.heads` reports. Undone by
 * `jest.restoreAllMocks()`.
 */
export function withUnmappedStatus(h: LiveHarness): void {
  const store = h.communities.store;
  const authorityOf = store.authorityOf.bind(store);
  const authorityOfMany = store.authorityOfMany.bind(store);
  const readModel = h.communities.readModel;
  const communities = readModel.communities.bind(readModel);
  // The status is typed as the known vocabulary; a row from a later build is not.
  const unknown = 'ARCHIVED' as string as CommunityStatus;
  jest.spyOn(store, 'authorityOf').mockImplementation(async (communityId, userId) => {
    const read = await authorityOf(communityId, userId);
    return read.community === null
      ? read
      : { ...read, community: { ...read.community, status: unknown } };
  });
  jest
    .spyOn(readModel, 'communities')
    .mockImplementation(async (ids) =>
      (await communities(ids)).map((community) => ({ ...community, status: unknown })),
    );
  jest.spyOn(store, 'authorityOfMany').mockImplementation(async (communityId, userIds) => {
    const reads = await authorityOfMany(communityId, userIds);
    return new Map(
      [...reads].map(([userId, read]) => [
        userId,
        read.community === null
          ? read
          : { ...read, community: { ...read.community, status: unknown } },
      ]),
    );
  });
}

/** One structured line, as a class logged it through Nest's `Logger`. */
export interface LoggedLine {
  readonly level: 'log' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
}

/**
 * Captures — and silences — every line any class logs through Nest's
 * `Logger` from now on: its first argument, the structured fields (a line
 * logged as bare text is kept as `{message}`). The reconciler's metrics are
 * such lines (audit D15). Undone by `jest.restoreAllMocks()`.
 */
export function captureLogs(): { readonly lines: LoggedLine[]; events(): unknown[] } {
  const lines: LoggedLine[] = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      const [message] = args;
      lines.push({
        level,
        fields:
          typeof message === 'object' && message !== null
            ? (message as Record<string, unknown>)
            : { message },
      });
    });
  }
  return { lines, events: () => lines.map((line) => line.fields.event) };
}
