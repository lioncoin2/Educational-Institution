import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import { RATE_LIMITER, type RateLimiter } from '../../../shared';
import { RealtimeSessions } from '../application/realtime-sessions';
import type { ClientLink } from '../domain/connection';
import { CloseCodes, REALTIME_PATH } from '../domain/protocol';
import { HANDSHAKES_PER_ADDRESS, RealtimeLimits } from '../domain/realtime-policy';
import { clientAddress } from './client-address';

interface Socket {
  readonly connectionId: string;
  /** Cleared on each ping, set by the pong (or any frame) that answers it. */
  alive: boolean;
}

/** How long shutdown waits for clients to acknowledge the close before cutting them off. */
const SHUTDOWN_GRACE_MS = 1000;

/**
 * The WebSocket transport — the only file that knows a socket library.
 *
 * Plain RFC 6455 WebSocket through `ws` (the library `@nestjs/platform-ws`
 * wraps), served on the API's own HTTP server at `/realtime`. See ADR 0012
 * for why it is neither socket.io nor a Nest gateway.
 *
 * It owns what only a transport can do, and nothing else:
 *
 *   the handshake   the path; the Origin, for browsers (the CORS allow-list —
 *                   CORS itself does not apply to WebSockets); this
 *                   instance's capacity; the per-address handshake rate —
 *                   all refused with an HTTP status before any socket exists
 *   frames          at most 4 KiB each (the library refuses bigger ones with
 *                   close code 1009 before buffering them); no compression,
 *                   which costs CPU per connection and, with a credential in
 *                   the stream, invites CRIME-style attacks; text only
 *   liveness        a protocol ping every heartbeat; a connection that has
 *                   not answered by the next one is dead and is dropped —
 *                   what survives a phone that lost its network silently
 *   backpressure    a client that stops reading is let go once too far
 *                   behind, instead of growing the server's memory
 *
 * Everything the frames MEAN is `RealtimeSessions`' business.
 */
@Injectable()
export class WebSocketTransport implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WebSocketTransport.name);
  private readonly sockets = new Map<WebSocket, Socket>();
  private server: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessions: RealtimeSessions,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    // An application context without HTTP (the CLI) has nothing to attach to.
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (httpServer === undefined) return;

    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: RealtimeLimits.maxInboundFrameBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.httpServer = httpServer;
    httpServer.on('upgrade', this.onUpgrade);
    this.heartbeat = setInterval(() => this.beat(), RealtimeLimits.heartbeatSeconds * 1000);
    this.heartbeat.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.httpServer?.off('upgrade', this.onUpgrade);
    this.httpServer = null;

    const open = [...this.sockets.keys()];
    for (const ws of open) ws.close(CloseCodes.goingAway, 'server shutting down');
    if (open.length > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        timer.unref();
        const check = setInterval(() => {
          if (this.sockets.size === 0) {
            clearInterval(check);
            clearTimeout(timer);
            resolve();
          }
        }, 10);
        check.unref();
      });
    }
    for (const ws of this.sockets.keys()) ws.terminate();
    this.server?.close();
    this.server = null;
  }

  /** How many sockets are open right now, authenticated or not. */
  openSockets(): number {
    return this.sockets.size;
  }

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.upgrade(request, socket, head).catch((error: unknown) => {
      this.logger.error({ err: error }, 'realtime handshake failed');
      refuse(socket, 500);
    });
  };

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const server = this.server;
    if (server === null) return refuse(socket, 503);
    if (pathOf(request.url) !== REALTIME_PATH) return refuse(socket, 404);

    // Browsers always send Origin; native apps do not. A browser page may only
    // connect from an origin the HTTP API would also serve.
    const origin = request.headers.origin;
    if (origin !== undefined && !this.config.http.corsOrigins.includes(origin)) {
      return refuse(socket, 403);
    }
    if (this.sockets.size >= RealtimeLimits.maxConnections) return refuse(socket, 503);

    const address = clientAddress(
      request.socket.remoteAddress,
      request.headers['x-forwarded-for'],
      this.config.http.trustProxy,
    );
    const decision = await this.limiter.consume(address, HANDSHAKES_PER_ADDRESS);
    if (!decision.allowed) {
      return refuse(socket, 429, { 'Retry-After': String(decision.retryAfterSeconds) });
    }
    if (socket.destroyed) return;

    server.handleUpgrade(request, socket, head, (ws) => this.accept(ws, address));
  }

  private accept(ws: WebSocket, address: string): void {
    const link: ClientLink = {
      send: (frame) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        if (ws.bufferedAmount > RealtimeLimits.maxBufferedBytes) {
          ws.close(CloseCodes.tryAgainLater, 'too far behind');
          return false;
        }
        ws.send(frame);
        return true;
      },
      close: (code, reason) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason);
        }
      },
    };
    const entry: Socket = { connectionId: this.sessions.opened(link, address), alive: true };
    this.sockets.set(ws, entry);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      entry.alive = true;
      void this.sessions.received(entry.connectionId, isBinary ? null : text(data));
    });
    ws.on('pong', () => {
      entry.alive = true;
      this.sessions.heard(entry.connectionId);
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.sessions.closed(entry.connectionId);
    });
    // An oversized or malformed frame: the library closes the socket with the
    // right code, and 'close' above cleans up. Nothing to tell anyone else.
    ws.on('error', () => undefined);
  }

  /**
   * One heartbeat round: drops every socket that did not answer the last
   * ping, and pings the rest. The timer runs it; tests run it directly.
   */
  beat(): void {
    for (const [ws, entry] of this.sockets) {
      // Closing already: the library's own close timeout ends it.
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!entry.alive) {
        ws.terminate();
        continue;
      }
      entry.alive = false;
      try {
        ws.ping();
      } catch {
        // Never let one socket stop the round — or, from a timer, the process.
        ws.terminate();
      }
    }
  }
}

function pathOf(url: string | undefined): string {
  const path = (url ?? '').split('?')[0] ?? '';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Answers a handshake that will not become a WebSocket, and closes it. */
function refuse(socket: Duplex, status: number, headers: Record<string, string> = {}): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`,
    'Connection: close',
    'Content-Length: 0',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.end(`${lines.join('\r\n')}\r\n\r\n`);
  socket.destroy();
}
