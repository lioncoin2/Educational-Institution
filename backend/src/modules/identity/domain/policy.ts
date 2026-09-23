import type { AuthorizationContext, Permission, Principal } from '../contracts';

/**
 * Resource-scoped rules that role-based permissions cannot express.
 *
 * A teacher holds `live.speaker.grant`, but only for a room they actually run.
 * That second half is a policy rule, evaluated with the resource context.
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
 * Combines the role-based baseline with policy rules using **deny-overrides**:
 * an explicit deny always wins, and when the baseline says no a rule may still
 * permit (ownership grants). Anything unproven is denied.
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

/** Grants a permission to the user who owns the resource being acted on. */
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
