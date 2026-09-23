import { ALL_PERMISSIONS, Permissions } from '../contracts';
import { PROVISIONAL_ROLE_PERMISSIONS, RoleNames, permissionsForRoles } from './role';

describe('role → permission resolution', () => {
  it('gives the owner every permission in the catalogue', () => {
    const owner = permissionsForRoles([RoleNames.owner]);
    for (const permission of ALL_PERMISSIONS) {
      expect(owner.has(permission)).toBe(true);
    }
  });

  it('grants nothing for an unknown role', () => {
    expect(permissionsForRoles(['not-a-role']).size).toBe(0);
  });

  it('unions the permissions of several roles', () => {
    const combined = permissionsForRoles([RoleNames.student, RoleNames.auditor]);
    expect(combined.has(Permissions.live.requestSpeaker)).toBe(true);
    expect(combined.has(Permissions.audit.read)).toBe(true);
  });

  // The separation that keeps a 2500-person room safe: students may ask for the
  // floor, only a host may hand it over.
  it('does not let a student grant themselves the floor', () => {
    const student = permissionsForRoles([RoleNames.student]);
    expect(student.has(Permissions.live.requestSpeaker)).toBe(true);
    expect(student.has(Permissions.live.grantSpeaker)).toBe(false);
    expect(student.has(Permissions.live.muteParticipant)).toBe(false);
  });

  it('only ever references permissions that exist in the catalogue', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const [role, granted] of Object.entries(PROVISIONAL_ROLE_PERMISSIONS)) {
      for (const permission of granted) {
        expect(known.has(permission)).toBe(true);
        expect(typeof role).toBe('string');
      }
    }
  });
});
