import { HttpException, HttpStatus } from '@nestjs/common';

import type { Failure, FailureKind, Result } from '../../shared';

/**
 * The one place expected failures become HTTP.
 *
 * Use cases return `Result` and never know what a status code is; controllers
 * call `unwrap`. Adding a new failure kind is a compile error here until it is
 * mapped, so transport semantics can't drift away from domain semantics.
 */
const STATUS_BY_KIND: Readonly<Record<FailureKind, HttpStatus>> = {
  not_found: HttpStatus.NOT_FOUND,
  forbidden: HttpStatus.FORBIDDEN,
  unauthenticated: HttpStatus.UNAUTHORIZED,
  conflict: HttpStatus.CONFLICT,
  validation: HttpStatus.UNPROCESSABLE_ENTITY,
  precondition_failed: HttpStatus.PRECONDITION_FAILED,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
};

export interface ErrorBody {
  readonly error: {
    readonly kind: FailureKind;
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export class FailureException extends HttpException {
  constructor(public readonly failure: Failure) {
    const body: ErrorBody = {
      error: {
        kind: failure.kind,
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
      },
    };
    super(body, STATUS_BY_KIND[failure.kind]);
  }
}

/** Returns the value, or throws the mapped HTTP error. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new FailureException(result.error);
}

export function statusForKind(kind: FailureKind): HttpStatus {
  return STATUS_BY_KIND[kind];
}
