import { normalizeIdentifier, sameIdentifier } from './login-identifier';

describe('login identifier', () => {
  it('normalizes case and surrounding whitespace', () => {
    const result = normalizeIdentifier('email', '  Teacher@Example.COM ');
    expect(result.ok && result.value).toEqual({ kind: 'email', value: 'teacher@example.com' });
  });

  it('normalizes Unicode to NFC, so visually identical addresses are one account', () => {
    const composed = normalizeIdentifier('email', 'jérôme@example.com');
    const decomposed = normalizeIdentifier('email', 'jérôme@example.com');
    expect(composed.ok && decomposed.ok && sameIdentifier(composed.value, decomposed.value)).toBe(
      true,
    );
  });

  it.each(['', '   ', 'no-at-sign', 'two@@example.com', 'spaces in@example.com', 'x@nodot'])(
    'rejects %j',
    (raw) => {
      const result = normalizeIdentifier('email', raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('identity.identifier_invalid');
    },
  );

  it('rejects an address longer than SMTP allows', () => {
    expect(normalizeIdentifier('email', `${'a'.repeat(250)}@example.com`).ok).toBe(false);
  });
});
