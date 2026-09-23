import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validateNewPassword } from './password-policy';

const codeOf = (password: string) => {
  const result = validateNewPassword(password);
  return result.ok ? 'ok' : result.error.code;
};

describe('new-password policy (provisional)', () => {
  it('accepts a password at the minimum and at the maximum', () => {
    expect(codeOf('a'.repeat(PASSWORD_MIN_LENGTH))).toBe('ok');
    expect(codeOf('a'.repeat(PASSWORD_MAX_LENGTH))).toBe('ok');
  });

  it('rejects one character either side of the bounds', () => {
    expect(codeOf('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('identity.password_too_short');
    expect(codeOf('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('identity.password_too_long');
  });

  // An Arabic passphrase is measured the way its owner counts it — by
  // characters, not by UTF-16 code units.
  it('counts characters, not code units', () => {
    const eightEmoji = '😀'.repeat(8); // 16 UTF-16 code units, 8 characters
    expect(codeOf(eightEmoji)).toBe('ok');
    expect(codeOf('😀'.repeat(7))).toBe('identity.password_too_short');
    expect(codeOf('بسم الله الرحمن')).toBe('ok');
  });

  it('rejects a password made only of whitespace', () => {
    expect(codeOf(' '.repeat(12))).toBe('identity.password_blank');
  });
});
