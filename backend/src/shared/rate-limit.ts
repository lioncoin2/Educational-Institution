/**
 * Rate limiting, as a port.
 *
 * Use cases and the HTTP edge ask "may this key act again?" without knowing
 * where the counters live. The in-process adapter serves development and a
 * single instance; a Redis adapter replaces it when there is more than one
 * instance, because per-process counters multiply the effective limit by the
 * number of replicas.
 */
export interface RateLimitPolicy {
  /** Stable name, part of every key — two policies never share a counter. */
  readonly name: string;
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window resets; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one attempt against `key` under `policy` and says whether it may proceed. */
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
  /** Clears the counter — e.g. a successful login clears that account's failures. */
  reset(key: string, policy: RateLimitPolicy): Promise<void>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');
