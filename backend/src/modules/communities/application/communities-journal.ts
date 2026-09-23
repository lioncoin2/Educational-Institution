import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  EVENT_PUBLISHER,
  type AuditEntry,
  type AuditLog,
  type DomainEvent,
  type EventPublisher,
} from '../../../shared';
import type { CommunityAct, CommunityPermit } from '../contracts';
import { COMMUNITY_AUDIT_RESOURCE, CommunityAudit } from './communities-settings';

/**
 * The one place Communities writes the audit trail and publishes its facts
 * (ADR 0021: one journal per module). A use case calls it after its change
 * is stored, and never for a no-op or an idempotent repeat — so a repeated
 * request leaves no second entry and no second event.
 *
 * Audit first, then the event: the audit entry is the record someone will
 * ask for later; an event is a hint to whoever listens.
 */
@Injectable()
export class CommunitiesJournal {
  constructor(
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async record(entry: AuditEntry, events: readonly DomainEvent[]): Promise<void> {
    await this.audit.record(entry);
    if (events.length > 0) await this.events.publish(events);
  }

  /**
   * A read on the oversight basis — someone reaching into a community they
   * do not belong to. Audited (PROVISIONAL, Q43), never announced. The audit
   * records the access; it does not prevent it.
   */
  async oversightRead(input: {
    readonly actorUserId: string | null;
    readonly communityId: string;
    readonly act: CommunityAct | null;
    readonly at: Date;
    readonly correlationId?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: CommunityAudit.oversightRead,
      resourceType: COMMUNITY_AUDIT_RESOURCE,
      resourceId: input.communityId,
      at: input.at,
      metadata: { act: input.act, ...input.detail },
      correlationId: input.correlationId,
    });
  }
}

/** What an audit entry records about the permit an act relied on. */
export function authorityOf(permit: CommunityPermit): Readonly<Record<string, unknown>> {
  return {
    act: permit.act,
    basis: permit.basis,
    membershipId: permit.membership?.membershipId ?? null,
    grantId: permit.grantId,
  };
}
