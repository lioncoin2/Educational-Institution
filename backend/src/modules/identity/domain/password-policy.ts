import { err, failure, ok, type Result } from '../../../shared';

/**
 * Rules for a NEW password — applied when one is set, never when one is used.
 *
 * Login deliberately does not apply these: a password that predates a policy
 * change must still work, and a login form that answers "too short" has
 * confirmed the policy to someone who did not know it.
 *
 * The floor of 8 follows NIST SP 800-63B's minimum for user-chosen secrets; the
 * ceiling of 128 exceeds its "at least 64" while bounding hashing work per
 * request. Both are PROVISIONAL — the institution may want a higher floor, and
 * a breached-password check is deferred (open-questions.md, Q14).
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function validateNewPassword(password: string): Result<void> {
  // Count characters, not UTF-16 code units: an Arabic passphrase must be
  // measured the way its owner would count it.
  const length = [...password].length;

  if (length < PASSWORD_MIN_LENGTH) {
    return err(
      failure(
        'validation',
        'identity.password_too_short',
        `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
      ),
    );
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return err(
      failure(
        'validation',
        'identity.password_too_long',
        `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
      ),
    );
  }
  if (password.trim().length === 0) {
    return err(
      failure('validation', 'identity.password_blank', 'Password cannot be only whitespace.'),
    );
  }
  return ok(undefined);
}
