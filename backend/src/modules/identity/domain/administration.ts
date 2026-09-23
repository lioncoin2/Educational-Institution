/**
 * The rules that stop account administration from becoming privilege escalation.
 *
 * These are security invariants, not institutional policy: whatever the
 * institution decides roles may do, no one may use the admin API to become —
 * or take over — someone more powerful than themselves.
 */

/**
 * An actor may administer a target (reset a password, change status, change
 * roles, end sessions) only if the actor holds every permission the target
 * holds.
 *
 * Without this, anyone able to reset passwords could reset an owner's and sign
 * in as them.
 */
export function canAdminister(
  actorPermissions: ReadonlySet<string>,
  targetPermissions: ReadonlySet<string>,
): boolean {
  for (const permission of targetPermissions) {
    if (!actorPermissions.has(permission)) return false;
  }
  return true;
}

/**
 * An actor may grant a role only if they already hold every permission it
 * carries — otherwise assigning a role would be a way to acquire permissions
 * nobody gave you (by granting it to an account you control).
 */
export function canGrantRole(
  actorPermissions: ReadonlySet<string>,
  rolePermissions: ReadonlySet<string>,
): boolean {
  return canAdminister(actorPermissions, rolePermissions);
}

/**
 * Administrative operations may not target the actor's own account.
 *
 * Self-service has its own endpoints (change your password, end your sessions).
 * Through the admin API, acting on yourself is either a no-op or a way to lock
 * yourself — possibly the last owner — out, so it is refused.
 *
 * Together with `canAdminister`, this guarantees the system can never lose its
 * last fully-privileged account through the API: to act on such an account you
 * must hold everything it holds, and you cannot act on yourself — so another
 * equally privileged account always remains.
 */
export function isSelfAdministration(actorUserId: string, targetUserId: string): boolean {
  return actorUserId === targetUserId;
}
