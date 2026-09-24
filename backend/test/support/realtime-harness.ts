import { InProcessEventBus } from '../../src/platform/events/event-bus';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { InMemoryRateLimiter } from '../../src/platform/rate-limit/in-memory-rate-limiter';
import type { DomainEvent, Principal } from '../../src/shared';
import type { KnownRoleCode } from '../../src/modules/identity/domain/role';
import { CommunitiesRealtimeRelay } from '../../src/modules/realtime/application/communities-relay';
import { ConnectionManager } from '../../src/modules/realtime/application/connection-manager';
import { MessagingRealtimeRelay } from '../../src/modules/realtime/application/messaging-relay';
import { RealtimeSessions } from '../../src/modules/realtime/application/realtime-sessions';
import type { ClientLink } from '../../src/modules/realtime/domain/connection';
import { communitiesHarness, type CommunitiesHarness } from './communities-harness';
import { identityHarness } from './identity-harness';
import { messagingHarness } from './messaging-harness';
import { principalWith } from './principals';

export type Frame = Record<string, unknown> & { readonly type: string };

/** A client's end of a connection, as the application layer sees it: every frame, and the close. */
export class FakeLink implements ClientLink {
  readonly frames: Frame[] = [];
  /** The same frames exactly as sent — for byte-for-byte comparisons. */
  readonly raw: string[] = [];
  closed: { code: number; reason: string } | null = null;
  /** False makes the link behave like a socket that died without saying so. */
  healthy = true;

  send(frame: string): boolean {
    if (this.closed !== null || !this.healthy) return false;
    this.raw.push(frame);
    this.frames.push(JSON.parse(frame) as Frame);
    return true;
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  ofType(type: string): Frame[] {
    return this.frames.filter((frame) => frame.type === type);
  }

  last(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }
}

export interface Person {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessionId: string;
  /** The principal messaging's use cases act as — the same account. */
  readonly principal: Principal;
}

export interface Client {
  readonly connectionId: string;
  readonly link: FakeLink;
  send(frame: Record<string, unknown>): Promise<void>;
}

/**
 * Realtime's application layer on top of the REAL identity and messaging
 * application layers, wired by hand: an account signs in through identity's
 * login, its token is checked by identity's own authentication, and its
 * messages are stored and published by messaging's own use cases — through
 * an in-process bus to the relay, exactly as in the running server. Only the
 * socket is fake.
 */
export async function realtimeHarness() {
  const identity = identityHarness();
  const messaging = await messagingHarness();
  const clock = identity.clock;
  const bus = new InProcessEventBus();

  // Messaging's use cases publish to its recording publisher; forward to the bus.
  const record = messaging.events.publish.bind(messaging.events);
  messaging.events.publish = async (events: readonly DomainEvent[]) => {
    await record(events);
    await bus.publish(events);
  };

  const limiter = new InMemoryRateLimiter(clock);
  const connections = new ConnectionManager();
  const sessions = new RealtimeSessions(
    connections,
    identity.resolvePrincipal,
    identity.authorization,
    messaging.delivery,
    limiter,
    clock,
    new UuidIdGenerator(),
  );
  const relay = new MessagingRealtimeRelay(
    bus,
    messaging.recipients,
    messaging.delivery,
    connections,
  );
  relay.onModuleInit();

  let people = 0;
  const h = {
    identity,
    messaging,
    clock,
    bus,
    limiter,
    connections,
    sessions,
    relay,

    /** An ACTIVE account in identity, signed in, and known to messaging's directory. */
    async person(role: KnownRoleCode | null, displayName?: string): Promise<Person> {
      people += 1;
      const email = `person${people}@institution.test`;
      const roles = role === null ? [] : [role];
      const user = await identity.seedUser({ email, roles, displayName });
      messaging.directory.add(user.id, roles, { displayName: displayName ?? email });
      const signedIn = await identity.signIn(email);
      return {
        userId: user.id,
        email,
        accessToken: signedIn.accessToken,
        refreshToken: signedIn.refreshToken,
        sessionId: signedIn.sessionId,
        principal: principalWith(user.id, roles),
      };
    },

    /** Opens a connection and sends `auth` with this token (or none at all). */
    async connect(token?: string, remoteAddress = '203.0.113.9'): Promise<Client> {
      const link = new FakeLink();
      const connectionId = sessions.opened(link, remoteAddress);
      const client: Client = {
        connectionId,
        link,
        send: (frame) => sessions.received(connectionId, JSON.stringify(frame)),
      };
      if (token !== undefined) await client.send({ type: 'auth', token });
      return client;
    },

    /** Resolves once every event published so far has been delivered. */
    async settle(): Promise<void> {
      await relay.idle();
    },

    async cleanup(): Promise<void> {
      relay.onModuleDestroy();
      await messaging.cleanup();
    },
  };
  return h;
}

export type RealtimeHarness = Awaited<ReturnType<typeof realtimeHarness>>;

const DEVICE_AT = new Date('2026-09-24T10:00:00.000Z');
let devices = 0;

/**
 * One more device of `userId` on `connections`, registered as the sessions
 * register it once `auth` succeeds — for suites about delivery, not about
 * authentication, which ask ConnectionManager nothing else.
 */
export function connectDevice(connections: ConnectionManager, userId: string): FakeLink {
  const link = new FakeLink();
  devices += 1;
  connections.register({
    connectionId: `device-${devices}`,
    userId,
    sessionId: `session-${userId}`,
    authenticatedAt: DEVICE_AT,
    expiresAt: new Date(DEVICE_AT.getTime() + 900_000),
    validatedAt: DEVICE_AT,
    lastSeenAt: DEVICE_AT,
    remoteAddress: '203.0.113.9',
    link,
  });
  return link;
}

/**
 * CommunitiesRealtimeRelay over the REAL Communities application layer: its
 * use cases change the store and record to the journal, and the journal's
 * events go on through an in-process bus to the relay, exactly as in the
 * running server. The relay asks Communities' own membership contract, and
 * the harness's account directory (identity's answer, from the provisional
 * matrix) for the view ceiling. Only the sockets are fake: devices are
 * registered on a real ConnectionManager.
 *
 * Pass a Communities harness built over other adapters (Postgres) or shared
 * with a messaging harness; by default it is a fresh in-memory one.
 */
export function communitiesRealtimeHarness(
  options: { readonly communities?: CommunitiesHarness } = {},
) {
  const communities = options.communities ?? communitiesHarness();
  const bus = new InProcessEventBus();

  // Communities' use cases publish to the journal; forward to the bus.
  const record = communities.journal.publish.bind(communities.journal);
  communities.journal.publish = async (events: readonly DomainEvent[]) => {
    await record(events);
    await bus.publish(events);
  };

  const connections = new ConnectionManager();
  const relay = new CommunitiesRealtimeRelay(
    bus,
    communities.membership,
    communities.accounts,
    connections,
  );
  relay.onModuleInit();

  return {
    communities,
    bus,
    connections,
    relay,

    /** A connected device of this account. */
    connect(userId: string): FakeLink {
      return connectDevice(connections, userId);
    },

    /** Resolves once every event published so far has been delivered. */
    async settle(): Promise<void> {
      await relay.idle();
    },

    cleanup(): void {
      relay.onModuleDestroy();
    },
  };
}

export type CommunitiesRealtimeHarness = ReturnType<typeof communitiesRealtimeHarness>;
