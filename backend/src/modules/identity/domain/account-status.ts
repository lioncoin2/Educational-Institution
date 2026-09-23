import { failure, type Failure } from '../../../shared';

/**
 * The lifecycle of an account.
 *
 *   PENDING    created by staff, never yet usable
 *   ACTIVE     may authenticate
 *   SUSPENDED  temporarily barred; expected to return
 *   DISABLED   switched off
 *
 * Only ACTIVE may authenticate. PENDING exists because provisioning is
 * create → assign roles → activate: without it, "not yet switched on" would
 * have to be stored as DISABLED, and the current state could no longer tell a
 * brand-new account from one an administrator deliberately turned off.
 *
 * What SUSPENDED and DISABLED *mean* to the institution — and who may move an
 * account between them — is policy, recorded in open-questions.md (Q13). This
 * file only fixes which moves are mechanically coherent.
 */
export const AccountStatuses = {
  pending: 'PENDING',
  active: 'ACTIVE',
  suspended: 'SUSPENDED',
  disabled: 'DISABLED',
} as const;

export type AccountStatus = (typeof AccountStatuses)[keyof typeof AccountStatuses];

export const ALL_ACCOUNT_STATUSES: readonly AccountStatus[] = Object.freeze(
  Object.values(AccountStatuses),
);

const ALLOWED_TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  PENDING: ['ACTIVE', 'DISABLED'],
  ACTIVE: ['SUSPENDED', 'DISABLED'],
  SUSPENDED: ['ACTIVE', 'DISABLED'],
  // Re-enabling is allowed mechanically. Whether the institution permits it is
  // governed by who holds `users.manage`, not by making the state a dead end.
  DISABLED: ['ACTIVE'],
};

export function isAccountStatus(value: string): value is AccountStatus {
  return (ALL_ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function canAuthenticate(status: AccountStatus): boolean {
  return status === AccountStatuses.active;
}

/**
 * Moving to one of these ends every session the account holds. A suspended
 * user keeping a live refresh token would make suspension decorative.
 */
export function endsSessions(to: AccountStatus): boolean {
  return to === AccountStatuses.suspended || to === AccountStatuses.disabled;
}

/**
 * The safe error for an account that may not sign in.
 *
 * Only ever returned AFTER the password has been verified — so it tells the
 * account's owner why they cannot get in, and tells nobody else anything.
 */
export function authenticationRejection(status: AccountStatus): Failure | null {
  switch (status) {
    case AccountStatuses.active:
      return null;
    case AccountStatuses.pending:
      return failure(
        'forbidden',
        'identity.account_pending',
        'This account has not been activated yet.',
      );
    case AccountStatuses.suspended:
      return failure('forbidden', 'identity.account_suspended', 'This account is suspended.');
    case AccountStatuses.disabled:
      return failure('forbidden', 'identity.account_disabled', 'This account is disabled.');
  }
}
