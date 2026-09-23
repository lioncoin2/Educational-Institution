import { ScryptPasswordHasher } from './scrypt-password-hasher';

describe('ScryptPasswordHasher', () => {
  const hasher = new ScryptPasswordHasher();

  it('verifies a password against its own hash', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify('Correct horse battery staple', hash)).resolves.toBe(false);
  });

  // Same input, different salt: identical passwords must not produce identical
  // hashes, or the store leaks which accounts share a password.
  it('salts, so the same password hashes differently each time', async () => {
    const a = await hasher.hash('same-password');
    const b = await hasher.hash('same-password');
    expect(a).not.toEqual(b);
    await expect(hasher.verify('same-password', a)).resolves.toBe(true);
    await expect(hasher.verify('same-password', b)).resolves.toBe(true);
  });

  it('encodes its parameters so the cost can be raised later', async () => {
    const hash = await hasher.hash('x');
    expect(hash.startsWith('$scrypt$')).toBe(true);
    expect(hash.split('$')).toHaveLength(7);
  });

  // The login use case deliberately verifies against a dummy hash when no user
  // exists; that must return false rather than throw.
  it('returns false for a malformed hash instead of throwing', async () => {
    for (const bad of ['', 'nonsense', '$scrypt$0$0000$0000', '$bcrypt$1$2$3$4$5']) {
      await expect(hasher.verify('x', bad)).resolves.toBe(false);
    }
  });
});
