import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  EVENT_PUBLISHER,
  type AuditLog,
  type DomainEvent,
  type EventPublisher,
} from '../../../shared';
import { AUDIT_ACTION_BY_MODERATION, type ModerationAction } from '../domain/moderation';

/**
 * The one place live writes the institution's audit trail and publishes its
 * facts (ADR 0021: one journal per module). A use case calls it once, after
 * its change is stored, and never for a repeat that changed nothing — so a
 * repeated request leaves no second audit entry and no second event.
 *
 * Audit first, then the event: an audit entry is the record someone will ask
 * for later, an event is a hint to whoever listens.
 */
@Injectable()
export class LiveJournal {
  constructor(
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  /** A moderation act: audited under its own action name, then announced. */
  async moderated(
    action: ModerationAction,
    event: DomainEvent,
    extra: Readonly<Record<string, unknown>> = {},
    correlationId?: string,
  ): Promise<void> {
    await this.audit.record({
      actorUserId: action.actorUserId,
      action: AUDIT_ACTION_BY_MODERATION[action.type],
      resourceType: 'live.session',
      resourceId: action.sessionId,
      at: action.at,
      metadata: { targetUserId: action.targetUserId, ...extra },
      correlationId,
    });
    await this.events.publish([event]);
  }

  /** A person's own act (raising or lowering a hand): announced, not audited. */
  async announced(event: DomainEvent): Promise<void> {
    await this.events.publish([event]);
  }
}
