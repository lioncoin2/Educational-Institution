import { err, failure, ok, type Result } from '../../../shared/result';
import type { InvitationState } from '../contracts/vocabulary';

/**
 * An invitation link (§3.3, §7). The bearer token is never stored: only its
 * SHA-256, under a unique index. Its state is derived from the row and the
 * clock, never stored — only revocation, a human act, is.
 */
export interface Invitation {
  readonly id: string;
  readonly communityId: string;
  /** 64 lowercase hex characters: SHA-256 of the 43-character token. */
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** Null means unlimited until expiry. */
  readonly maxUses: number | null;
  /** Rises only in the transaction that creates an INVITATION stint. */
  readonly uses: number;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
}

/**
 * The derived state, in precedence order: REVOKED, then EXPIRED
 * (`now ≥ expiresAt`), then EXHAUSTED (`uses ≥ maxUses`), then ACTIVE.
 * "Suspended" — the community is LOCKED — is a redemption-time condition,
 * not a state: the link is neither consumed nor revoked.
 */
export function invitationState(invitation: Invitation, now: Date): InvitationState {
  if (invitation.revokedAt !== null) return 'REVOKED';
  if (now.getTime() >= invitation.expiresAt.getTime()) return 'EXPIRED';
  if (invitation.maxUses !== null && invitation.uses >= invitation.maxUses) return 'EXHAUSTED';
  return 'ACTIVE';
}

/**
 * PROVISIONAL terms (Q48): a link must expire — 7 days unless asked
 * otherwise, never sooner than 5 minutes or later than 30 days — and may be
 * limited to a number of uses. The use bound is Postgres' integer range, not
 * a policy.
 */
export const InvitationTerms = Object.freeze({
  defaultExpiresInSeconds: 7 * 24 * 60 * 60,
  minExpiresInSeconds: 5 * 60,
  maxExpiresInSeconds: 30 * 24 * 60 * 60,
  maxUsesMax: 2_147_483_647,
});

export interface ValidTerms {
  readonly expiresInSeconds: number;
  readonly maxUses: number | null;
}

const termsInvalid = (field: 'expiresInSeconds' | 'maxUses', message: string) =>
  err(failure('validation', 'communities.invitation_terms_invalid', message, { field }));

export function validateTerms(requested: {
  readonly expiresInSeconds?: number;
  readonly maxUses?: number | null;
}): Result<ValidTerms> {
  const expiresInSeconds = requested.expiresInSeconds ?? InvitationTerms.defaultExpiresInSeconds;
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < InvitationTerms.minExpiresInSeconds ||
    expiresInSeconds > InvitationTerms.maxExpiresInSeconds
  ) {
    return termsInvalid(
      'expiresInSeconds',
      `A link expires in ${InvitationTerms.minExpiresInSeconds} to ${InvitationTerms.maxExpiresInSeconds} seconds.`,
    );
  }
  const maxUses = requested.maxUses ?? null;
  if (
    maxUses !== null &&
    (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > InvitationTerms.maxUsesMax)
  ) {
    return termsInvalid('maxUses', 'A use limit is a whole number from 1, or none.');
  }
  return ok({ expiresInSeconds, maxUses });
}

/**
 * A token as issued: 32 random bytes in base64url, 43 characters. Anything
 * else is answered exactly like an unknown token, before any lookup.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function isTokenShaped(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

/** A stored hash: what the unique index holds. */
export const TOKEN_HASH_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Issues link tokens (an internal port: the domain may not reach for
 * `node:crypto`). A token is shown once — in the response that creates the
 * link — and then only its hash exists.
 */
export interface InvitationSecrets {
  issue(): { readonly token: string; readonly tokenHash: string };
  hash(token: string): string;
}

export const INVITATION_SECRETS = Symbol('INVITATION_SECRETS');
