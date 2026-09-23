import { Injectable, Logger } from '@nestjs/common';

import type { AuditEntry, AuditLog } from '../../shared';

/**
 * Audit entries to the structured log stream — used only when no database is
 * configured (local development). With a database, `DrizzleAuditLog` is used.
 * Retention of either is a policy decision: open-questions.md, Q3.
 */
@Injectable()
export class LoggingAuditLog implements AuditLog {
  private readonly logger = new Logger('Audit');

  async record(entry: AuditEntry): Promise<void> {
    this.logger.log({ audit: true, ...entry }, `${entry.action} ${entry.resourceType}`);
  }
}
