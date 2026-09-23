import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { CallMetadata } from '../../shared';

/**
 * Injects where the request came from — its id and client address — for use
 * cases to put on audit entries. Correlation only; never an input to a decision.
 */
export const RequestMetadata = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CallMetadata => {
    const request = context.switchToHttp().getRequest<Request & { id?: unknown }>();
    return {
      correlationId: typeof request.id === 'string' ? request.id : undefined,
      ipAddress: request.ip,
    };
  },
);
