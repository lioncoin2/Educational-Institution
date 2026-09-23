/**
 * Entity identifiers.
 *
 * Ids are opaque strings at the type level so a StudentId can never be passed
 * where a HalaqaId is expected. Generation is a port (see `IdGenerator`) because
 * the domain must not reach for `crypto` or a uuid package itself.
 */
declare const brand: unique symbol;

export type Id<TBrand extends string> = string & { readonly [brand]: TBrand };

export function asId<TBrand extends string>(value: string): Id<TBrand> {
  return value as Id<TBrand>;
}

/** Generates identifiers. Implemented in platform, injected into the domain. */
export interface IdGenerator {
  next<TBrand extends string>(): Id<TBrand>;
}
