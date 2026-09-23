import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { PasswordHasher } from '../domain/ports';

interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** Today's cost. Raise N as hardware improves; `needsRehash` upgrades on next login. */
const CURRENT: ScryptParams = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

/**
 * Bounds for parameters read back from storage. A stored hash is data, and a
 * corrupted or tampered row must not be able to make verification throw (a
 * 500 that differs from a wrong password) or allocate gigabytes.
 */
const LIMITS = { minN: 1 << 10, maxN: 1 << 20, maxR: 32, maxP: 16 } as const;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      // Node's default 32 MiB ceiling is exceeded above N=2^15 at r=8; give
      // exactly what the parameters need, with headroom.
      { ...params, maxmem: 256 * params.N * params.r },
      (error, derived) => (error === null ? resolve(derived) : reject(error)),
    );
  });
}

/**
 * Password hashing on Node's built-in scrypt: memory-hard, no native build,
 * no third-party dependency.
 *
 * The encoded form carries its own parameters — `$scrypt$N$r$p$salt$hash` — so
 * the cost can be raised without invalidating existing hashes.
 *
 * `verify` is constant-time in the comparison and constant-WORK in every
 * failure mode: a malformed or out-of-bounds hash still costs a full hash at
 * today's parameters, so no stored value can make a wrong password answer
 * faster than any other.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scryptAsync(plaintext, salt, KEY_LENGTH, CURRENT);
    return [
      '',
      PREFIX,
      CURRENT.N,
      CURRENT.r,
      CURRENT.p,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(plaintext: string, hash: string): Promise<boolean> {
    const parsed = parse(hash);
    if (parsed === null) {
      await scryptAsync(plaintext, randomBytes(SALT_LENGTH), KEY_LENGTH, CURRENT);
      return false;
    }
    const derived = await scryptAsync(
      plaintext,
      parsed.salt,
      parsed.expected.length,
      parsed.params,
    );
    return derived.length === parsed.expected.length && timingSafeEqual(derived, parsed.expected);
  }

  needsRehash(hash: string): boolean {
    const parsed = parse(hash);
    if (parsed === null) return false; // not ours to upgrade; verify() will reject it
    const { N, r, p } = parsed.params;
    return (
      N < CURRENT.N ||
      r < CURRENT.r ||
      p < CURRENT.p ||
      parsed.expected.length < KEY_LENGTH ||
      parsed.salt.length < SALT_LENGTH
    );
  }
}

function parse(hash: string): { params: ScryptParams; salt: Buffer; expected: Buffer } | null {
  const parts = hash.split('$');
  // ['', 'scrypt', N, r, p, salt, hash]
  if (parts.length !== 7 || parts[0] !== '' || parts[1] !== PREFIX) return null;

  const [N, r, p] = [parts[2], parts[3], parts[4]].map((value) =>
    /^[0-9]{1,8}$/.test(value ?? '') ? Number(value) : Number.NaN,
  ) as [number, number, number];
  const powerOfTwo = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < LIMITS.minN || N > LIMITS.maxN) return null;
  if (!Number.isInteger(r) || r < 1 || r > LIMITS.maxR) return null;
  if (!Number.isInteger(p) || p < 1 || p > LIMITS.maxP) return null;

  const salt = Buffer.from(parts[5] ?? '', 'base64');
  const expected = Buffer.from(parts[6] ?? '', 'base64');
  if (salt.length < 8 || expected.length < 16 || expected.length > 64) return null;

  return { params: { N, r, p }, salt, expected };
}
