import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  EVENT_PUBLISHER,
  err,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type Principal,
  type Result,
} from '../../../shared';
import type { CommunityPermit } from '../../communities/contracts/authorization';
import type { ConversationId } from '../domain/conversation';
import { messagePinned } from '../domain/events';
import type { MessageId } from '../domain/message';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { CommunityChats } from './community-chats';
import { CONVERSATION_NOT_FOUND } from './conversation-access';
import { CONVERSATION_RESOURCE, MESSAGE_NOT_FOUND, MessagingAudit } from './messaging-settings';

export interface PinMessageCommand {
  readonly principal: Principal;
  readonly conversationId: string;
  readonly messageId: string;
  readonly meta: CallMetadata;
}

export interface UnpinMessageCommand {
  readonly principal: Principal;
  readonly conversationId: string;
  readonly meta: CallMetadata;
}

/** What an audit entry records of the permit a pin act ran on (ADR 0043). */
function pinMetadata(
  permit: CommunityPermit,
  messageId: string | null,
): Readonly<Record<string, unknown>> {
  return {
    messageId,
    communityId: permit.communityId,
    act: permit.act,
    basis: permit.basis,
    membershipId: permit.membership?.membershipId ?? null,
    grantId: permit.grantId,
  };
}

/**
 * Pinning ONE message in a community's chat (ADR 0043). Pinning is a
 * moderation-shaped act, so it reuses the exact seam a delete does:
 *
 *   1. the conversation, which must be a community chat — anything else is the
 *      404 a non-member hears (pinning is a community-chat operation only);
 *   2. Communities' `community.messages.moderate` permit, asked of the
 *      MODERATION authority — the owner implicitly, or a delegated moderator,
 *      and NOT a plain member (a student is 403), never a projected row;
 *   3. the pin itself, which fails `message_not_found` unless the target is a
 *      LIVE message of THIS conversation (a cross-conversation id, an unknown
 *      id, or a tombstone is indistinguishable — a pin never confirms a message
 *      exists). It replaces any current pin (most-recent wins) and is idempotent.
 *
 * The actor is `principal.userId`, never the request. A pin that changed the
 * current pin is audited; a no-op repeat is not.
 */
@Injectable()
export class PinMessageUseCase {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly communityChats: CommunityChats,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: PinMessageCommand): Promise<Result<void>> {
    const { principal } = command;
    const conversationId = command.conversationId as ConversationId;

    const conversation = await this.repository.findConversation(conversationId);
    if (conversation === null || conversation.communityId === null) {
      return err(CONVERSATION_NOT_FOUND);
    }

    const permit = await this.communityChats.mayModerate(principal, conversation);
    if (!permit.ok) return permit;

    const now = this.clock.now();
    const outcome = await this.repository.pinMessage({
      conversationId,
      messageId: command.messageId as MessageId,
      pinnedBy: principal.userId,
      at: now,
    });
    if (outcome.kind === 'conversation_not_found') return err(CONVERSATION_NOT_FOUND);
    if (outcome.kind === 'message_not_found') return err(MESSAGE_NOT_FOUND);
    // A repeat pin of the already-pinned message changed nothing: idempotent,
    // nothing recorded a second time.
    if (outcome.alreadyPinned) return ok(undefined);

    await this.audit.record({
      actorUserId: principal.userId,
      action: MessagingAudit.messagePinned,
      resourceType: CONVERSATION_RESOURCE,
      resourceId: conversationId,
      at: now,
      metadata: pinMetadata(permit.value, outcome.message.id),
      correlationId: command.meta.correlationId,
    });
    // Only after the pin is persisted: the new authoritative pin id and version,
    // read from the committed row, to the conversation's connected members. An
    // id, never content (ADR 0043).
    await this.events.publish([
      messagePinned(
        conversationId,
        outcome.message.id,
        outcome.conversation.pinVersion,
        now,
        command.meta.correlationId,
      ),
    ]);
    return ok(undefined);
  }
}

/**
 * Unpinning a community chat's message (ADR 0043) — the same
 * `community.messages.moderate` authority the pin needs, and the same
 * community-chat-only 404. Unpinning never deletes the message; it only clears
 * the conversation's pin, and is idempotent (nothing pinned changes nothing).
 */
@Injectable()
export class UnpinMessageUseCase {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly communityChats: CommunityChats,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: UnpinMessageCommand): Promise<Result<void>> {
    const { principal } = command;
    const conversationId = command.conversationId as ConversationId;

    const conversation = await this.repository.findConversation(conversationId);
    if (conversation === null || conversation.communityId === null) {
      return err(CONVERSATION_NOT_FOUND);
    }

    const permit = await this.communityChats.mayModerate(principal, conversation);
    if (!permit.ok) return permit;

    const now = this.clock.now();
    const outcome = await this.repository.unpinMessage(conversationId);
    if (outcome.kind === 'conversation_not_found') return err(CONVERSATION_NOT_FOUND);
    if (outcome.alreadyUnpinned) return ok(undefined);

    await this.audit.record({
      actorUserId: principal.userId,
      action: MessagingAudit.messageUnpinned,
      resourceType: CONVERSATION_RESOURCE,
      resourceId: conversationId,
      at: now,
      metadata: pinMetadata(permit.value, null),
      correlationId: command.meta.correlationId,
    });
    // After the pin is cleared: null and the new version, to connected members.
    await this.events.publish([
      messagePinned(
        conversationId,
        null,
        outcome.conversation.pinVersion,
        now,
        command.meta.correlationId,
      ),
    ]);
    return ok(undefined);
  }
}
