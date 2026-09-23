/**
 * Where a call came from.
 *
 * Carried explicitly into use cases that audit, so an audit entry can be tied
 * back to the request that produced it. It is for correlation and security
 * review only — no decision may depend on it, because a background job or an
 * event handler calling the same use case will not have it.
 */
export interface CallMetadata {
  /** The request id, returned on every error response and logged on every line. */
  readonly correlationId?: string;
  /** The client address as seen by the API (after any trusted proxy). */
  readonly ipAddress?: string;
}

export const NO_CALL_METADATA: CallMetadata = Object.freeze({});
