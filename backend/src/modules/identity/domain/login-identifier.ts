import { err, failure, ok, type Result } from '../../../shared';

/**
 * What a person types to say who they are.
 *
 * Email is the only kind today, but it is modelled as one kind among several:
 * many learners at a Qur'an institution are children without an email address,
 * and an institution-issued username or a phone number are both plausible
 * later. Adding a kind is a new union member, a normalizer, and a migration
 * widening one CHECK constraint — no change to login, sessions or tokens.
 */
export type IdentifierKind = 'email';

export const IDENTIFIER_KINDS: readonly IdentifierKind[] = Object.freeze(['email']);

export interface LoginIdentifier {
  readonly kind: IdentifierKind;
  /** Always stored and compared in normalized form. */
  readonly value: string;
}

export function isIdentifierKind(value: string): value is IdentifierKind {
  return (IDENTIFIER_KINDS as readonly string[]).includes(value);
}

/** RFC 5321 limits a path to 256 octets, which caps a usable address at 254. */
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates and normalizes an identifier.
 *
 * Normalization happens once, here, and every read and write goes through it —
 * so "Teacher@Example.COM" and "teacher@example.com" are the same account, and
 * a unique constraint on the stored value is a real uniqueness guarantee.
 */
export function normalizeIdentifier(kind: IdentifierKind, raw: string): Result<LoginIdentifier> {
  switch (kind) {
    case 'email': {
      const value = raw.normalize('NFC').trim().toLowerCase();
      if (value.length === 0 || value.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(value)) {
        return err(
          failure(
            'validation',
            'identity.identifier_invalid',
            'A valid email address is required.',
          ),
        );
      }
      return ok({ kind, value });
    }
  }
}

export function sameIdentifier(a: LoginIdentifier, b: LoginIdentifier): boolean {
  return a.kind === b.kind && a.value === b.value;
}
