import { err, failure, ok, type Id, type Result } from '../../../shared';
import { AccountStatuses, canTransition, type AccountStatus } from './account-status';
import { sameIdentifier, type LoginIdentifier } from './login-identifier';
import type { RoleCode } from './role';

export type UserId = Id<'User'>;

/** A role held by a user, with who granted it and when — role changes are audited. */
export interface RoleAssignment {
  readonly role: RoleCode;
  readonly grantedAt: Date;
  /** Null when granted by provisioning (bootstrap) rather than by a person. */
  readonly grantedBy: string | null;
}

/**
 * An account: something that can authenticate.
 *
 * Deliberately thin. Identity owns *who may sign in and what they may do*.
 * Everything about a person as a learner or a teacher (profile, guardians,
 * enrolment, progress) belongs to People and Academic, keyed by this id.
 *
 * Immutable: every change returns a new User, so a use case can validate the
 * whole transition before anything is persisted.
 */
export interface User {
  readonly id: UserId;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly identifiers: readonly LoginIdentifier[];
  readonly roles: readonly RoleAssignment[];
  readonly passwordHash: string;
  readonly passwordChangedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const DISPLAY_NAME_MAX_LENGTH = 120;

export interface NewUser {
  readonly id: UserId;
  readonly displayName: string;
  readonly identifier: LoginIdentifier;
  readonly passwordHash: string;
  readonly at: Date;
}

/** Accounts start PENDING: provisioning is create → assign roles → activate. */
export function createUser(input: NewUser): Result<User> {
  const displayName = input.displayName.normalize('NFC').trim();
  if (displayName.length === 0 || [...displayName].length > DISPLAY_NAME_MAX_LENGTH) {
    return err(
      failure(
        'validation',
        'identity.display_name_invalid',
        `A display name of 1–${DISPLAY_NAME_MAX_LENGTH} characters is required.`,
      ),
    );
  }

  return ok({
    id: input.id,
    displayName,
    status: AccountStatuses.pending,
    identifiers: [input.identifier],
    roles: [],
    passwordHash: input.passwordHash,
    passwordChangedAt: input.at,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

export function roleCodes(user: User): readonly RoleCode[] {
  return user.roles.map((assignment) => assignment.role);
}

export function hasRole(user: User, role: RoleCode): boolean {
  return user.roles.some((assignment) => assignment.role === role);
}

export function hasIdentifier(user: User, identifier: LoginIdentifier): boolean {
  return user.identifiers.some((existing) => sameIdentifier(existing, identifier));
}

export function changeStatus(user: User, to: AccountStatus, at: Date): Result<User> {
  if (user.status === to) {
    return err(failure('conflict', 'identity.status_unchanged', `The account is already ${to}.`));
  }
  if (!canTransition(user.status, to)) {
    return err(
      failure(
        'conflict',
        'identity.status_transition_invalid',
        `An account cannot move from ${user.status} to ${to}.`,
        { from: user.status, to },
      ),
    );
  }
  return ok({ ...user, status: to, updatedAt: at });
}

export function assignRole(
  user: User,
  role: RoleCode,
  grantedBy: string | null,
  at: Date,
): Result<User> {
  if (hasRole(user, role)) {
    return err(
      failure('conflict', 'identity.role_already_assigned', `The account already holds ${role}.`),
    );
  }
  return ok({
    ...user,
    roles: [...user.roles, { role, grantedAt: at, grantedBy }],
    updatedAt: at,
  });
}

export function revokeRole(user: User, role: RoleCode, at: Date): Result<User> {
  if (!hasRole(user, role)) {
    return err(
      failure('not_found', 'identity.role_not_assigned', `The account does not hold ${role}.`),
    );
  }
  return ok({
    ...user,
    roles: user.roles.filter((assignment) => assignment.role !== role),
    updatedAt: at,
  });
}

export function changePasswordHash(user: User, passwordHash: string, at: Date): User {
  return { ...user, passwordHash, passwordChangedAt: at, updatedAt: at };
}

/**
 * Replaces the stored hash with a stronger one of the SAME password (the
 * hashing parameters were raised since it was set). Not a password change, so
 * `passwordChangedAt` stays put and no session is ended.
 */
export function rehashPassword(user: User, passwordHash: string, at: Date): User {
  return { ...user, passwordHash, updatedAt: at };
}
