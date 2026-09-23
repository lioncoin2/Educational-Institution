import * as crypto from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';

import { ScryptPasswordHasher } from './scrypt-password-hasher';

// node:crypto's exports cannot be spied on directly; wrap the one we care
// about so it still does the real comparison but can be counted.
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof NodeCrypto>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

describe('ScryptPasswordHasher', () => {
  const hasher = new ScryptPasswordHasher();

  it('verifies the correct password', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password, including a one-letter difference', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify('Correct horse battery staple', hash)).resolves.toBe(false);
    await expect(hasher.verify('', hash)).resolves.toBe(false);
  });

  // Identical passwords must not produce identical hashes, or the store leaks
  // which accounts share a password.
  it('salts: the same password hashes differently every time', async () => {
    const hashes = await Promise.all([1, 2, 3].map(() => hasher.hash('same-password')));
    expect(new Set(hashes).size).toBe(3);
    for (const hash of hashes)
      await expect(hasher.verify('same-password', hash)).resolves.toBe(true);
  });

  it('never embeds the plaintext in the hash', async () => {
    const hash = await hasher.hash('plaintext-marker');
    expect(hash).not.toContain('plaintext-marker');
    expect(hash).toMatch(/^\$scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('compares with timingSafeEqual, not ===', async () => {
    const compare = crypto.timingSafeEqual as jest.MockedFunction<typeof crypto.timingSafeEqual>;
    compare.mockClear();
    const hash = await hasher.hash('x-password');
    await expect(hasher.verify('x-password', hash)).resolves.toBe(true);
    await expect(hasher.verify('y-password', hash)).resolves.toBe(false);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  describe('stored hashes are data, and data can be corrupt', () => {
    const malformed = [
      '',
      'nonsense',
      '$scrypt$0$0000$0000',
      '$bcrypt$1$2$3$4$5',
      '$scrypt$0$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==', // N = 0
      '$scrypt$1000$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==', // N not a power of two
      '$scrypt$1073741824$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==', // N = 2^30: a memory bomb
      '$scrypt$16384$0$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==', // r = 0
      '$scrypt$16384$8$99$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==', // p out of bounds
      '$scrypt$16384$8$1$$aGFzaGhhc2hoYXNoaGFzaA==', // no salt
      '$scrypt$1e4$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==', // exponent notation
    ];

    it.each(malformed)('returns false for %j instead of throwing', async (hash) => {
      await expect(hasher.verify('x', hash)).resolves.toBe(false);
    });

    // Constant WORK, not just constant comparison: a malformed hash must cost
    // about what a real one does, or a wrong password could be answered faster
    // for some accounts than for others.
    it('does a full hash of work even for a malformed hash', async () => {
      const real = await hasher.hash('x');
      const time = async (hash: string) => {
        const start = process.hrtime.bigint();
        for (let i = 0; i < 3; i++) await hasher.verify('x', hash);
        return Number(process.hrtime.bigint() - start);
      };
      const genuine = await time(real);
      const bogus = await time('nonsense');
      expect(bogus).toBeGreaterThan(genuine * 0.4);
    });
  });

  describe('needsRehash', () => {
    it('is false for a hash made with current parameters', async () => {
      expect(hasher.needsRehash(await hasher.hash('x'))).toBe(false);
    });

    it('is true for weaker parameters, which still verify', async () => {
      const salt = crypto.randomBytes(16);
      const derived = crypto.scryptSync('legacy', salt, 32, { N: 1024, r: 8, p: 1 });
      const weak = [
        '',
        'scrypt',
        1024,
        8,
        1,
        salt.toString('base64'),
        derived.toString('base64'),
      ].join('$');
      expect(hasher.needsRehash(weak)).toBe(true);
      await expect(hasher.verify('legacy', weak)).resolves.toBe(true);
    });

    it('is false for a hash that is not ours', () => {
      expect(hasher.needsRehash('$bcrypt$whatever')).toBe(false);
    });
  });
});
