import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { RateLimiter } from '../../shared';
import { FailureException } from './http-failure';
import { RateLimit, RateLimitGuard } from './rate-limit';

class Routes {
  @RateLimit({ name: 'test.plain', limit: 1, windowSeconds: 60 })
  plain(this: void): void {}

  @RateLimit({ name: 'test.named', limit: 1, windowSeconds: 60 }, 'communities.too_many_attempts')
  named(this: void): void {}

  unlimited(this: void): void {}
}

const refusing: RateLimiter = {
  consume: async () => ({ allowed: false, remaining: 0, retryAfterSeconds: 42 }),
  reset: async () => undefined,
};

function contextFor(handler: () => void): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ ip: '203.0.113.9' }) }),
  } as unknown as ExecutionContext;
}

async function refusal(handler: () => void) {
  const guard = new RateLimitGuard(new Reflector(), refusing);
  try {
    await guard.canActivate(contextFor(handler));
  } catch (error) {
    return error instanceof FailureException ? error.failure : error;
  }
  return 'allowed';
}

describe('per-address rate limits on a route', () => {
  it('answers in the platform’s vocabulary unless the route names its own', async () => {
    expect(await refusal(Routes.prototype.plain)).toMatchObject({
      kind: 'rate_limited',
      code: 'platform.rate_limited',
      details: { retryAfterSeconds: 42 },
    });
    expect(await refusal(Routes.prototype.named)).toMatchObject({
      kind: 'rate_limited',
      code: 'communities.too_many_attempts',
      details: { retryAfterSeconds: 42 },
    });
  });

  it('lets through a route with no limit', async () => {
    expect(await refusal(Routes.prototype.unlimited)).toBe('allowed');
  });
});
