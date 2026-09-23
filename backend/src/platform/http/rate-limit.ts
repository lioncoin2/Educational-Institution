import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { failure, RATE_LIMITER, type RateLimiter, type RateLimitPolicy } from '../../shared';
import { FailureException } from './http-failure';

export const RATE_LIMIT_POLICY = 'platform:rate_limit_policy';

/**
 * Per-client-IP throttling for a route.
 *
 * This is the transport half of rate limiting: it stops one address hammering
 * an endpoint. Limits that must hold whatever the transport — per account, per
 * user — live in the use cases, against the same `RateLimiter` port.
 *
 * The client IP is only as trustworthy as `TRUST_PROXY` is correct.
 */
export function RateLimit(policy: RateLimitPolicy): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(RATE_LIMIT_POLICY, policy), UseGuards(RateLimitGuard));
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(
      RATE_LIMIT_POLICY,
      [context.getHandler(), context.getClass()],
    );
    if (policy === undefined) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const decision = await this.limiter.consume(request.ip ?? 'unknown', policy);
    if (!decision.allowed) {
      throw new FailureException(
        failure('rate_limited', 'platform.rate_limited', 'Too many requests. Try again later.', {
          retryAfterSeconds: decision.retryAfterSeconds,
        }),
      );
    }
    return true;
  }
}
