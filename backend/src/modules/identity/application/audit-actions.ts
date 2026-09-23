import type { AuditEntry, CallMetadata } from '../../../shared';

/**
 * Every security-relevant act identity records.
 *
 * Audit entries carry identifiers, codes and timestamps — never a password, a
 * token, a hash, or an email address. The client IP is kept on
 * authentication events only, because it is the primary signal for spotting
 * credential stuffing; its retention is open-questions.md Q3.
 */
export const IdentityAudit = {
  loginSucceeded: 'identity.login.succeeded',
  loginFailed: 'identity.login.failed',
  logout: 'identity.logout',
  sessionRefreshed: 'identity.session.refreshed',
  refreshRejected: 'identity.session.refresh_rejected',
  refreshReuseDetected: 'identity.session.refresh_reuse_detected',
  sessionRevoked: 'identity.session.revoked',
  passwordChanged: 'identity.password.changed',
  passwordReset: 'identity.password.reset',
  userCreated: 'identity.user.created',
  accountActivated: 'identity.account.activated',
  accountSuspended: 'identity.account.suspended',
  accountDisabled: 'identity.account.disabled',
  roleAssigned: 'identity.role.assigned',
  roleRevoked: 'identity.role.revoked',
  ownerBootstrapped: 'identity.owner.bootstrapped',
  /**
   * Reserved. The role → permission matrix is changed by reviewed migration in
   * this milestone; the runtime use case that will emit this is deferred.
   */
  rolePermissionsChanged: 'identity.role_permissions.changed',
} as const;

export type IdentityAuditAction = (typeof IdentityAudit)[keyof typeof IdentityAudit];

export const USER_RESOURCE = 'identity.user';
export const SESSION_RESOURCE = 'identity.session';

export function auditEntry(
  fields: {
    readonly action: IdentityAuditAction;
    readonly actorUserId: string | null;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly at: Date;
    readonly metadata?: Readonly<Record<string, unknown>>;
    /** Only authentication events record the client address. */
    readonly includeIp?: boolean;
  },
  meta: CallMetadata,
): AuditEntry {
  const metadata: Record<string, unknown> = { ...(fields.metadata ?? {}) };
  if (fields.includeIp === true && meta.ipAddress !== undefined) metadata.ip = meta.ipAddress;
  return {
    actorUserId: fields.actorUserId,
    action: fields.action,
    resourceType: fields.resourceType,
    resourceId: fields.resourceId,
    at: fields.at,
    metadata,
    correlationId: meta.correlationId,
  };
}
