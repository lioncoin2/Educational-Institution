import { Controller, Get, Inject, Optional } from '@nestjs/common';
import type { Pool } from 'pg';

import { failure } from '../../shared';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DATABASE_POOL } from '../database/database';
import { FailureException } from '../http/http-failure';
import { PublicRoute } from '../http/public-route.decorator';

/**
 * A readiness dependency check must answer within this budget. The pool's
 * `connectionTimeoutMillis` bounds *acquiring* a connection, not a query on an
 * established-yet-unresponsive one, so the check races this timeout and a hung
 * server fails readiness promptly instead of stalling the probe.
 */
export const READINESS_TIMEOUT_MS = 2_000;

/** The error passed to `client.release(err)` to DESTROY a stuck connection. */
const READINESS_TIMEOUT_ERROR = new Error('readiness: database did not answer in time');

interface ReadyBody {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
  readonly checks: { readonly database: 'ok' | 'not_configured' };
}

/**
 * Liveness and readiness (observability.md §3).
 *
 * - **live** — the process is up and serving. Dependency-free on purpose: a
 *   transient database outage must never fail liveness and restart a healthy
 *   pod (that would only slow recovery).
 * - **ready** — the process can serve traffic. It pings the database pool with
 *   a bounded `SELECT 1` and, when the pool cannot answer, fails with the
 *   standard **503** error body (`{ error: { kind: 'unavailable', … } }`, via
 *   [FailureException], which the global exception filter passes through
 *   unchanged), so the orchestrator removes the pod from rotation *without*
 *   restarting it. The probe is time-bounded in two parts: acquiring a client
 *   by the pool's `connectionTimeoutMillis`, then the query by
 *   [READINESS_TIMEOUT_MS]. Booted without a database (a unit test, or a
 *   deliberately db-less boot) there is nothing to check and the pod is ready.
 *   "Without a database" is what configuration says (`database.configured`),
 *   not whether a pool object exists: `AppModule` always composes the pool —
 *   lazily, against the local default URL when DATABASE_URL is unset — while
 *   the modules then run on their in-memory adapters, so pinging that pool
 *   would fail readiness for a process that depends on no database at all. A
 *   deployed environment always configures one (`DATABASE_URL` is required).
 * - Concurrent probes share ONE ping: the route is public, and without this a
 *   burst of requests would each hold a pooled connection for up to the
 *   timeout — taking the pool from real traffic exactly when the database is
 *   slow. A probe arriving while a ping is in flight waits for that ping.
 *
 * Redis is not checked: this build has no connected Redis client (the rate
 * limiter is in-process), so there is nothing to ping; a Redis readiness check
 * lands with the P11 multi-instance Redis rate-limit adapter. The media
 * provider's readiness is not for this route either — it stays inside live,
 * where it gates Start (P7.1, decision 7; docs/p7-livekit-readiness.md §15).
 */
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();
  private inFlight: Promise<void> | undefined;

  constructor(
    @Optional() @Inject(DATABASE_POOL) private readonly pool?: Pool,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  @Get('live')
  @PublicRoute()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @PublicRoute()
  async ready(): Promise<ReadyBody> {
    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const pool = this.pool;
    if (pool === undefined || this.config?.database.configured === false) {
      return { status: 'ok', uptimeSeconds, checks: { database: 'not_configured' } };
    }
    try {
      this.inFlight ??= this.pingDatabase(pool).finally(() => {
        this.inFlight = undefined;
      });
      await this.inFlight;
    } catch {
      // The driver error is deliberately neither read nor echoed — it can carry
      // a connection string or host. The standard 503 error body names only the
      // unready dependency.
      throw new FailureException(
        failure('unavailable', 'platform.not_ready', 'The service is not ready.', {
          database: 'down',
        }),
      );
    }
    return { status: 'ok', uptimeSeconds, checks: { database: 'ok' } };
  }

  /**
   * A `SELECT 1` on a dedicated pooled client, raced against
   * [READINESS_TIMEOUT_MS].
   *
   * pg cannot cancel an in-flight query, and `pool.query` releases its client
   * only once the query settles — so a `pool.query` that lost this race would
   * keep its client checked out until a hung server finally answered, and
   * repeated probes would occupy and eventually exhaust the pool. We therefore
   * hold the client ourselves: on timeout we `release(err)`, which closes the
   * connection and removes it from the pool, reclaiming the slot immediately.
   * The server-side query is NOT cancelled (the connection is simply dropped),
   * but stuck probes can no longer starve the pool.
   */
  private async pingDatabase(pool: Pool): Promise<void> {
    const client = await pool.connect();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(READINESS_TIMEOUT_ERROR);
      }, READINESS_TIMEOUT_MS);
    });
    const query = client.query('SELECT 1');
    // Once a timeout wins we drop the connection and the query rejects late;
    // absorb that so it is never an unhandled rejection.
    void Promise.resolve(query).catch(() => {});
    try {
      await Promise.race([query, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Clean return on success; destroy (release WITH an error) on timeout so
      // a still-busy connection is closed and dropped, never left checked out.
      client.release(timedOut ? READINESS_TIMEOUT_ERROR : undefined);
    }
  }
}
