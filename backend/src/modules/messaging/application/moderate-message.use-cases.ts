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
import { messageDeleted } from '../domain/events';
import type { MessageId } from '../domain/message';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { CommunityChats } from './community-chats';
import { CONVERSATION_NOT_FOUND } from './conversation-access';
import { MessagingViews } from './messaging-views';
import {
  CONVERSATION_RESOURCE,
  DELETED_MESSAGE_NOT_FOUND,
  DELETED_MESSAGE_REVIEW_EXPIRED,
  MESSAGE_MODERATION,
  MESSAGE_NOT_FOUND,
  MessagingAudit,
} from './messaging-settings';
import type { ReviewedMessageView } from './views';

export interface ModerateMessageCommand {
  readonly principal: Principal;
  readonly conversationId: string;
  readonly messageId: string;
  readonly meta: CallMetadata;
}

/** What an audit entry records of the permit a moderation act ran on (ADR 0029, §audit). */
function moderationMetadata(
  permit: CommunityPermit,
  messageId: string,
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
 * Deleting a message in a community's chat (Q51/Q23, ADR 0029).
 *
 * In order:
 *   1. the conversation, which must be a community chat — anything else is the
 *      404 a non-member hears, since message moderation is a community-chat
 *      operation only (owner policy 13, 15);
 *   2. Communities' `community.messages.moderate` permit, asked of the
 *      MODERATION authority — never the projected rows, never `community.chat.
 *      read` (owner policy 4, 5): the owner implicitly, or a delegated
 *      moderator, and NOT a plain member (a student is 403);
 *   3. the soft delete — idempotent: a message already a tombstone changes
 *      nothing and raises neither event nor audit. The body and attachments
 *      stay for the 7-day review; the tombstone is what every reader now sees.
 *
 * The actor is `principal.userId`, never a field in the request. A newly
 * applied delete is audited as moderation and raises `messaging.message.deleted`;
 * the frame built from it carries ids only, so no content and no actor leak.
 */
@Injectable()
export class ModerateMessageUseCase {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly communityChats: CommunityChats,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: ModerateMessageCommand): Promise<Result<void>> {
    const { principal } = command;
    const conversationId = command.conversationId as ConversationId;

    const conversation = await this.repository.findConversation(conversationId);
    // Not a community chat (a DM, a group, or unknown): the same 404 throughout,
    // so the route is no probe and moderation never reaches a private chat.
    if (conversation === null || conversation.communityId === null) {
      return err(CONVERSATION_NOT_FOUND);
    }

    const permit = await this.communityChats.mayModerate(principal, conversation);
    if (!permit.ok) return permit;

    const now = this.clock.now();
    const outcome = await this.repository.softDeleteMessage({
      conversationId,
      messageId: command.messageId as MessageId,
      deletedBy: principal.userId,
      at: now,
    });
    if (outcome.kind === 'not_found') return err(MESSAGE_NOT_FOUND);
    // A repeat or concurrent delete that changed nothing: idempotent success,
    // nothing recorded or announced a second time.
    if (outcome.alreadyDeleted) return ok(undefined);

    await this.audit.record({
      actorUserId: principal.userId,
      action: MessagingAudit.moderationMessageDeleted,
      resourceType: CONVERSATION_RESOURCE,
      resourceId: conversationId,
      at: now,
      metadata: moderationMetadata(permit.value, outcome.message.id),
      correlationId: command.meta.correlationId,
    });
    await this.events.publish([
      messageDeleted(conversation, outcome.message, command.meta.correlationId),
    ]);
    return ok(undefined);
  }
}

/**
 * Reviewing a deleted message's ORIGINAL (Q51/Q23, ADR 0029) — a separate,
 * audited use case, NOT a widening of `messaging.read` or `community.chat.read`
 * (owner policy 9, 11; Q23 "its own permission").
 *
 * In order:
 *   1. the conversation, a community chat, or 404;
 *   2. the SAME `community.messages.moderate` permit the delete needs — a
 *      reader without it, a student, a non-member all fail here, so moderation
 *      authority alone opens the original;
 *   3. the message, which must be deleted and within its 7-day window — absent
 *      or not-deleted is `deleted_message_not_found`; past the window is
 *      `deleted_message_review_expired` (the original is gone);
 *   4. the review is audited as a disclosure of content, then the un-tombstoned
 *      original is returned (`MessagingViews.reviewed`, the one path that does
 *      not apply `asSeen`).
 */
@Injectable()
export class ReviewDeletedMessageUseCase {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly communityChats: CommunityChats,
    private readonly views: MessagingViews,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: ModerateMessageCommand): Promise<Result<ReviewedMessageView>> {
    const { principal } = command;
    const conversationId = command.conversationId as ConversationId;

    const conversation = await this.repository.findConversation(conversationId);
    if (conversation === null || conversation.communityId === null) {
      return err(CONVERSATION_NOT_FOUND);
    }

    const permit = await this.communityChats.mayModerate(principal, conversation);
    if (!permit.ok) return permit;

    const message = await this.repository.findMessage(
      conversationId,
      command.messageId as MessageId,
    );
    // The review resource exists only for a deleted message: absent and
    // not-deleted are indistinguishable here (a live message is read normally).
    if (message === null || message.deletedAt === null) return err(DELETED_MESSAGE_NOT_FOUND);
    // The deterministic 7-day boundary: reviewable strictly before it, wiped by
    // retention on or after it — complementary, so there is no in-between.
    const expiresAt = message.deletedAt.getTime() + MESSAGE_MODERATION.reviewWindowMs;
    if (this.clock.now().getTime() >= expiresAt) return err(DELETED_MESSAGE_REVIEW_EXPIRED);

    await this.audit.record({
      actorUserId: principal.userId,
      action: MessagingAudit.moderationMessageReviewed,
      resourceType: CONVERSATION_RESOURCE,
      resourceId: conversationId,
      at: this.clock.now(),
      metadata: moderationMetadata(permit.value, message.id),
      correlationId: command.meta.correlationId,
    });
    return ok(await this.views.reviewed(message));
  }
}
