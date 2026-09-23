import { domainEvent, type DomainEvent } from '../../../shared';
import type { AccountStatus } from './account-status';

/**
 * Identity's domain events.
 *
 * Payloads carry ids and codes only — never an email or a name. An event is
 * copied into every subscriber's storage, so personal data in a payload would
 * spread to every module that listens.
 */
export type UserCreated = DomainEvent<'identity.user.created', { readonly userId: string }>;

export type RoleAssigned = DomainEvent<
  'identity.role.assigned',
  { readonly userId: string; readonly role: string; readonly assignedBy: string | null }
>;

export type RoleRevoked = DomainEvent<
  'identity.role.revoked',
  { readonly userId: string; readonly role: string; readonly revokedBy: string }
>;

export type AccountStatusChanged = DomainEvent<
  'identity.account.status_changed',
  {
    readonly userId: string;
    readonly from: AccountStatus;
    readonly to: AccountStatus;
    readonly changedBy: string;
  }
>;

export function userCreated(userId: string, at: Date, correlationId?: string): UserCreated {
  return domainEvent('identity.user.created', userId, { userId }, at, correlationId);
}

export function roleAssigned(
  userId: string,
  role: string,
  assignedBy: string | null,
  at: Date,
  correlationId?: string,
): RoleAssigned {
  return domainEvent(
    'identity.role.assigned',
    userId,
    { userId, role, assignedBy },
    at,
    correlationId,
  );
}

export function roleRevoked(
  userId: string,
  role: string,
  revokedBy: string,
  at: Date,
  correlationId?: string,
): RoleRevoked {
  return domainEvent(
    'identity.role.revoked',
    userId,
    { userId, role, revokedBy },
    at,
    correlationId,
  );
}

export function accountStatusChanged(
  userId: string,
  from: AccountStatus,
  to: AccountStatus,
  changedBy: string,
  at: Date,
  correlationId?: string,
): AccountStatusChanged {
  return domainEvent(
    'identity.account.status_changed',
    userId,
    { userId, from, to, changedBy },
    at,
    correlationId,
  );
}
