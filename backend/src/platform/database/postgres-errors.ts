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
