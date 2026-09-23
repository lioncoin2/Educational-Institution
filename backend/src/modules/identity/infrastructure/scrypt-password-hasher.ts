import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { PasswordHasher } from '../domain/ports';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** Deliberately conservative; raise N as hardware improves (see verify()). */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

/**
 * Password hashing on Node's built-in scrypt.
 *
 * Chosen over bcrypt/argon2 because it needs no native build step and no third
 * party dependency, while remaining a memory-hard KDF. The encoded form carries
 * its own parameters (`$scrypt$N$r$p$salt$hash`) so the cost can be raised later
 * without invalidating existing hashes.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scryptAsync(plaintext, salt, KEY_LENGTH, PARAMS);
    return [
      '',
      PREFIX,
      PARAMS.N,
      PARAMS.r,
      PARAMS.p,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(plaintext: string, hash: string): Promise<boolean> {
    const parsed = this.parse(hash);
    if (parsed === null) {
      // Malformed or dummy hash: still burn comparable work so a caller cannot
      // distinguish "no such user" from "wrong password" by timing.
      await scryptAsync(plaintext, randomBytes(SALT_LENGTH), KEY_LENGTH, PARAMS);
      return false;
    }

    const derived = await scryptAsync(plaintext, parsed.salt, parsed.expected.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
    if (derived.length !== parsed.expected.length) return false;
    return timingSafeEqual(derived, parsed.expected);
  }

  private parse(
    hash: string,
  ): { N: number; r: number; p: number; salt: Buffer; expected: Buffer } | null {
    const parts = hash.split('$');
    // ['', 'scrypt', N, r, p, salt, hash]
    if (parts.length !== 7 || parts[1] !== PREFIX) return null;

    const N = Number.parseInt(parts[2], 10);
    const r = Number.parseInt(parts[3], 10);
    const p = Number.parseInt(parts[4], 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return null;

    try {
      const salt = Buffer.from(parts[5], 'base64');
      const expected = Buffer.from(parts[6], 'base64');
      if (salt.length === 0 || expected.length === 0) return null;
      return { N, r, p, salt, expected };
    } catch {
      return null;
    }
  }
}
