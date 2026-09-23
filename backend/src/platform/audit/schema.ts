import { index, pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

/**
 * The audit trail: who did what, to what, and when.
 *
 * Platform owns this table rather than any module, because every module writes
 * to it through the `AuditLog` port and none of them owns accountability.
 *
 * Append-only by convention — there is no update or delete path in code. The
 * value of an audit log is exactly its immutability, so if this is ever exposed
 * beyond the application, the database role should be granted INSERT and SELECT
 * and nothing else.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),

    /** The principal responsible. Null only for system-initiated actions. */
    actorUserId: text('actor_user_id'),

    /** Dotted action name, e.g. `live.speaker.granted`, `identity.role.assigned`. */
    action: text('action').notNull(),

    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),

    /** Free-form context. Never secrets — see the logger's redaction list. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    /** Ties an entry to the request that produced it. */
    correlationId: text('correlation_id'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "What did this person do?" — the question an audit log exists to answer.
    index('audit_log_actor_idx').on(table.actorUserId, table.occurredAt),
    // "What happened to this record?" — the second question.
    index('audit_log_resource_idx').on(table.resourceType, table.resourceId, table.occurredAt),
  ],
);
