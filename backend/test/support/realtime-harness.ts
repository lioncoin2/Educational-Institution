import { InProcessEventBus } from '../../src/platform/events/event-bus';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { InMemoryRateLimiter } from '../../src/platform/rate-limit/in-memory-rate-limiter';
import type { DomainEvent, Principal } from '../../src/shared';
import type { KnownRoleCode } from '../../src/modules/identity/domain/role';
import { ConnectionManager } from '../../src/modules/realtime/application/connection-manager';
import { MessagingRealtimeRelay } from '../../src/modules/realtime/application/messaging-relay';
import { RealtimeSessions } from '../../src/modules/realtime/application/realtime-sessions';
import type { ClientLink } from '../../src/modules/realtime/domain/connection';
import { identityHarness } from './identity-harness';
import { messagingHarness } from './messaging-harness';
import { principalWith } from './principals';

export type Frame = Record<string, unknown> & { readonly type: string };

/** A client's end of a connection, as the application layer sees it: every frame, and the close. */
export class FakeLink implements ClientLink {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  /** False makes the link behave like a socket that died without saying so. */
  healthy = true;

  send(frame: string): boolean {
    if (this.closed !== null || !this.healthy) return false;
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
