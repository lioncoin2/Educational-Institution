import { Inject, Injectable } from '@nestjs/common';

import { ok, type Principal, type Result } from '../../../shared';
import type {
  ConversationPosition,
  MessageDelivery,
  MessageForDelivery,
} from '../contracts/message-delivery';
import type { ConversationId } from '../domain/conversation';
import type { MessageId } from '../domain/message';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { MessagingViews } from './messaging-views';
import { GetConversationUseCase } from './read-conversations.use-cases';

/**
 * The delivery contract, built from what messaging already has: the
 * repository for the stored message, the views for how it looks, and the
 * "open a conversation" use case for who may follow one. Nothing here is a
 * second copy of a messaging rule.
 */
@Injectable()
export class MessageDeliveryService implements MessageDelivery {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly views: MessagingViews,
    private readonly getConversation: GetConversationUseCase,
  ) {}

  async message(conversationId: string, messageId: string): Promise<MessageForDelivery | null> {
    const message = await this.repository.findMessage(
      conversationId as ConversationId,
      messageId as MessageId,
    );
    if (message === null) return null;
    // Rendered once, as the sender sees it — one directory and one files
    // lookup however many people it then reaches.
    const rendered = await this.views.messages([message], message.senderId);
    const forSender = rendered.items[0];
    if (forSender === undefined) return null;
    return {
      forSender,
      // The idempotency key is the sender's own reconciliation handle.
      forMembers: { ...forSender, clientMessageId: null },
      sender: rendered.senders.find((person) => person.userId === message.senderId) ?? null,
    };
  }

  async position(
    principal: Principal,
    conversationId: string,
  ): Promise<Result<ConversationPosition>> {
    const view = await this.getConversation.execute({ principal, conversationId });
    if (!view.ok) return view;
    return ok({
      conversationId: view.value.id,
      lastSequence: view.value.lastSequence,
      lastReadSequence: view.value.lastReadSequence,
    });
  }
}
