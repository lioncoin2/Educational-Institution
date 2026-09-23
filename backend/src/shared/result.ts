/**
 * The outcome of a use case.
 *
 * Use cases return a Result instead of throwing for *expected* failures
 * (not found, forbidden, conflict). Exceptions stay reserved for genuine
 * faults. The API layer maps failure codes onto HTTP status codes in one
 * place, so transport concerns never leak inward.
 */
export type Result<T, E = Failure> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** The closed set of expected failure kinds the API layer knows how to map. */
export type FailureKind =
  | 'not_found'
  | 'forbidden'
  | 'unauthenticated'
  | 'conflict'
  | 'validation'
  | 'precondition_failed'
  | 'rate_limited'
  /**
   * A dependency the use case needs right now — the media provider, for
   * instance — cannot be reached. Nothing was changed; the caller may retry.
   * Distinct from a fault: the system knows exactly what went wrong, and the
   * client gets a stable code instead of an opaque 500.
   */
  | 'unavailable';

export interface Failure {
  readonly kind: FailureKind;
  /** Stable, machine-readable code, e.g. `identity.user_not_found`. */
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function failure(
  kind: FailureKind,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Failure {
  return { kind, code, message, details };
}
