import { AdjustableClock } from '../../../test/support/identity-harness';
import { InMemoryRateLimiter } from './in-memory-rate-limiter';

const POLICY = { name: 'test', limit: 3, windowSeconds: 60 };

describe('InMemoryRateLimiter', () => {
  it('allows up to the limit, then refuses with a retry-after', async () => {
    const limiter = new InMemoryRateLimiter(new AdjustableClock());
    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push(await limiter.consume('k', POLICY));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions[2]?.remaining).toBe(0);
    expect(decisions[3]?.retryAfterSeconds).toBe(60);
  });

  it('opens a fresh window once the old one elapses', async () => {
    const clock = new AdjustableClock();
    const limiter = new InMemoryRateLimiter(clock);
    for (let i = 0; i < 4; i++) await limiter.consume('k', POLICY);
    clock.advance(30);
    expect((await limiter.consume('k', POLICY)).retryAfterSeconds).toBe(30);
    clock.advance(30);
    expect((await limiter.consume('k', POLICY)).allowed).toBe(true);
  });

  it('keeps keys and policies apart', async () => {
    const limiter = new InMemoryRateLimiter(new AdjustableClock());
    for (let i = 0; i < 3; i++) await limiter.consume('a', POLICY);
    expect((await limiter.consume('b', POLICY)).allowed).toBe(true);
    expect((await limiter.consume('a', { ...POLICY, name: 'other' })).allowed).toBe(true);
    expect((await limiter.consume('a', POLICY)).allowed).toBe(false);
  });

  it('forgets a key on reset', async () => {
    const limiter = new InMemoryRateLimiter(new AdjustableClock());
    for (let i = 0; i < 4; i++) await limiter.consume('k', POLICY);
    await limiter.reset('k', POLICY);
    expect((await limiter.consume('k', POLICY)).allowed).toBe(true);
  });

  // Bounded memory. Evicting a window can only make the limiter more lenient.
  it('never holds more keys than its ceiling', async () => {
    const limiter = new InMemoryRateLimiter(new AdjustableClock(), 100);
    for (let i = 0; i < 1000; i++) await limiter.consume(`k${i}`, POLICY);
    expect(
      (limiter as unknown as { windows: Map<string, unknown> }).windows.size,
    ).toBeLessThanOrEqual(100);
  });
});
