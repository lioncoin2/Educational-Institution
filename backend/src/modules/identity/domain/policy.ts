import type { Principal } from '../../../shared';
// Specific files, not the contracts barrel: the barrel also exports Nest route
// decorators, and the domain must not pull a framework in, even transitively.
import type { AuthorizationContext } from '../contracts/authorization';
import type { Permission } from '../contracts/permissions';

/**
 * Resource-scoped rules that role permissions cannot express.
 *
 * A teacher holds `live.moderate`, but only for a room they actually run. The
 * second half of that sentence is a policy rule, evaluated with the resource
 * context the use case supplies.
 *
 * Three-valued on purpose: `abstain` is not `deny`. A rule with no opinion must
 * not veto a permission granted elsewhere — collapsing the result to a boolean
 * is how these systems become impossible to extend.
 */
export type PolicyDecision = 'permit' | 'deny' | 'abstain';

export interface PolicyRule {
  readonly id: string;
  /** Cheap pre-filter so unrelated rules are never evaluated. */
  appliesTo(permission: Permission, context: AuthorizationContext | undefined): boolean;
  evaluate(
    principal: Principal,
    permission: Permission,
    context: AuthorizationContext | undefined,
  ): PolicyDecision;
}

/**
 * Combines the role baseline with policy rules using **deny-overrides**:
 *
 *   1. an explicit deny always wins — including against the owner;
 *   2. otherwise the role baseline decides;
 *   3. otherwise a rule may still permit (ownership grants).
 *
 * Anything unproven is denied. A permission the principal does not hold, and
 * that no rule permits, is "no" — which covers unknown permissions too.
 */
export function evaluateAccess(
  principal: Principal,
  permission: Permission,
  context: AuthorizationContext | undefined,
  rules: readonly PolicyRule[],
): boolean {
  const applicable = rules.filter((rule) => rule.appliesTo(permission, context));
  const decisions = applicable.map((rule) => rule.evaluate(principal, permission, context));

  if (decisions.includes('deny')) return false;
  if (principal.permissions.has(permission)) return true;
  return decisions.includes('permit');
}

/** Grants the listed permissions to the user who owns the resource. */
export function ownerOfResourceRule(permissions: readonly Permission[]): PolicyRule {
  const scoped = new Set<string>(permissions);
  return {
    id: 'owner-of-resource',
    appliesTo: (permission, context) =>
      scoped.has(permission) && context?.ownerUserId !== undefined,
    evaluate: (principal, _permission, context) =>
      context?.ownerUserId === principal.userId ? 'permit' : 'abstain',
  };
}

/**
 * Restricts the listed permissions to the resource's owner.
 *
 * Holding the permission is still required — the owner abstains and the role
 * baseline decides. Everyone else is denied, whatever their roles. When the
 * caller supplies no owner the rule does not apply, so a coarse "may this
 * principal moderate at all?" check still works before the resource is loaded.
 */
export function restrictToResourceOwner(
  id: string,
  permissions: readonly Permission[],
): PolicyRule {
  const scoped = new Set<string>(permissions);
  return {
    id,
    appliesTo: (permission, context) =>
      scoped.has(permission) && context?.ownerUserId !== undefined,
    evaluate: (principal, _permission, context) =>
      context?.ownerUserId === principal.userId ? 'abstain' : 'deny',
  };
}
