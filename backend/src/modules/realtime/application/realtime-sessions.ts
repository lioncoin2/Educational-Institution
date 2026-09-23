import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  type Clock,
  type IdGenerator,
  type Principal,
  type RateLimiter,
} from '../../../shared';
import {
  ACCESS_TOKEN_AUTHENTICATOR,
  type AccessTokenAuthenticator,
} from '../../identity/contracts/access-tokens';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions } from '../../identity/contracts/permissions';
import { MESSAGE_DELIVERY, type MessageDelivery } from '../../messaging/contracts/message-delivery';
import type { ClientLink, Connection } from '../domain/connection';
import { CloseCodes, parseClientFrame, type ClientFrame } from '../domain/protocol';
import {
  CONNECTIONS_OPENED_PER_USER,
  FRAMES_PER_CONNECTION,
  RealtimeLimits,
} from '../domain/realtime-policy';
import { ConnectionManager } from './connection-manager';
import { errorFrame, pongFrame, readyFrame, subscribedFrame } from './envelopes';

interface Pending {
  readonly connectionId: string;
  readonly link: ClientLink;
  readonly remoteAddress: string;
  readonly openedAt: Date;
}

/** How many sessions are revalidated at once during a sweep. */
const REVALIDATION_CONCURRENCY = 16;

/** Short, fixed close reasons: the error frame before the close says the rest. */
const CLOSE_REASONS: Readonly<Record<number, string>> = {
  [CloseCodes.unauthorized]: 'unauthorized',
  [CloseCodes.forbidden]: 'forbidden',
  [CloseCodes.rateLimited]: 'rate limited',
};

/**
 * The protocol, one connection at a time — everything between "a socket
 * opened" and "that socket may receive events".
 *
 *   authenticate  identity's own authentication (the HTTP guard's code), then
 *                 `messaging.read` — the permission every messaging route
 *                 requires — then the per-account connection limits;
 *   re-authenticate a fresh token on the same connection, before the old one
 *                 expires; the account may not change;
 *   subscribe     messaging's own "may this person open this conversation?",
 *                 with a freshly revalidated principal; answered with the
 *                 positions a client catches up from;
 *   sweep         closes connections that missed their authentication
 *                 deadline or outlived their token, and re-checks every open
 *                 one's session, account and permission on an interval.
 *
 * It decides nothing about messaging: membership, visibility and what a
 * message looks like are all answered by messaging's contracts. It knows no
 * socket library: it talks to `ClientLink`s.
 */
