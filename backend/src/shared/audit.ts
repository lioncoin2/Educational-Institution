/**
 * The audit trail.
 *
 * Sensitive actions — role changes, attendance amendments, live moderation —
 * must leave a record that is written by the same use case that performs the
 * action. The port lives in the shared kernel so any module can depend on it
 * without depending on a module that owns it.
 */
export interface AuditEntry {
  readonly actorUserId: string | null;
  /** Dotted action name, e.g. `identity.role.assigned`. */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly at: Date;
  /** Never include secrets or full payloads — only what makes the act reviewable. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export const AUDIT_LOG = Symbol('AUDIT_LOG');
