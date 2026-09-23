import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SecureTokenGenerator } from '../domain/ports';

const SECRET_BYTES = 32;

/**
 * Refresh-token secrets and their hashes.
 *
 * A secret is 256 random bits, so a fast hash is the right tool: there is
 * nothing to brute-force, and a slow KDF would only cost every refresh. SHA-256
 * makes a stolen database useless for refreshing — the hashes cannot be turned
 * back into tokens — which is the property that matters.
 */
export class CryptoSecureTokenGenerator implements SecureTokenGenerator {
  generateSecret(): string {
    return randomBytes(SECRET_BYTES).toString('base64url');
  }

  hash(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  matches(secret: string, hash: string): boolean {
    const actual = Buffer.from(this.hash(secret), 'hex');
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
