import { ALL_PERMISSIONS, Permissions } from '../contracts/permissions';
import { PROVISIONAL_POLICY_RULES, PROVISIONAL_ROLE_PERMISSIONS } from './provisional-policy';
import { ACTIVE_ROLES, Roles, isWellFormedRoleCode } from './role';

describe('role catalogue', () => {
  it('activates exactly the six roles of this milestone', () => {
    expect([...ACTIVE_ROLES].sort()).toEqual(
      ['ADMIN', 'ASSISTANT_TEACHER', 'OWNER', 'STUDENT', 'SUPERVISOR', 'TEACHER'].sort(),
    );
  });

  it('does not activate roles the institution has not defined', () => {
    for (const inactive of ['PARENT', 'AUDITOR', 'CONTENT_MANAGER', 'SUPPORT']) {
      expect(ACTIVE_ROLES).not.toContain(inactive);
      expect(Object.keys(PROVISIONAL_ROLE_PERMISSIONS)).not.toContain(inactive);
    }
  });

  it('accepts only upper-case role codes', () => {
    expect(isWellFormedRoleCode('ASSISTANT_TEACHER')).toBe(true);
    expect(isWellFormedRoleCode('teacher')).toBe(false);
    expect(isWellFormedRoleCode('X')).toBe(false);
    expect(isWellFormedRoleCode("TEACHER'; --")).toBe(false);
  });
});

describe('provisional role matrix', () => {
  const grants = (role: keyof typeof PROVISIONAL_ROLE_PERMISSIONS) =>
    new Set<string>(PROVISIONAL_ROLE_PERMISSIONS[role]);

  it('defines a row for every active role', () => {
    expect(Object.keys(PROVISIONAL_ROLE_PERMISSIONS).sort()).toEqual([...ACTIVE_ROLES].sort());
  });

  it('only ever references catalogued permissions, each at most once per role', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const granted of Object.values(PROVISIONAL_ROLE_PERMISSIONS)) {
      expect(new Set(granted).size).toBe(granted.length);
      for (const permission of granted) expect(known.has(permission)).toBe(true);
    }
  });

  // OWNER and ADMIN must differ, or the no-escalation rule would let an admin
  // reset an owner's password. This is the technical constraint, not a policy.
  it('keeps OWNER and ADMIN distinct, with OWNER strictly stronger', () => {
    const owner = grants(Roles.owner);
    const admin = grants(Roles.admin);
    expect([...admin].every((permission) => owner.has(permission))).toBe(true);
    expect(owner.size).toBeGreaterThan(admin.size);
    expect(admin.has(Permissions.settings.manage)).toBe(false);
  });

  // ADMIN must hold everything the roles it onboards hold, or it could not
  // assign them under the no-escalation rule.
  it('lets ADMIN grant every role below it', () => {
    const admin = grants(Roles.admin);
    for (const role of [Roles.supervisor, Roles.teacher, Roles.assistantTeacher, Roles.student]) {
      for (const permission of PROVISIONAL_ROLE_PERMISSIONS[role]) {
        expect(admin.has(permission)).toBe(true);
      }
    }
  });

  // The separation that keeps a 2500-person room safe.
  it('lets a student ask for the floor but never take or give it', () => {
    const student = grants(Roles.student);
    expect(student.has(Permissions.live.raiseHand)).toBe(true);
    expect(student.has(Permissions.live.speak)).toBe(false);
    expect(student.has(Permissions.live.moderate)).toBe(false);
  });

  it('gives teachers the live capabilities the brief names', () => {
    const teacher = grants(Roles.teacher);
    for (const permission of [
      Permissions.live.join,
      Permissions.live.speak,
      Permissions.live.moderate,
    ]) {
      expect(teacher.has(permission)).toBe(true);
    }
  });

  // Realtime admits a connection only for an account holding messaging.read
  // (realtime-sessions.ts), and the app stops retrying after a 4403. A role
  // that may join a live session or read a community but lacks messaging.read
  // would silently receive no frames at all (Q66). Communities' permissions
  // join this list when they are catalogued.
  it('gives every role that may take part in live or communities the realtime gate', () => {
    const participation: readonly string[] = [Permissions.live.join, 'communities.read'];
    for (const [role, granted] of Object.entries(PROVISIONAL_ROLE_PERMISSIONS)) {
      const held = new Set<string>(granted);
      if (participation.some((permission) => held.has(permission))) {
        expect({ role, messagingRead: held.has(Permissions.messaging.read) }).toEqual({
          role,
          messagingRead: true,
        });
      }
    }
    // Not vacuous: live.join is granted today.
    expect(
      Object.values(PROVISIONAL_ROLE_PERMISSIONS).some((granted) =>
        (granted as readonly string[]).includes(Permissions.live.join),
      ),
    ).toBe(true);
  });

  it('registers the host-only moderation rule', () => {
    expect(PROVISIONAL_POLICY_RULES.map((rule) => rule.id)).toEqual(['host-only-moderation']);
  });
});
