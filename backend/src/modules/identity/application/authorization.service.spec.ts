import type { Permission, Principal } from '../contracts';
import { Permissions, systemPrincipal } from '../contracts';
import { PROVISIONAL_POLICY_RULES } from '../domain/provisional-policy';
import type { PolicyRule } from '../domain/policy';
import { PolicyAuthorizationService } from './authorization.service';

const principal = (permissions: string[], userId = 'user-1'): Principal => ({
  userId,
  roles: [],
  permissions: new Set(permissions),
});

describe('PolicyAuthorizationService', () => {
  const service = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);

  it('grants a permission the principal holds', () => {
    expect(service.can(principal(['reports.read']), Permissions.reports.read)).toBe(true);
  });

  it('denies a permission the principal does not hold', () => {
    expect(service.can(principal(['reports.read']), Permissions.users.manage)).toBe(false);
  });

  it('denies a principal with no permissions at all', () => {
    for (const permission of Object.values(Permissions).flatMap((group) => Object.values(group))) {
      expect(service.can(principal([]), permission)).toBe(false);
    }
  });

  // Even if some rule would permit it: a permission outside the catalogue is
  // not a permission, so nothing can grant it.
  it('denies an unknown permission, whatever rules say', () => {
    const permitAll: PolicyRule = {
      id: 'permit-all',
      appliesTo: () => true,
      evaluate: () => 'permit',
    };
    const permissive = new PolicyAuthorizationService([permitAll]);
    const unknown = 'users.delete_everything' as Permission;
    expect(permissive.can(principal([unknown]), unknown)).toBe(false);
  });

  it('returns a safe forbidden failure from authorize()', () => {
    const result = service.authorize(principal([]), Permissions.users.manage);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('forbidden');
      expect(result.error.code).toBe('identity.permission_denied');
    }
  });

  describe('host-only moderation (provisional)', () => {
    const teacher = (id: string) => principal([Permissions.live.moderate], id);
    const room = { resourceType: 'live.session', resourceId: 's-1', ownerUserId: 'host' };

    it('lets the host moderate their own room', () => {
      expect(service.can(teacher('host'), Permissions.live.moderate, room)).toBe(true);
    });

    it("refuses another teacher in someone else's room", () => {
      expect(service.can(teacher('other'), Permissions.live.moderate, room)).toBe(false);
    });

    it('refuses even an all-permission principal in a room they do not host', () => {
      const owner = principal(
        Object.values(Permissions).flatMap((g) => Object.values(g)),
        'owner',
      );
      expect(service.can(owner, Permissions.live.moderate, room)).toBe(false);
    });
  });

  // Authorization is enforced at the application boundary, so a job or event
  // handler calling a use case is held to exactly the same rules as a person.
  describe('system principals', () => {
    it('hold exactly the permissions they are given', () => {
      const job = systemPrincipal('attendance-reconciler', [Permissions.attendance.manage]);
      expect(job.userId).toBe('system:attendance-reconciler');
      expect(service.can(job, Permissions.attendance.manage)).toBe(true);
      expect(service.can(job, Permissions.roles.assign)).toBe(false);
    });
  });
});
