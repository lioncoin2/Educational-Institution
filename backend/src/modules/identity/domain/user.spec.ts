import { asId } from '../../../shared';
import {
  assignRole,
  changePasswordHash,
  changeStatus,
  createUser,
  rehashPassword,
  revokeRole,
  type User,
} from './user';

const AT = new Date('2026-09-01T08:00:00Z');
const LATER = new Date('2026-09-02T08:00:00Z');

function newUser(displayName = 'Amina'): User {
  const created = createUser({
    id: asId<'User'>('u-1'),
    displayName,
    identifier: { kind: 'email', value: 'amina@example.com' },
    passwordHash: 'hash',
    at: AT,
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

describe('user', () => {
  it('starts PENDING with no roles', () => {
    const user = newUser();
    expect(user.status).toBe('PENDING');
    expect(user.roles).toEqual([]);
  });

  it('rejects an empty or over-long display name', () => {
    for (const name of ['', '   ', 'x'.repeat(121)]) {
      const created = createUser({
        id: asId<'User'>('u'),
        displayName: name,
        identifier: { kind: 'email', value: 'a@b.co' },
        passwordHash: 'h',
        at: AT,
      });
      expect(created.ok).toBe(false);
    }
  });

  it('records who granted a role and when', () => {
    const result = assignRole(newUser(), 'TEACHER', 'admin-1', LATER);
    expect(result.ok && result.value.roles).toEqual([
      { role: 'TEACHER', grantedAt: LATER, grantedBy: 'admin-1' },
    ]);
  });

  it('refuses to assign a role twice or revoke one not held', () => {
    const teacher = assignRole(newUser(), 'TEACHER', null, AT);
    if (!teacher.ok) throw new Error('setup');
    const again = assignRole(teacher.value, 'TEACHER', null, AT);
    expect(!again.ok && again.error.code).toBe('identity.role_already_assigned');
    const missing = revokeRole(newUser(), 'TEACHER', AT);
    expect(!missing.ok && missing.error.code).toBe('identity.role_not_assigned');
  });

  it('rejects an invalid status transition and a no-op one', () => {
    const skip = changeStatus(newUser(), 'SUSPENDED', LATER);
    expect(!skip.ok && skip.error.code).toBe('identity.status_transition_invalid');
    const same = changeStatus(newUser(), 'PENDING', LATER);
    expect(!same.ok && same.error.code).toBe('identity.status_unchanged');
  });

  it('distinguishes a password change from a rehash of the same password', () => {
    const changed = changePasswordHash(newUser(), 'new-hash', LATER);
    expect(changed.passwordChangedAt).toEqual(LATER);
    const rehashed = rehashPassword(newUser(), 'stronger-hash', LATER);
    expect(rehashed.passwordChangedAt).toEqual(AT);
    expect(rehashed.passwordHash).toBe('stronger-hash');
  });
});
