import type { Clock, RateLimitDecision, RateLimiter, RateLimitPolicy } from '../../shared';

interface Window {
  readonly startedAt: number;
  readonly lengthMs: number;
  count: number;
}

/**
 * Fixed-window counters in process memory.
 *
 * Correct for development and for a single instance. With N instances each
 * keeps its own counters, so the effective limit becomes N × limit — the Redis
 * adapter this port was shaped for fixes that, and is the production path.
 *
 * Memory is bounded: expired windows are swept as the map grows, and past a
 * hard ceiling the oldest windows are dropped. Dropping a window can only make
 * the limiter more lenient, never lock anyone out.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly clock: Clock,
    private readonly maxKeys = 100_000,
  ) {}

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime();
    const windowMs = policy.windowSeconds * 1000;
    const id = `${policy.name}\u0000${key}`;

    let window = this.windows.get(id);
    if (window === undefined || now - window.startedAt >= windowMs) {
      this.makeRoom(now);
      window = { startedAt: now, lengthMs: windowMs, count: 0 };
      this.windows.set(id, window);
    }

    window.count += 1;
    const allowed = window.count <= policy.limit;
    return {
      allowed,
      remaining: Math.max(0, policy.limit - window.count),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000)),
    };
  }

  async reset(key: string, policy: RateLimitPolicy): Promise<void> {
    this.windows.delete(`${policy.name}\u0000${key}`);
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [id, window] of this.windows) {
      if (now - window.startedAt >= window.lengthMs) this.windows.delete(id);
    }
    // Still full: evict in insertion order (oldest first).
    for (const id of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(id);
    }
  }
}
