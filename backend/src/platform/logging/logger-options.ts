import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { Params } from 'nestjs-pino';
import pino from 'pino';

import type { AppConfig } from '../config/app-config';

/** Field names that never reach a log sink, at any depth up to four. */
const SENSITIVE_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'initialPassword',
  'passwordHash',
  'refreshToken',
  'refreshTokenHash',
  'previousRefreshTokenHash',
  'accessToken',
  'token',
  // A push provider's address for a device: not a credential, but never
  // logged either (notifications.md, "Devices").
  'pushToken',
  'deviceToken',
  'secret',
  'jwtSecret',
  'apiSecret',
  'signingSecret',
] as const;

/**
 * Query parameters that carry a capability. A signed storage URL is a bearer
 * credential until it expires: whoever reads it from a log could use it.
 */
const SENSITIVE_QUERY_PARAMS = /([?&](?:sig|signature|token|access_token)=)[^&#]*/gi;

/** The URL with every capability-bearing query value replaced. */
export function redactUrl(url: string): string {
  return url.replace(SENSITIVE_QUERY_PARAMS, '$1[redacted]');
}

interface SerializedRequest {
  url?: unknown;
  query?: unknown;
  [key: string]: unknown;
}

/**
 * pino's standard request serializer records the full URL and the parsed
 * query. Path-and-key redaction cannot reach inside a URL string, so the
 * request is rewritten here — on a copy: `query` is the live request's object.
 */
export function serializeRequest(req: SerializedRequest): SerializedRequest {
  const out: SerializedRequest = { ...req };
  if (typeof req.url === 'string') out.url = redactUrl(req.url);
  if (typeof req.query === 'object' && req.query !== null) {
    const query: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
    for (const key of Object.keys(query)) {
      if (/^(sig|signature|token|access_token)$/i.test(key)) query[key] = '[redacted]';
    }
    out.query = query;
  }
  return out;
}

/**
 * Paths censored in every log line.
 *
 * pino's `*` matches exactly ONE level: `*.password` catches
 * `{ command: { password } }` but not `{ password }` at the top, nor
 * `{ config: { auth: { jwtSecret } } }` two levels down. Each key is therefore
 * listed at every depth from zero to three — a test logs each shape and fails
 * if any secret survives.
 *
 * Request bodies are not logged at all; this is the defence for the day
 * someone logs an object that happens to contain one.
 */
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
];

/**
 * Error fields that carry the VALUES a failed statement was run with, or rows
 * it touched: Drizzle's `params`; Postgres' `detail` ("Key (token_hash)=(…)
 * already exists", "Failing row contains (…)"), `where` and `internalQuery`.
 */
const VALUE_BEARING_ERROR_FIELDS = ['params', 'parameters', 'detail', 'where', 'internalQuery'];

interface SerializedError {
  message?: unknown;
  stack?: unknown;
  aggregateErrors?: unknown;
  [key: string]: unknown;
}

/**
 * Errors as pino records them — minus every bind value. A failed Drizzle
 * query's message is `Failed query: <sql>\nparams: <values>`, and pino copies
 * that message into both `message` and `stack`, and its enumerable `params`
 * as a field: a statement timeout during a sign-in or a link redemption would
 * otherwise write a refresh-token hash or an invitation-token hash to the
 * log. The SQL (with its `$n` placeholders) and the SQLSTATE stay: they are
 * what an operator needs, and they hold no value.
 */
export function serializeError(error: unknown): unknown {
  const serialized = pino.stdSerializers.err(error as Error) as unknown;
  if (serialized === error || typeof serialized !== 'object' || serialized === null) {
    return serialized;
  }
  return scrubError(serialized as SerializedError, error);
}

function scrubError(serialized: SerializedError, raw: unknown): SerializedError {
  const params = (raw as { params?: unknown } | null)?.params;
  if (Array.isArray(params)) {
    // Exactly the text Drizzle's constructor appended: `${params}` renders an
    // array as String(array) does. The values may contain newlines.
    const appended = `params: ${String(params)}`;
    for (const field of ['message', 'stack'] as const) {
      const text = serialized[field];
      if (typeof text === 'string')
        serialized[field] = text.split(appended).join('params: [redacted]');
    }
  }
  for (const field of VALUE_BEARING_ERROR_FIELDS) delete serialized[field];
  if (Array.isArray(serialized.aggregateErrors)) {
    const raws = (raw as { errors?: unknown[] } | null)?.errors ?? [];
    serialized.aggregateErrors = (serialized.aggregateErrors as unknown[]).map(
      (inner: unknown, index: number): unknown =>
        typeof inner === 'object' && inner !== null
          ? scrubError(inner as SerializedError, raws[index])
          : inner,
    );
  }
  return serialized;
}

export function loggerOptions(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      // Correlates every log line of one request; also returned on errors.
      genReqId: (req: IncomingMessage) => {
        const inbound = req.headers['x-request-id'];
        // An inbound id is honoured only if it looks like one, so a client
        // cannot inject arbitrary text into every log line of its request.
        return typeof inbound === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(inbound)
          ? inbound
          : randomUUID();
      },
      redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
      serializers: { req: serializeRequest, err: serializeError },
    },
  };
}
