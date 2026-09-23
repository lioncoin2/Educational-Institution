import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';

import { failure } from '../../shared';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { FailureException } from './http-failure';

interface Captured {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Every error response in the system passes through this filter, so it is worth
 * testing directly rather than inferring its behaviour from endpoint tests.
 */
// `null` means "the request carries no id" — an explicit `undefined` would just
// re-trigger the default parameter and silently test nothing.
function run(exception: unknown, requestId: string | null = 'req-1'): Captured {
  let status = 0;
  let body: Record<string, unknown> = {};

  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ id: requestId ?? undefined }),
    }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);
  return { status, body };
}

const errorOf = (body: Record<string, unknown>): Record<string, unknown> =>
  body.error as Record<string, unknown>;

describe('AllExceptionsFilter', () => {
  // The filter logs faults, by design. Silencing it here keeps a deliberate
  // failure case from printing a real stack trace into a passing suite, where
  // it reads like something went wrong.
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('passes a mapped domain failure through unchanged', () => {
    const { status, body } = run(
      new FailureException(failure('forbidden', 'identity.permission_denied', 'Nope.')),
    );

    expect(status).toBe(HttpStatus.FORBIDDEN);
    expect(errorOf(body)).toEqual({
      kind: 'forbidden',
      code: 'identity.permission_denied',
      message: 'Nope.',
    });
    expect(body.requestId).toBe('req-1');
  });

  // The bug this test exists for: Nest's own exceptions carry `error` as a
  // STRING ("Not Found"), which a naive `'error' in payload` check mistakes for
  // our shape — leaving the API with two different error formats.
  it('normalizes a framework exception into the single error shape', () => {
    const { status, body } = run(new NotFoundException('No such room.'));

    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(errorOf(body)).toEqual({ code: 'not_found', message: 'No such room.' });
    expect(body.statusCode).toBeUndefined();
  });

  it('maps framework statuses onto the domain failure vocabulary', () => {
    expect(errorOf(run(new ForbiddenException()).body).code).toBe('forbidden');
    expect(errorOf(run(new HttpException('x', 401)).body).code).toBe('unauthenticated');
    expect(errorOf(run(new HttpException('x', 409)).body).code).toBe('conflict');
    expect(errorOf(run(new HttpException('x', 429)).body).code).toBe('rate_limited');
    // An unmapped status still produces our shape, never Nest's.
    expect(errorOf(run(new HttpException('x', 418)).body).code).toBe('request_failed');
  });

  it('collapses ValidationPipe messages into one message and keeps the detail', () => {
    const { status, body } = run(
      new HttpException(
        { message: ['email must be an email', 'password is too short'], error: 'Bad Request' },
        HttpStatus.BAD_REQUEST,
      ),
    );

    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(errorOf(body).code).toBe('bad_request');
    expect(errorOf(body).message).toBe('email must be an email; password is too short');
    expect(errorOf(body).details).toEqual({
      issues: ['email must be an email', 'password is too short'],
    });
  });

  // A fault must never leak its cause to a client.
  it('returns an opaque 500 for an unrecognized exception', () => {
    const { status, body } = run(new Error('connection string postgres://user:hunter2@db'));

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(errorOf(body)).toEqual({
      code: 'internal_error',
      message: 'An unexpected error occurred.',
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('never renders an object payload as "[object Object]"', () => {
    const { body } = run(new HttpException({ message: { nested: 'detail' } }, 400));

    expect(errorOf(body).message).not.toContain('[object Object]');
    expect(errorOf(body).message).toBe('{"nested":"detail"}');
  });

  it('falls back to a placeholder request id rather than omitting it', () => {
    expect(run(new NotFoundException(), null).body.requestId).toBe('unknown');
  });

  it('always includes the request id, on every path', () => {
    expect(run(new Error('boom')).body.requestId).toBe('req-1');
    expect(run(new NotFoundException()).body.requestId).toBe('req-1');
  });
});
