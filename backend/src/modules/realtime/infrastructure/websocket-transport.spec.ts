import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HttpAdapterHost } from '@nestjs/core';

import { type HandshakeRefused, TestSocket } from '../../../../test/support/realtime-client';
import type { AppConfig } from '../../../platform/config/app-config';
import type { RateLimitDecision, RateLimiter } from '../../../shared';
import type { RealtimeSessions } from '../application/realtime-sessions';
import type { ClientLink } from '../domain/connection';
import { HANDSHAKES_PER_ADDRESS } from '../domain/realtime-policy';
import { WebSocketTransport } from './websocket-transport';

/** What the transport hands the application: every call, in order. */
class RecordingSessions {
  readonly links = new Map<string, ClientLink>();
  readonly received: { connectionId: string; text: string | null }[] = [];
  readonly closed: string[] = [];
  private next = 0;

  opened(link: ClientLink): string {
    this.next += 1;
    const id = `conn-${this.next}`;
    this.links.set(id, link);
    return id;
  }
  received_(connectionId: string, text: string | null): Promise<void> {
    this.received.push({ connectionId, text });
    return Promise.resolve();
  }
  heard(): void {}
  closedWith(connectionId: string): void {
    this.closed.push(connectionId);
  }
}

class ScriptedLimiter implements RateLimiter {
  readonly keys: string[] = [];
  decision: RateLimitDecision = { allowed: true, remaining: 1, retryAfterSeconds: 0 };
  async consume(key: string, policy: { name: string }): Promise<RateLimitDecision> {
    if (policy.name === HANDSHAKES_PER_ADDRESS.name) this.keys.push(key);
    return this.decision;
  }
  async reset(): Promise<void> {}
}

const CONFIG = {
  http: { trustProxy: false, corsOrigins: ['https://app.institution.test'] },
} as unknown as AppConfig;

describe('WebSocketTransport', () => {
  let server: Server;
  let transport: WebSocketTransport;
  let sessions: RecordingSessions;
  let limiter: ScriptedLimiter;
  let url: string;

  beforeEach(async () => {
    server = createServer((_request, response) => response.writeHead(404).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/realtime`;
    sessions = new RecordingSessions();
    limiter = new ScriptedLimiter();
    const application = {
      opened: (link: ClientLink) => sessions.opened(link),
      received: (id: string, text: string | null) => sessions.received_(id, text),
      heard: () => sessions.heard(),
      closed: (id: string) => sessions.closedWith(id),
    } as unknown as RealtimeSessions;
    const host = { httpAdapter: { getHttpServer: () => server } } as unknown as HttpAdapterHost;
    transport = new WebSocketTransport(host, application, limiter, CONFIG);
    transport.onApplicationBootstrap();
  });

  afterEach(async () => {
    await transport.beforeApplicationShutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses a handshake over the per-address rate with 429 and Retry-After, before any socket exists', async () => {
    limiter.decision = { allowed: false, remaining: 0, retryAfterSeconds: 42 };
    let refused: HandshakeRefused | null = null;
    try {
      await TestSocket.open(url);
    } catch (error) {
      refused = error as HandshakeRefused;
    }
    expect(refused?.status).toBe(429);
    expect(refused?.headers['retry-after']).toBe('42');
    expect(sessions.links.size).toBe(0);
    expect(limiter.keys).toEqual(['127.0.0.1']);
  });

  it('hands the application text frames as text and binary frames as null', async () => {
    const socket = await TestSocket.open(url);
    socket.send({ type: 'ping' });
    socket.sendRaw(Buffer.from([1, 2, 3]));
    await eventually(() => sessions.received.length === 2);

    expect(sessions.received).toEqual([
      { connectionId: 'conn-1', text: '{"type":"ping"}' },
      { connectionId: 'conn-1', text: null },
    ]);
    await socket.close();
    await eventually(() => sessions.closed.length === 1);
    expect(transport.openSockets()).toBe(0);
  });

  it('gives the application a link that sends, and closes with the code it is given', async () => {
    const socket = await TestSocket.open(url);
    const link = sessions.links.get('conn-1')!;

    expect(link.send('{"type":"pong","version":1}')).toBe(true);
    await socket.waitFor((f) => f.type === 'pong');
    link.close(4401, 'unauthorized');
    expect(await socket.waitForClose()).toEqual({ code: 4401, reason: 'unauthorized' });
    // A closed connection takes nothing more.
    expect(link.send('{"type":"pong","version":1}')).toBe(false);
  });

  it('lets go of a client that stops reading, once it is too far behind (1013)', async () => {
    const socket = await TestSocket.open(url);
    const link = sessions.links.get('conn-1')!;
    // The client's end stops reading: the server's outbound buffer can only grow.
    (socket.ws as unknown as { _socket: { pause(): void } })._socket.pause();

    const chunk = JSON.stringify({ type: 'x', version: 1, padding: 'x'.repeat(64 * 1024) });
    let accepted = 0;
    while (link.send(chunk) && accepted < 2000) {
      accepted += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }

    // It took a good deal, then refused rather than buffer without bound.
    expect(accepted).toBeGreaterThan(16);
    expect(accepted).toBeLessThan(2000);
    (socket.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    expect((await socket.waitForClose(10_000)).code).toBe(1013);
  }, 30_000);

  it('does nothing at all in an application context without an HTTP server', () => {
    const cli = new WebSocketTransport(
      { httpAdapter: undefined } as unknown as HttpAdapterHost,
      {} as RealtimeSessions,
      limiter,
      CONFIG,
    );
    expect(() => cli.onApplicationBootstrap()).not.toThrow();
    expect(cli.openSockets()).toBe(0);
  });
});

async function eventually(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
