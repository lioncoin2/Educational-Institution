/**
 * Recognizes a Postgres unique violation on a named constraint, whether the
 * driver error arrives bare or wrapped by Drizzle.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error, depth = 0; current !== null && depth < 4; depth++) {
    if (typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === constraint) return true;
    current = candidate.cause ?? null;
  }
  return false;
}

/**
 * The SQLSTATE of a Postgres error, whether the driver error arrives bare or
 * wrapped by Drizzle — e.g. `40P01` for a deadlock victim.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current !== null && depth < 4; depth++) {
    if (typeof current !== 'object') return undefined;
    const candidate = current as { code?: unknown; severity?: unknown; cause?: unknown };
    // A server error carries a severity; a socket error's code (EPIPE) does not.
    if (
      typeof candidate.code === 'string' &&
      typeof candidate.severity === 'string' &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      return candidate.code;
    }
    current = candidate.cause ?? null;
  }
  return undefined;
}

/**
 * SQLSTATEs that mean "the database cannot serve this now" rather than "this
 * statement is wrong": the connection-exception class (08), an administrator
 * or crash shutdown, the server still starting (57P01–57P03), and too many
 * connections (53300).
 */
const UNAVAILABLE_SQLSTATE = /^(08|57P0[1-3]$|53300$)/;

/** Socket-level failures: nothing answered, or the answer was cut off. */
const UNAVAILABLE_SOCKET = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

/** The pool's own words when no connection could be had, or one died mid-query. */
const UNAVAILABLE_MESSAGE =
  /timeout exceeded when trying to connect|connection terminated|terminating connection/i;

/**
 * Whether an error means the database could not be reached or could not
 * serve the request — an outage the caller may retry, not a fault in the
 * request. Walks Drizzle's wrapping like the functions above.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  const code = postgresErrorCode(error);
  if (code !== undefined) return UNAVAILABLE_SQLSTATE.test(code);
  for (let current: unknown = error, depth = 0; current !== null && depth < 4; depth++) {
    if (typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && UNAVAILABLE_SOCKET.has(candidate.code)) return true;
    if (typeof candidate.message === 'string' && UNAVAILABLE_MESSAGE.test(candidate.message)) {
      return true;
    }
    current = candidate.cause ?? null;
  }
  return false;
}
