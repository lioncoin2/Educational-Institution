import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';

import { failure } from '../../shared';
import { isDatabaseUnavailable } from '../database/postgres-errors';
import { FailureException } from './http-failure';

/**
 * A store that cannot be reached answers 503 `unavailable`, not an opaque
 * 500: the client learns that retrying is sensible, and the answer is never
 * computed from anything but the store — a caller that needed a permit and
 * could not read one fails closed.
 *
 * Opt-in per controller (`@UseInterceptors(DatabaseUnavailableInterceptor)`),
 * because only a module whose every route promises it (Communities, §12) should
 * change its answer. Anything else — a bug, a constraint violation — still
 * reaches the global filter as the fault it is.
 */
@Injectable()
export class DatabaseUnavailableInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() =>
            isDatabaseUnavailable(error)
              ? new FailureException(
                  failure(
                    'unavailable',
                    'unavailable',
                    'A service this request needs is briefly unavailable. Try again shortly.',
                  ),
                )
              : error,
          ),
        ),
      );
  }
}
