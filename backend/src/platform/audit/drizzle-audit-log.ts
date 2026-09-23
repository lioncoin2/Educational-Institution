import { Inject, Injectable } from '@nestjs/common';

import { ID_GENERATOR, type AuditEntry, type AuditLog, type IdGenerator } from '../../shared';
import { DATABASE, type Database } from '../database';
import { auditLog } from './schema';

/**
 * The audit trail in Postgres: queryable, retained on its own schedule, and
 * append-only — this adapter has no update or delete path, and none should be
 * added. If the table is ever exposed beyond the application, its database role
 * should hold INSERT and SELECT only.
 *
 * Entries are written after the change they describe, by the use case that
 * made it. A write failure therefore surfaces as an error with the change
 * already persisted; closing that gap needs a unit of work spanning both, which
 * is deferred (docs/architecture/observability.md).
 */
@Injectable()
export class DrizzleAuditLog implements AuditLog {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      id: this.ids.next<'AuditEntry'>(),
      actorUserId: entry.actorUserId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      metadata: entry.metadata === undefined ? null : { ...entry.metadata },
      correlationId: entry.correlationId ?? null,
      occurredAt: entry.at,
    });
  }
}
