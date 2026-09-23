import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Result } from '../../../shared';
import type { AuthorizationContext, AuthorizationService } from '../contracts/authorization';
import { isPermission, type Permission } from '../contracts/permissions';
import type { Principal } from '../contracts/principal';
import { evaluateAccess, type PolicyRule } from '../domain/policy';

/** DI token for the registered policy rules. */
export const POLICY_RULES = Symbol('POLICY_RULES');

/**
 * The institution's single authorization decision point.
 *
 * A principal arrives with its permissions already resolved from its roles;
 * this adds the resource-scoped policy rules and returns yes or no. Guards get
 * `can`; use cases get `authorize`, which returns the same decision as a
 * Result. Nothing else in the system decides access.
 */
@Injectable()
export class PolicyAuthorizationService implements AuthorizationService {
  constructor(@Inject(POLICY_RULES) private readonly rules: readonly PolicyRule[]) {}

  can(principal: Principal, permission: Permission, context?: AuthorizationContext): boolean {
    // A permission outside the catalogue is not a permission. Refusing it here
    // means no rule — however it is written — can ever grant one.
    if (!isPermission(permission)) return false;
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
}
