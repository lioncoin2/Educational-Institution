import type { Id } from '../../../shared';

export type UserId = Id<'User'>;

export type UserStatus = 'active' | 'suspended' | 'invited';

/**
 * A person who can authenticate.
 *
 * Deliberately thin: identity owns *who you are and what you may do*. Everything
 * about a person as a learner or a teacher (enrolment, halaqat, progress) is
 * owned by the People and Academic modules and keyed by this id.
 */
export interface User {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly roles: readonly string[];
  readonly passwordHash: string;
  readonly createdAt: Date;
}

export function isActive(user: User): boolean {
  return user.status === 'active';
}
