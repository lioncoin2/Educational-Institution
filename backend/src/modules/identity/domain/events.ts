import { domainEvent, type DomainEvent } from '../../../shared';

export type UserCreated = DomainEvent<
  'identity.user.created',
  { readonly userId: string; readonly email: string }
>;

export type RoleAssigned = DomainEvent<
  'identity.role.assigned',
  { readonly userId: string; readonly role: string; readonly assignedBy: string }
>;

export function userCreated(
  userId: string,
  email: string,
  at: Date,
  correlationId?: string,
): UserCreated {
  return domainEvent('identity.user.created', userId, { userId, email }, at, correlationId);
}

export function roleAssigned(
  userId: string,
  role: string,
  assignedBy: string,
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