@Injectable()
export class RealtimeSessions implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeSessions.name);
  private readonly pending = new Map<string, Pending>();
  /** Each connection's frames are handled one at a time, in the order they arrived. */
  private readonly queues = new Map<string, Promise<void>>();
  private sweeper: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly connections: ConnectionManager,
    @Inject(ACCESS_TOKEN_AUTHENTICATOR) private readonly authenticator: AccessTokenAuthenticator,
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(MESSAGE_DELIVERY) private readonly delivery: MessageDelivery,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  onModuleInit(): void {
    this.sweeper = setInterval(() => {
      this.sweep().catch((error: unknown) =>
        this.logger.error({ err: error }, 'realtime sweep failed'),
      );
    }, RealtimeLimits.sweepSeconds * 1000);
    // Never the reason a process stays alive (the CLI shares this module graph).
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  // ── From the transport ─────────────────────────────────────────────────

  /** A client connected. It is nobody until it authenticates. */
  opened(link: ClientLink, remoteAddress: string): string {
    const connectionId = this.ids.next<'Connection'>();
    this.pending.set(connectionId, {
      connectionId,
      link,
      remoteAddress,
      openedAt: this.clock.now(),
    });
    return connectionId;
  }

  /** One frame from a client; `null` is a binary frame. Resolves once handled. */
  received(connectionId: string, text: string | null): Promise<void> {
    const previous = this.queues.get(connectionId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(connectionId, text))
      .catch((error: unknown) => this.failed(connectionId, error));
    this.queues.set(connectionId, next);
    void next.finally(() => {
      if (this.queues.get(connectionId) === next) this.queues.delete(connectionId);
    });
    return next;
  }

  /** The transport heard from the client (a heartbeat reply). */
  heard(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection !== undefined) connection.lastSeenAt = this.clock.now();
  }

  /** The socket is gone, for whatever reason. */
  closed(connectionId: string): void {
    this.pending.delete(connectionId);
    this.connections.unregister(connectionId);
  }

  /** Connections still waiting to authenticate — for the transport's capacity check and tests. */
  pendingCount(): number {
    return this.pending.size;
  }

  // ── Frames ─────────────────────────────────────────────────────────────

  private async handle(connectionId: string, text: string | null): Promise<void> {
    const link = this.linkOf(connectionId);
    if (link === undefined) return;

    const throttle = await this.limiter.consume(connectionId, FRAMES_PER_CONNECTION);
    if (!throttle.allowed) {
      this.refuse(
        connectionId,
        link,
        CloseCodes.rateLimited,
        errorFrame('RATE_LIMITED', 'Too many frames.', {
          retryAfterSeconds: throttle.retryAfterSeconds,
        }),
      );
      return;
    }

    const connection = this.connections.get(connectionId);
    if (connection !== undefined) connection.lastSeenAt = this.clock.now();

    const parsed = parseClientFrame(text);
    if (!parsed.ok) {
      link.send(errorFrame(parsed.code, parsed.message, { id: parsed.id }));
      return;
    }
    const frame = parsed.frame;
    switch (frame.type) {
      case 'ping':
        link.send(pongFrame(frame.id));
        return;
      case 'auth':
        return this.authenticate(connectionId, frame);
      case 'subscribe':
        if (connection === undefined) {
          link.send(errorFrame('UNAUTHORIZED', 'Authenticate first.', { id: frame.id }));
          return;
        }
        return this.subscribe(connection, frame);
    }
  }

  private async authenticate(
    connectionId: string,
    frame: Extract<ClientFrame, { type: 'auth' }>,
  ): Promise<void> {
    const authentication = await this.authenticator.authenticate(frame.token);
    // The client may have gone while we waited.
    const pending = this.pending.get(connectionId);
    const current = this.connections.get(connectionId);
    const link = pending?.link ?? current?.link;
    if (link === undefined) return;

    const principal = authentication?.principal;
    if (authentication === null || principal?.sessionId === undefined) {
      this.refuse(
        connectionId,
        link,
        CloseCodes.unauthorized,
        errorFrame('UNAUTHORIZED', 'The access token is not valid.', { id: frame.id }),
      );
      return;
    }
    if (!this.mayReceiveMessages(principal)) {
      this.refuse(
        connectionId,
        link,
        CloseCodes.forbidden,
        errorFrame('FORBIDDEN', 'This account may not receive messages.', { id: frame.id }),
      );
      return;
    }

    const now = this.clock.now();
    if (current !== undefined) {
      // Re-authentication: a fresh token for the same account.
      if (current.userId !== principal.userId) {
        this.refuse(
          connectionId,
          link,
          CloseCodes.unauthorized,
          errorFrame('UNAUTHORIZED', 'A connection cannot change accounts.', { id: frame.id }),
        );
        return;
      }
      current.sessionId = principal.sessionId;
      current.expiresAt = authentication.expiresAt;
      current.validatedAt = now;
      link.send(this.ready(current, frame.id));
      return;
    }
    if (pending === undefined) return;

    const opened = await this.limiter.consume(principal.userId, CONNECTIONS_OPENED_PER_USER);
    if (!this.pending.has(connectionId)) return;
    if (!opened.allowed) {
      this.refuse(
        connectionId,
        link,
        CloseCodes.rateLimited,
        errorFrame('RATE_LIMITED', 'Too many new connections for this account.', {
          id: frame.id,
          retryAfterSeconds: opened.retryAfterSeconds,
        }),
      );
      return;
    }
    if (
      this.connections.getUserConnections(principal.userId).length >=
      RealtimeLimits.connectionsPerUser
    ) {
      this.refuse(
        connectionId,
        link,
        CloseCodes.rateLimited,
        errorFrame('RATE_LIMITED', 'Too many open connections for this account.', {
          id: frame.id,
        }),
      );
      return;
    }

    this.pending.delete(connectionId);
    const connection: Connection = {
      connectionId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      authenticatedAt: now,
      expiresAt: authentication.expiresAt,
      validatedAt: now,
      lastSeenAt: now,
      remoteAddress: pending.remoteAddress,
      link: pending.link,
    };
    this.connections.register(connection);
    link.send(this.ready(connection, frame.id));
  }

  private async subscribe(
    connection: Connection,
    frame: Extract<ClientFrame, { type: 'subscribe' }>,
  ): Promise<void> {
    // As fresh as an HTTP request: the session, account and permissions as of now.
    const principal = await this.authenticator.revalidate({
      userId: connection.userId,
      sessionId: connection.sessionId,
    });
    if (this.connections.get(connection.connectionId) === undefined) return;
    if (principal === null) {
      this.refuse(
        connection.connectionId,
        connection.link,
        CloseCodes.unauthorized,
        errorFrame('UNAUTHORIZED', 'The session has ended.', { id: frame.id }),
      );
      return;
    }
    if (!this.mayReceiveMessages(principal)) {
      this.refuse(
        connection.connectionId,
        connection.link,
        CloseCodes.forbidden,
        errorFrame('FORBIDDEN', 'This account may not receive messages.', { id: frame.id }),
      );
      return;
    }
    connection.validatedAt = this.clock.now();

    const position = await this.delivery.position(principal, frame.conversationId);
    if (position.ok) {
      connection.link.send(subscribedFrame(position.value, frame.id));
      return;
    }
    const refusal = { id: frame.id, conversationId: frame.conversationId };
    switch (position.error.kind) {
      case 'not_found':
        connection.link.send(
          errorFrame('CONVERSATION_NOT_FOUND', 'No such conversation.', refusal),
        );
        return;
      case 'forbidden':
        connection.link.send(
          errorFrame('FORBIDDEN', 'You may not read this conversation.', refusal),
        );
        return;
      default:
        connection.link.send(errorFrame('SERVER_ERROR', 'Something went wrong.', refusal));
    }
  }

  // ── Sweeping ───────────────────────────────────────────────────────────

  /**
   * Closes what must not stay open and re-checks what may. Runs on a timer;
   * awaitable (and single-flight) so tests can drive it with their own clock.
   */
  sweep(): Promise<void> {
    this.sweeping ??= this.sweepOnce().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    const now = this.clock.now().getTime();

    for (const pending of [...this.pending.values()]) {
      if (now - pending.openedAt.getTime() >= RealtimeLimits.authDeadlineSeconds * 1000) {
        this.refuse(
          pending.connectionId,
          pending.link,
          CloseCodes.unauthorized,
          errorFrame('UNAUTHORIZED', 'Authentication timed out.'),
        );
      }
    }

    const due = new Map<string, Connection[]>();
    for (const connection of this.connections.all()) {
      if (connection.expiresAt.getTime() <= now) {
        this.refuse(
          connection.connectionId,
          connection.link,
          CloseCodes.unauthorized,
          errorFrame('UNAUTHORIZED', 'The access token has expired.'),
        );
        continue;
      }
      if (now - connection.validatedAt.getTime() >= RealtimeLimits.revalidateSeconds * 1000) {
        // One check per session, however many of its connections are open.
        const key = `${connection.userId}\u0000${connection.sessionId}`;
        due.set(key, [...(due.get(key) ?? []), connection]);
      }
    }

    const groups = [...due.values()];
    for (let start = 0; start < groups.length; start += REVALIDATION_CONCURRENCY) {
      await Promise.all(
        groups.slice(start, start + REVALIDATION_CONCURRENCY).map((group) => this.recheck(group)),
      );
    }
  }

  private async recheck(group: readonly Connection[]): Promise<void> {
    const [first] = group;
    if (first === undefined) return;
    let principal: Principal | null;
    try {
      principal = await this.authenticator.revalidate({
        userId: first.userId,
        sessionId: first.sessionId,
      });
    } catch (error) {
      // Identity unreachable: leave the connections as they are and try again
      // next sweep. They still close when their token expires, because
      // re-authenticating needs identity too.
      this.logger.warn({ err: error }, 'realtime session revalidation failed');
      return;
    }
    for (const connection of group) {
      if (this.connections.get(connection.connectionId) === undefined) continue;
      if (principal === null) {
        this.refuse(
          connection.connectionId,
          connection.link,
          CloseCodes.unauthorized,
          errorFrame('UNAUTHORIZED', 'The session has ended.'),
        );
      } else if (!this.mayReceiveMessages(principal)) {
        this.refuse(
          connection.connectionId,
          connection.link,
          CloseCodes.forbidden,
          errorFrame('FORBIDDEN', 'This account may not receive messages.'),
        );
      } else {
        connection.validatedAt = this.clock.now();
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Realtime carries messaging events, so it asks what every messaging route
   * asks first. Membership is checked per event and per conversation, by
   * messaging; this is only the coarse gate.
   */
  private mayReceiveMessages(principal: Principal): boolean {
    return this.authorization.can(principal, Permissions.messaging.read);
  }

  private ready(connection: Connection, id?: string): string {
    return readyFrame({
      connectionId: connection.connectionId,
      userId: connection.userId,
      expiresAt: connection.expiresAt,
      heartbeatSeconds: RealtimeLimits.heartbeatSeconds,
      id,
    });
  }

  private linkOf(connectionId: string): ClientLink | undefined {
    return this.pending.get(connectionId)?.link ?? this.connections.get(connectionId)?.link;
  }

  /** Says why, forgets the connection, and closes it. */
  private refuse(connectionId: string, link: ClientLink, code: number, frame: string): void {
    link.send(frame);
    this.pending.delete(connectionId);
    this.connections.unregister(connectionId);
    link.close(code, CLOSE_REASONS[code] ?? 'closed');
  }

  private failed(connectionId: string, error: unknown): void {
    this.logger.error({ err: error, connectionId }, 'realtime frame handling failed');
    // The client learns that something failed — and nothing else.
    this.linkOf(connectionId)?.send(errorFrame('SERVER_ERROR', 'Something went wrong.'));
  }
}
