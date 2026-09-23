import { REFRESH_SECRET_SHAPE } from '../domain/refresh-token';
import { CryptoSecureTokenGenerator } from './crypto-secure-token-generator';

describe('CryptoSecureTokenGenerator', () => {
  const generator = new CryptoSecureTokenGenerator();

  it('produces secrets in exactly the shape the refresh-token parser accepts', () => {
    for (let i = 0; i < 50; i++) expect(generator.generateSecret()).toMatch(REFRESH_SECRET_SHAPE);
  });

  it('never repeats a secret', () => {
    const secrets = new Set(Array.from({ length: 1000 }, () => generator.generateSecret()));
    expect(secrets.size).toBe(1000);
  });

  it('hashes deterministically and one-way', () => {
    const secret = generator.generateSecret();
    expect(generator.hash(secret)).toBe(generator.hash(secret));
    expect(generator.hash(secret)).not.toContain(secret);
    expect(generator.hash(secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches only the secret that produced the hash', () => {
    const secret = generator.generateSecret();
    const hash = generator.hash(secret);
    expect(generator.matches(secret, hash)).toBe(true);
    expect(generator.matches(generator.generateSecret(), hash)).toBe(false);
    expect(generator.matches(secret, 'not-hex')).toBe(false);
    expect(generator.matches(secret, '')).toBe(false);
  });
});
