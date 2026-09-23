import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { Params } from 'nestjs-pino';

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
      serializers: { req: serializeRequest },
    },
  };
}
