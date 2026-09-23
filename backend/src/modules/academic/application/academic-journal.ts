import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  EVENT_PUBLISHER,
  type AuditLog,
  type DomainEvent,
  type EventPublisher,
} from '../../../shared';

/**
 * After a change is stored: its audit entry, then its event — in that order,
 * by every academic use case that changes something, and by nothing that
 * only reads. A change that altered nothing (a repeat, a no-op edit) records
 * neither.
 */
@Injectable()
export class AcademicJournal {
  constructor(
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async record(
    entry: {
      readonly actorUserId: string | null;
      readonly action: string;
      readonly resourceType: string;
      readonly resourceId: string;
      readonly at: Date;
      /** Ids, codes, statuses and field names only — never a person's name. */
      readonly metadata?: Readonly<Record<string, unknown>>;
      readonly correlationId?: string;
    },
    event: DomainEvent,
  ): Promise<void> {
    await this.audit.record(entry);
    await this.events.publish([event]);
  }
}
