import { randomUUID } from 'node:crypto';

import { asId, type Id, type IdGenerator } from '../../shared';

export { ID_GENERATOR } from '../../shared';

/**
 * Identifiers are generated here, in platform, because the domain is not allowed
 * to import `node:crypto` — it depends on the `IdGenerator` port instead.
 */
export class UuidIdGenerator implements IdGenerator {
  next<TBrand extends string>(): Id<TBrand> {
    return asId<TBrand>(randomUUID());
  }
}
