import { Inject, Injectable } from '@nestjs/common';

import { Permissions } from '../../identity/contracts/permissions';
import {
  AUDIT_LOG,
  CLOCK,
  EVENT_PUBLISHER,
  RATE_LIMITER,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import type { ConversationId } from '../domain/conversation';
import { messageDeleted, messageEdited } from '../domain/events';
import { editedBody, type MessageId } from '../domain/message';
import { canPost, canSee } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { CommunityChats } from './community-chats';
import { CONVERSATION_NOT_FOUND, ConversationAccess, type Membership } from './conversation-access';
import { MessagingViews } from './messaging-views';
import {
  CONVERSATION_RESOURCE,
  MESSAGE_NOT_FOUND,
  MessagingAudit,
  SENDS_PER_USER,
} from './messaging-settings';
import { ModerateMessageUseCase } from './moderate-message.use-cases';
import type { MessageView } from './views';

const MESSAGE_DELETED = failure(
  'conflict',
  'messaging.message_deleted',
  'This message was deleted; it can no longer be edited.',
);

interface MessageCommand {
  readonly principal: Principal;
  readonly conversationId: string;
  readonly messageId: string;
  readonly meta: CallMetadata;
}

/**
 * An author editing their own message (owner decision D, ADR 0045) — in a
 * direct conversation, a group, a channel or a community chat alike.
 *
 * In order, the same gates a send passes:
 *   1. identity `messaging.send` and a CURRENT membership (a community chat
 *      admits through Communities, never a projected row) — a non-member gets
 *      the 404 everyone outside hears;
 *   2. the posting rule, asked now (a channel's publishers; Communities'
 *      `community.chat.post` / open-group rule) — whoever may no longer post
 *      may no longer edit;
 *   3. the message: this conversation's, the caller's OWN, and visible to them
 *      — anything else is `message_not_found`, so the route is no probe and a
 *      moderator gains no editing power (only authors edit);
 *   4. the new text, bounded as a send's is: a TEXT message keeps needing text;
 *      a media caption may change or clear; attachments never change;
 *   5. the conditional write — a deleted message stays deleted (409), the same
 *      text changes nothing (no stamp, no event).
 * An applied edit stamps `editedAt`, is audited WITHOUT its text, and raises
 * `messaging.message.edited` (ids only); every connected member re-renders it.
 */
@Injectable()
export class EditMessageUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly communityChats: CommunityChats,
    private readonly views: MessagingViews,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: MessageCommand & { readonly body: string }): Promise<Result<MessageView>> {
    const { principal } = command;
    const membership = await this.access.member(
      principal,
      command.conversationId,
      Permissions.messaging.send,
    );
    if (!membership.ok) return membership;
    const { conversation, participant } = membership.value;
    if (conversation.communityId !== null) {
      const posting = await this.communityChats.mayPost(principal, conversation);
      if (!posting.ok) return posting;
    } else if (!canPost(conversation.type, participant.role)) {
      return err(
        failure(
          'forbidden',
          'messaging.posting_not_allowed',
          'Only the owner and publishers may post in this channel.',
        ),
      );
    }

    const throttle = await this.limiter.consume(principal.userId, SENDS_PER_USER);
    if (!throttle.allowed) {
      return err(
        failure('rate_limited', 'messaging.too_many_messages', 'Too many messages. Slow down.', {
          retryAfterSeconds: throttle.retryAfterSeconds,
        }),
      );
    }

    const message = await this.ownMessage(membership.value, principal, command.messageId);
    if (message === null) return err(MESSAGE_NOT_FOUND);
    const body = editedBody(message.type, command.body);
    if (!body.ok) return body;

    const at = this.clock.now();
    const outcome = await this.repository.editMessage({
      conversationId: conversation.id,
      messageId: message.id,
      authorId: principal.userId,
      body: body.value,
      at,
    });
    switch (outcome.kind) {
      case 'not_found':
        return err(MESSAGE_NOT_FOUND);
      case 'deleted':
        return err(MESSAGE_DELETED);
      case 'unchanged':
        return ok(await this.view(outcome.message, principal.userId));
      case 'edited':
        await this.audit.record({
          actorUserId: principal.userId,
          action: MessagingAudit.messageEdited,
          resourceType: CONVERSATION_RESOURCE,
          resourceId: conversation.id,
          at,
          // Never the text — old or new.
          metadata: { messageId: message.id, sequence: message.sequence },
          correlationId: command.meta.correlationId,
        });
        await this.events.publish([
          messageEdited(conversation, outcome.message, command.meta.correlationId),
        ]);
        return ok(await this.view(outcome.message, principal.userId));
    }
  }

  private async ownMessage(membership: Membership, principal: Principal, messageId: string) {
    const message = await this.repository.findMessage(
      membership.conversation.id,
      messageId as MessageId,
    );
    if (message === null) return null;
    if (message.senderId !== principal.userId) return null;
    if (!canSee(membership.participant, message.sequence)) return null;
    return message;
  }

  private async view(message: Parameters<MessagingViews['messages']>[0][number], viewerId: string) {
    const rendered = await this.views.messages([message], viewerId);
    const view = rendered.items[0];
    if (view === undefined) throw new Error('A rendered message went missing.');
    return view;
  }
}

/**
 * Deleting a message (owner decision D, ADR 0045): the AUTHOR deletes their
 * own, in any conversation they are still a member of; anyone else goes the
 * existing way — a community chat's moderator (`community.messages.moderate`,
 * ADR 0029), and everywhere else the same 404 a non-member hears. Moderators
 * delete; they never edit.
 *
 * An author's delete is the same soft delete — idempotent, the tombstone every
 * reader sees, the body kept for the 7-day review and then wiped by retention —
 * audited as the author's own act (not moderation) and announced with the same
 * ids-only `messaging.message.deleted`.
 */
@Injectable()
export class DeleteMessageUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly moderation: ModerateMessageUseCase,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: MessageCommand): Promise<Result<void>> {
    const { principal } = command;
    const conversationId = command.conversationId as ConversationId;
    const message = await this.repository.findMessage(
      conversationId,
      command.messageId as MessageId,
    );
    // Not the caller's own message (or none): moderation decides, exactly as
    // before — a community chat's moderator, or the 404 everyone else hears.
    if (message === null || message.senderId !== principal.userId) {
      return this.moderation.execute(command);
    }

    const membership = await this.access.member(
      principal,
      command.conversationId,
      Permissions.messaging.read,
    );
    if (!membership.ok) return membership;
    if (!canSee(membership.value.participant, message.sequence)) {
      return err(CONVERSATION_NOT_FOUND);
    }

    const at = this.clock.now();
    const outcome = await this.repository.softDeleteMessage({
      conversationId,
      messageId: message.id,
      deletedBy: principal.userId,
      at,
    });
    if (outcome.kind === 'not_found') return err(MESSAGE_NOT_FOUND);
    if (outcome.alreadyDeleted) return ok(undefined);

    await this.audit.record({
      actorUserId: principal.userId,
      action: MessagingAudit.messageDeletedByAuthor,
      resourceType: CONVERSATION_RESOURCE,
      resourceId: conversationId,
      at,
      metadata: { messageId: message.id, sequence: message.sequence },
      correlationId: command.meta.correlationId,
    });
    await this.events.publish([
      messageDeleted(membership.value.conversation, outcome.message, command.meta.correlationId),
    ]);
    return ok(undefined);
  }
}
