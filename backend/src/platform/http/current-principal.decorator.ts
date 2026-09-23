import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';

import type { Principal } from '../../shared';

/**
 * Injects the authenticated principal into a controller method.
 *
 * It throws rather than returning undefined: a route that asks for a principal
 * has already been guarded, so its absence is a wiring bug, not a request the
 * handler should try to serve.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<{ principal?: Principal }>();
    if (request.principal === undefined) {
      throw new UnauthorizedException('Authentication required.');
    }
    return request.principal;
  },
);
