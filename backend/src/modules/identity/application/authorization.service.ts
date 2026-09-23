import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Result } from '../../../shared';
import type {
  AuthorizationContext,
  AuthorizationService,
  Permission,
  Principal,
} from '../contracts';
import { evaluateAccess, type PolicyRule } from '../domain/policy';
import { permissionsForRoles } from '../domain/role';

/** DI token for the registered policy rules. */
export const POLICY_RULES = Symbol('POLICY_RULES');

/**
 * The institution's single authorization decision point.
 *
 * Roles resolve to permissions; permissions plus policy rules resolve to a
 * yes/no. Callers get either a boolean (`can`, for guards) or a Result
 * (`authorize`, for use cases) — the same decision either way.
 */
@Injectable()
export class PolicyAuthorizationService implements AuthorizationService {
  constructor(@Inject(POLICY_RULES) private readonly rules: readonly PolicyRule[]) {}

  can(principal: Principal, permission: Permission, context?: AuthorizationContext): boolean {
    return evaluateAccess(principal, permission, context, this.rules);
  }

  authorize(
    principal: Principal,
    permission: Permission,
    context?: AuthorizationContext,
  ): Result<void> {
    if (this.can(principal, permission, context)) return ok(undefined);
    return err(
      failure('forbidden', 'identity.permission_denied', 'You may not perform this action.', {
        permission,
      }),
    );
  }

  principalFor(userId: string, roles: readonly string[]): Principal {
    return { userId, roles, permissions: permissionsForRoles(roles) };
  }
}
