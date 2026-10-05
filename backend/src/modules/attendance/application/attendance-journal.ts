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
 * After a created snapshot is stored: its audit entry, then its event — in that
 * order (the pattern of `academic-journal.ts`). Only a **created** snapshot is
 * journaled; a replay or a lost same-key race records neither. In-process
 * publish, no durable outbox (Class R, attendance.md §14).
 */
@Injectable()
export class AttendanceJournal {
  constructor(
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async record(entry: AuditEntry, event: DomainEvent): Promise<void> {
    await this.audit.record(entry);
    await this.events.publish([event]);
  }
}
