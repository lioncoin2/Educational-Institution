import { createServer, connect, type Server, type Socket } from 'node:net';

import type { Pool } from 'pg';

import { DATABASE_POOL } from '../../src/platform/database';
import { startApi, type RunningApi } from '../support/api-client';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

/**
 * How the link between the API and Postgres behaves: passing bytes both ways,
 * cutting every connection as it arrives (the server is gone), or keeping the
 * connections open while nothing ever answers (a hung server).
 */
type LinkMode = 'forward' | 'refuse' | 'blackhole';

/**
 * A TCP relay between the API and the scratch database, so a test can take the
 * database away — or hang it — under the REAL driver and pool, without touching
 * the database itself.
 */
async function databaseLink(target: URL): Promise<{
  readonly url: string;
  set(mode: LinkMode): void;
  close(): Promise<void>;
}> {
  let mode: LinkMode = 'forward';
  const sockets = new Set<Socket>();
  const server: Server = createServer((inbound) => {
    sockets.add(inbound);
    inbound.on('close', () => sockets.delete(inbound));
    if (mode === 'refuse') {
      inbound.destroy();
      return;
    }
    const outbound = connect(Number(target.port || 5432), target.hostname);
    sockets.add(outbound);
    outbound.on('close', () => sockets.delete(outbound));
    inbound.on('data', (chunk) => {
      if (mode === 'forward') outbound.write(chunk);
    });
    outbound.on('data', (chunk) => {
      if (mode === 'forward') inbound.write(chunk);
    });
    inbound.on('error', () => outbound.destroy());
    outbound.on('error', () => inbound.destroy());
    inbound.on('close', () => outbound.destroy());
    outbound.on('close', () => inbound.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no relay address');
  const url = new URL(target.toString());
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url: url.toString(),
    set(next) {
      // A hang that ends drops its connections too: bytes swallowed while
      // hung left them waiting for answers that will never come.
      const drop = next === 'refuse' || (mode === 'blackhole' && next !== 'blackhole');
      mode = next;
      if (drop) for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Readiness end to end over REAL PostgreSQL (observability.md §3): the public
 * route through `configureApp` and the global filter, the real `pg` pool, and a
 * database that is healthy, gone, hung, and back. Liveness never follows the
 * database; readiness answers within its bound and never names the database's
 * address or credentials.
 */
describeWithPostgres('readiness over PostgreSQL (HTTP → pool)', () => {
  let scratch: ScratchDatabase;
  let link: Awaited<ReturnType<typeof databaseLink>>;
  let api: RunningApi;

  const ready = () => api.call('GET', '/health/ready');
  const live = () => api.call('GET', '/health/live');
  const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const started = Date.now();
    const value = await work();
    return { value, ms: Date.now() - started };
  };

  beforeAll(async () => {
    scratch = await scratchDatabase();
    link = await databaseLink(new URL(scratch.url));
    api = await startApi({ DATABASE_URL: link.url });
  });

  afterAll(async () => {
    // The link first: every connection through it ends at once, so closing
    // the pool waits on none of them.
    await link?.close();
    await api?.close();
    await scratch?.drop();
  }, 60_000);

  afterEach(() => link.set('forward'));

  /** Nothing about where the database is, or how to sign in to it, ever leaves. */
  function expectNothingAboutTheDatabase(raw: string): void {
    const target = new URL(scratch.url);
    expect(raw).not.toContain(target.hostname === '127.0.0.1' ? ':' + target.port : target.host);
    expect(raw).not.toContain(new URL(link.url).port);
    if (target.password !== '') expect(raw).not.toContain(target.password);
    expect(raw).not.toContain('postgres');
    expect(raw).not.toMatch(/ECONN|terminated|timeout/i);
  }

  it('is ready, naming the database it checked, while Postgres answers', async () => {
    const response = await ready();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      uptimeSeconds: expect.any(Number),
      checks: { database: 'ok' },
    });
    expect((await live()).status).toBe(200);
  });

  it('is unready (503, the standard envelope) at once when the database is gone — and liveness stays up', async () => {
    link.set('refuse');
    const { value: response, ms } = await timed(ready);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        kind: 'unavailable',
        code: 'platform.not_ready',
        message: 'The service is not ready.',
        details: { database: 'down' },
      },
      requestId: expect.any(String),
    });
    expect(ms).toBeLessThan(5_000);
    expectNothingAboutTheDatabase(response.raw);
    expect((await live()).status).toBe(200);
  });

  it('is unready within its bound when the database hangs, and a burst of probes costs one connection', async () => {
    // Warm the pool, then hang the link: pooled connections stay open, and
    // nothing answers on them.
    expect((await ready()).status).toBe(200);
    link.set('blackhole');

    const { value: responses, ms } = await timed(() =>
      Promise.all(Array.from({ length: 20 }, () => ready())),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(503));
    // READINESS_TIMEOUT_MS (2s) for the query on an open connection, with room
    // for a slow CI runner — never the pool's 5s acquire bound times twenty.
    expect(ms).toBeLessThan(4_500);
    for (const response of responses) expectNothingAboutTheDatabase(response.raw);
    expect((await live()).status).toBe(200);
  }, 20_000);

  it('recovers by itself once the database answers again — the pool was not exhausted by the probes', async () => {
    link.set('blackhole');
    await Promise.all(Array.from({ length: 12 }, () => ready()));
    link.set('forward');

    const response = await ready();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ checks: { database: 'ok' } });
    // The application's own queries are served too: the pool has room.
    const signIn = await api.call('POST', '/auth/login', {
      body: {
        identifier: 'nobody@institution.test',
        password: 'not a real passphrase',
        device: { platform: 'web', label: 't' },
      },
    });
    expect(signIn.status).toBe(401);
  }, 20_000);

  // Found by this suite: a client the application had checked out (a
  // transaction in flight) when its connection died emitted an 'error' nobody
  // heard — an uncaught exception, fatal to the whole process. Now the work
  // fails on its own and the process stays up.
  it('survives a connection dying under a transaction in flight: the work fails, the process stays up', async () => {
    const pool = api.app.get<Pool>(DATABASE_POOL);
    const client = await pool.connect();
    const inFlight = client.query('BEGIN').then(() => client.query('SELECT pg_sleep(5)'));
    const outcome = inFlight.then(
      () => 'answered',
      () => 'failed',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    link.set('refuse');
    expect(await outcome).toBe('failed');
    client.release(new Error('the connection died'));

    expect((await live()).status).toBe(200);
    expect((await ready()).status).toBe(503);
    link.set('forward');
    expect((await ready()).status).toBe(200);
  }, 20_000);
});
