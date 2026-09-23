import { Injectable, Logger } from '@nestjs/common';

import type { AuditEntry, AuditLog } from '../../shared';

/**
 * Foundation adapter: audit entries go to the structured log stream, where they
 * are already shipped and retained.
 *
 * A Postgres-backed adapter (queryable, tamper-evident, retained on its own
 * schedule) implements the same port next — see open-questions.md (Q6) on the
 * retention period, which is a policy decision.
 */
@Injectable()
export class LoggingAuditLog implements AuditLog {
  private readonly logger = new Logger('Audit');

  async record(entry: AuditEntry): Promise<void> {
    this.logger.log({ audit: true, ...entry }, `${entry.action} ${entry.resourceType}`);
  }
}
