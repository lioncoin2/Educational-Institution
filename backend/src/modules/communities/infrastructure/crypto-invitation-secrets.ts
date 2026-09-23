import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { InvitationSecrets } from '../domain/invitation';

/**
 * Invitation tokens: 32 random bytes from the operating system's CSPRNG, as
 * base64url — 43 characters, 256 bits. Only the SHA-256 hex digest is ever
 * stored: a 256-bit secret needs neither a slow KDF nor a salt, and a lookup
 * needs a deterministic hash (the reasoning of identity's refresh secrets,
 * reimplemented here because identity's generator is internal to it).
 */
@Injectable()
export class CryptoInvitationSecrets implements InvitationSecrets {
  issue(): { readonly token: string; readonly tokenHash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }
}
