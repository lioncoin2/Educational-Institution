import { Logger, type ArgumentsHost } from '@nestjs/common';
import type { Pool } from 'pg';

import { AllExceptionsFilter } from '../http/all-exceptions.filter';
import { FailureException } from '../http/http-failure';
import { HealthController, READINESS_TIMEOUT_MS } from './health.controller';

/**
 * A stand-in pooled client that records how it was released, so a test can
 * prove a stuck connection is destroyed (released WITH an error) rather than
 * returned to the pool — the real client lifecycle the readiness check drives.
 */
function fakeClient(query: (...args: unknown[]) => Promise<unknown>) {
  const released: unknown[] = [];
  const client = { query, release: (err?: unknown) => released.push(err) };
  return { client, released };
}

/** A stand-in pool whose `connect()` hands out `client` (or rejects). */
function poolReturning(client: unknown, connect?: () => Promise<unknown>): Pool {
  return { connect: connect ?? (() => Promise.resolve(client)) } as unknown as Pool;
}

/**
 * Runs an exception through the real global filter and captures the response the
 * client would receive — so the readiness 503 is asserted on the actual
 * externally observable contract, not just the thrown payload.
 */
function throughFilter(exception: unknown): { status: number; body: Record<string, unknown> } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const response = {
    setHeader() {
      return this;
    },
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ id: 'req-health' }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status, body };
}

// The readiness failure body (code/kind/message/details) is asserted here on the
// `FailureException` the controller throws; `all-exceptions.filter.spec.ts`
// ("passes a mapped domain failure through unchanged") proves the global filter
// delivers that exact shape to the client, so the two together establish the
// client-visible 503 body without re-implementing the filter harness here.
describe('HealthController', () => {
  describe('live', () => {
    it('is dependency-free: always reports the process is up', () => {
      expect(new HealthController().live()).toEqual({ status: 'ok' });
      // Even with a database that would fail readiness, liveness stays ok.
      const { client } = fakeClient(() => Promise.reject(new Error('db down')));
      expect(new HealthController(poolReturning(client)).live()).toEqual({ status: 'ok' });
    });
  });

  describe('ready', () => {
    it('pings a pooled client and reports ok, then releases it cleanly', async () => {
      const calls: unknown[][] = [];
      const { client, released } = fakeClient((...args) => {
        calls.push(args);
        return Promise.resolve({ rows: [{ '?column?': 1 }] });
      });
      const controller = new HealthController(poolReturning(client));

      const body = await controller.ready();

      expect(body).toEqual({
        status: 'ok',
        uptimeSeconds: expect.any(Number),
        checks: { database: 'ok' },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('SELECT 1');
      // Healthy answer → returned to the pool, NOT destroyed.
      expect(released).toEqual([undefined]);
    });

    it('fails with the standard 503 error body when the query errors', async () => {
      const { client, released } = fakeClient(() =>
        Promise.reject(new Error('connection refused to host=secret')),
      );
      const controller = new HealthController(poolReturning(client));

      let thrown: unknown;
      try {
        await controller.ready();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FailureException);
      const ex = thrown as FailureException;
      expect(ex.getStatus()).toBe(503);
      expect(ex.failure).toMatchObject({
        kind: 'unavailable',
        code: 'platform.not_ready',
        message: 'The service is not ready.',
        details: { database: 'down' },
      });
      // The raw driver error (which can carry connection details) never leaks
      // into the body the filter will serialize to the client.
      expect(JSON.stringify(ex.getResponse())).not.toContain('secret');
      // A query error (not a timeout) leaves a usable connection → clean release.
      expect(released).toEqual([undefined]);
    });

    it('fails with the standard 503 error body when a client cannot be acquired', async () => {
      const controller = new HealthController(
        poolReturning(null, () => Promise.reject(new Error('acquire timeout host=secret'))),
      );

      let thrown: unknown;
      try {
        await controller.ready();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FailureException);
      const ex = thrown as FailureException;
      expect(ex.getStatus()).toBe(503);
      expect(ex.failure).toMatchObject({ kind: 'unavailable', code: 'platform.not_ready' });
      expect(JSON.stringify(ex.getResponse())).not.toContain('secret');
    });

    it('on timeout, DESTROYS the stuck connection (release with an error) and 503s', async () => {
      jest.useFakeTimers();
      try {
        // A query that never settles — a connected but unresponsive server.
        const { client, released } = fakeClient(() => new Promise<never>(() => {}));
        const controller = new HealthController(poolReturning(client));

        const pending = controller.ready();
        const assertion = expect(pending).rejects.toBeInstanceOf(FailureException);
        await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
        await assertion;

        // The key no-leak guarantee: the still-busy client is released WITH an
        // error, so pg closes/drops it instead of leaving it checked out —
        // repeated probes cannot occupy or exhaust the pool.
        expect(released).toHaveLength(1);
        expect(released[0]).toBeInstanceOf(Error);
      } finally {
        jest.useRealTimers();
      }
    });

    it('a late query rejection after the timeout does not release the client twice', async () => {
      jest.useFakeTimers();
      try {
        let rejectQuery!: (reason: unknown) => void;
        const queryPromise = new Promise<never>((_resolve, reject) => {
          rejectQuery = reject;
        });
        const { client, released } = fakeClient(() => queryPromise);
        const controller = new HealthController(poolReturning(client));

        const pending = controller.ready();
        const assertion = expect(pending).rejects.toBeInstanceOf(FailureException);
        await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS); // the timeout wins
        await assertion;
        expect(released).toEqual([expect.any(Error)]); // destroyed exactly once

        // The abandoned query rejects late (its connection was dropped). The
        // controller's `.catch` guard absorbs it: no second release, and because
        // the rejection is handled jest would flag an unhandled rejection if it
        // were not.
        rejectQuery(new Error('connection terminated'));
        await Promise.resolve();
        await Promise.resolve();
        expect(released).toEqual([expect.any(Error)]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('clears the timeout timer when the query answers early (no dangling timer)', async () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      try {
        const { client } = fakeClient(() => Promise.resolve({ rows: [] }));
        const controller = new HealthController(poolReturning(client));

        await controller.ready();

        // The timer is cleared on the success path, so no stray timer survives.
        expect(clearSpy).toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        clearSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('is ready with nothing to check when booted without a database', async () => {
      const body = await new HealthController().ready();
      expect(body).toEqual({
        status: 'ok',
        uptimeSeconds: expect.any(Number),
        checks: { database: 'not_configured' },
      });
    });
  });

  describe('ready → the 503 a client actually receives (through the global filter)', () => {
    beforeAll(() => {
      // The filter logs 5xx by design; silence it so a deliberate 503 does not
      // print a stack trace into a passing suite.
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });
    afterAll(() => jest.restoreAllMocks());

    it('serializes the canonical error envelope, naming the dependency, leaking nothing', async () => {
      const { client } = fakeClient(() =>
        Promise.reject(new Error('refused host=secret.db pwd=hunter2')),
      );
      const controller = new HealthController(poolReturning(client));

      let thrown: unknown;
      try {
        await controller.ready();
      } catch (error) {
        thrown = error;
      }

      const { status, body } = throughFilter(thrown);
      expect(status).toBe(503);
      expect(body).toEqual({
        error: {
          kind: 'unavailable',
          code: 'platform.not_ready',
          message: 'The service is not ready.',
          details: { database: 'down' },
        },
        requestId: 'req-health',
      });
      // No driver text, host, or secret ever reaches the client body.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('hunter2');
    });
  });
});
