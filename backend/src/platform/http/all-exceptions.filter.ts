import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Status boundaries as plain numbers.
 *
 * `exception.getStatus()` returns `number`, and comparing a number against an
 * enum member is exactly the kind of accidental equivalence that goes wrong
 * when the enum changes. These are HTTP's own constants, not ours.
 */
const SERVER_ERROR = 500;

/**
 * Framework-generated errors mapped back into the vocabulary use cases speak.
 *
 * Nest throws its own exceptions — from guards, pipes, and the router's 404 —
 * and their payloads carry Nest's shape, not ours. Without this the API has two
 * error formats: one for failures the domain names, another for everything
 * else, differing exactly where a client is least able to cope.
 *
 * The codes deliberately mirror `FailureKind`, so `identity.permission_denied`
 * and a guard's bare 403 read the same way to a caller.
 */
const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'validation',
  429: 'rate_limited',
};

/** Our own shape, already built by `FailureException`. */
interface WrappedError {
  readonly error: Readonly<Record<string, unknown>>;
}

function isWrappedError(payload: unknown): payload is WrappedError {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return false;
  // Nest's own exceptions also carry `error`, but as a string ("Not Found").
  // Only an object is ours.
  const { error } = payload;
  return typeof error === 'object' && error !== null;
}

/**
 * One error shape for the whole API.
 *
 * Expected failures arrive already mapped (see `FailureException`). Anything
 * else is a fault: it is logged with the request id and returned as an opaque
 * 500, so internal messages and stack traces never reach a client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? 'unknown';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = this.normalize(exception.getResponse(), status);

      if (status >= SERVER_ERROR) {
        this.logger.error({ requestId, status, err: exception }, 'request failed');
      }
      response.status(status).json({ ...body, requestId });
      return;
    }

    // A fault, not a failure. The client learns only that something broke; the
    // detail goes to the log, correlated by request id.
    this.logger.error({ requestId, err: exception }, 'unhandled exception');
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'internal_error', message: 'An unexpected error occurred.' },
      requestId,
    });
  }

  /** Normalizes Nest's varied exception payloads into the single error shape. */
  private normalize(payload: unknown, status: number): WrappedError {
    if (isWrappedError(payload)) return payload;

    const raw =
      typeof payload === 'string'
        ? payload
        : ((payload as { message?: unknown } | null)?.message ?? 'Request failed');

    // ValidationPipe reports one string per offending field; everything else is
    // a single message.
    const issues = Array.isArray(raw) ? raw.map(describe) : null;

    return {
      error: {
        code: CODE_BY_STATUS[status] ?? 'request_failed',
        message: issues ? issues.join('; ') : describe(raw),
        ...(issues ? { details: { issues } } : {}),
      },
    };
  }
}

/**
 * Stringifies a value of unknown type without ever producing "[object Object]".
 * Whatever Nest hands us here ends up in a response body, so it has to be
 * readable rather than merely defined.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined) return 'Request failed';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return 'Request failed';
    }
  }
  // Narrow positively: TypeScript cannot subtract types from `unknown`, so the
  // primitives have to be named for `String()` to be provably safe here.
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return 'Request failed';
}
