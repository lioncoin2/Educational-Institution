/**
 * The settings identity's use cases need, injected as a value.
 *
 * The module builds this from platform configuration, so no use case depends on
 * the shape of the whole application config — and a test states exactly the
 * lifetimes it is exercising.
 */
export interface IdentitySettings {
  /** Absolute lifetime of a signed-in session. Refreshing does not extend it. */
  readonly refreshSessionTtlSeconds: number;
  /** How long a loaded role → permission matrix is reused before re-reading it. */
  readonly rolePolicyCacheSeconds: number;
}

export const IDENTITY_SETTINGS = Symbol('IDENTITY_SETTINGS');
