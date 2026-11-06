import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  EVENT_PUBLISHER,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type Principal,
  type Result,
} from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import type { ConversationId } from '../domain/conversation';
import { messageReacted } from '../domain/events';
import type { MessageId } from '../domain/message';
import { canPost } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { isMessageReaction } from '../domain/reaction';
import { CommunityChats } from './community-chats';
import { ConversationAccess } from './conversation-access';
import { MESSAGE_NOT_FOUND } from './messaging-settings';

const REACTION_INVALID = failure(
  'validation',
  'messaging.reaction_invalid',
  'That is not a reaction you can use.',
);

const POSTING_NOT_ALLOWED = failure(
  'forbidden',
  'messaging.posting_not_allowed',
  'You cannot react here.',
);

export interface ReactCommand {
  readonly principal: Principal;
  readonly conversationId: string;
  readonly messageId: string;
  readonly emoji: string;
  readonly meta: CallMetadata;
}

/**
 * Toggling a reaction on a message (chat reactions). A reaction is a light,
 * public act, so it rides the EXACT seam a send does — a member who may post
 * here may react here:
 *
 *   1. the emoji must be one of the curated set (`reaction.ts`) — anything else
 *      is a 422, never stored;
 *   2. the viewer must be a current member who may post in this conversation:
 *      membership plus, for a community chat, Communities' `mayPost` (never the
 *      projected role), or the direct/channel `canPost` rule otherwise;
 *   3. the toggle itself, which fails `message_not_found` unless the target is a
 *      LIVE message of THIS conversation — a cross-conversation id, an unknown
 *      id or a tombstone is indistinguishable, so a reaction never confirms a
 *      message exists.
 *
 * The event carries the authoritative counts read after the toggle; no reaction
 * content is audited (who-reacted lives only in the rows the chat can see).
 */
@Injectable()
export class ReactToMessageUseCase {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly access: ConversationAccess,
    private readonly communityChats: CommunityChats,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: ReactCommand): Promise<Result<void>> {
    const { principal } = command;
    if (!isMessageReaction(command.emoji)) return err(REACTION_INVALID);
    const conversationId = command.conversationId as ConversationId;

    const membership = await this.access.member(
      principal,
      conversationId,
      Permissions.messaging.send,
    );
    if (!membership.ok) return membership;
    const { conversation, participant } = membership.value;
    if (conversation.communityId !== null) {
      const posting = await this.communityChats.mayPost(principal, conversation);
      if (!posting.ok) return posting;
    } else if (!canPost(conversation.type, participant.role)) {
      return err(POSTING_NOT_ALLOWED);
    }

    const now = this.clock.now();
    const outcome = await this.repository.react({
      conversationId,
      messageId: command.messageId as MessageId,
      userId: principal.userId,
      emoji: command.emoji,
      at: now,
    });
    if (outcome.kind === 'message_not_found') return err(MESSAGE_NOT_FOUND);

    await this.events.publish([
      messageReacted(
        conversationId,
        command.messageId,
        outcome.counts,
        now,
        command.meta.correlationId,
      ),
    ]);
    return ok(undefined);
  }
}
