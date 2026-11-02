import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  EVENT_PUBLISHER,
  type AuditEntry,
  type AuditLog,
  type DomainEvent,
  type EventPublisher,
} from '../../../shared';

/**
 * After an act is stored: its audit entry, then its facts — in that order (the
 * pattern of the other journals). In-process publish, no durable outbox
 * (Class R): the tables are the truth. Never carries report text or names.
 */
@Injectable()
export class TasksJournal {
  constructor(
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async record(entry: AuditEntry, facts: readonly DomainEvent[] = []): Promise<void> {
    await this.audit.record(entry);
    if (facts.length > 0) await this.events.publish([...facts]);
  }
}
