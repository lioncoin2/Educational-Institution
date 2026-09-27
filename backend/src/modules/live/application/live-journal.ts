import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  EVENT_PUBLISHER,
  type AuditEntry,
  type AuditLog,
  type DomainEvent,
  type EventPublisher,
} from '../../../shared';
import { AUDIT_ACTION_BY_MODERATION, type ModerationAction } from '../domain/moderation';
import { LIVE_AUDIT_RESOURCE } from './live-settings';

/**
 * The one place Live writes the institution's audit trail and publishes its
 * facts (ADR 0021: one journal per module). A use case calls it once, after
 * its change is stored, and never for a repeat that changed nothing — so a
 * repeated request leaves no second audit entry and no second event.
 *
 * Audit first, then the events: an audit entry is the record someone will
 * ask for later, an event is a hint to whoever listens. A person's own act —
 * raising, lowering, stopping their own screen share — is announced and not
 * audited: it is not moderation.
 *
 * Nothing that reaches it carries a join token, a URL or a name: entries and
 * payloads are ids, codes and versions only.
 */
@Injectable()
export class LiveJournal {
  constructor(
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async record(entry: AuditEntry | null, events: readonly DomainEvent[]): Promise<void> {
    if (entry !== null) await this.audit.record(entry);
    if (events.length > 0) await this.events.publish(events);
  }
}

/**
 * The audit entry of a moderation act: its own action name (one per act,
 * never shared — plan §2.3), the session as the resource, the act's actor
 * (null when the system acted), and what makes it reviewable.
 */
export function moderationAudit(
  action: ModerationAction,
  input: {
    readonly communityId: string;
    readonly detail?: Readonly<Record<string, unknown>>;
    readonly correlationId?: string;
  },
): AuditEntry {
  return {
    actorUserId: action.actorUserId,
    action: AUDIT_ACTION_BY_MODERATION[action.type],
    resourceType: LIVE_AUDIT_RESOURCE,
    resourceId: action.sessionId,
    at: action.at,
    metadata: {
      communityId: input.communityId,
      targetUserId: action.targetUserId,
      ...input.detail,
    },
    correlationId: input.correlationId,
  };
}
