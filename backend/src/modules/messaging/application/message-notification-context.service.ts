import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  COMMUNITY_DIRECTORY,
  type CommunityDirectory,
} from '../../communities/contracts/directory';
import {
  MAX_NOTIFICATION_CONTEXT_REFS,
  type MessageNotificationContext,
  type NotificationContext,
  type NotificationContextRef,
} from '../contracts/message-notification-context';
import { MESSAGE_RECIPIENTS, type MessageRecipients } from '../contracts/message-recipients';
import type { Conversation, ConversationId } from '../domain/conversation';
import type { MessageId } from '../domain/message';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { askCommunities } from './community-calls';
import { PREVIEW_LENGTH } from './messaging-views';

/**
 * MESSAGE_NOTIFICATION_CONTEXT (ADR 0046): for one recipient, what an inbox
 * entry or a realtime notification may say about a conversation and a
 * message — asked when it is shown, so a removal, an edit or a delete that
 * has committed is already in effect.
 *
 * Who may read is MESSAGE_RECIPIENTS' answer for exactly this person — the
 * same one that decided they should be notified at all, asked again now:
 * current members (Communities' ACTIVE members for a community chat, holding
 * its read ceiling), readers only, within their history window. Anything
 * else returns no context, and the notification keeps its content-free text.
 *
 * A community chat is named by its community's title, from Communities'
 * directory; when Communities cannot answer, it goes untitled — never a
 * failure of the inbox.
 */
@Injectable()
export class MessageNotificationContextService implements MessageNotificationContext {
  private readonly logger = new Logger(MessageNotificationContextService.name);

  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(MESSAGE_RECIPIENTS) private readonly recipients: MessageRecipients,
    @Inject(COMMUNITY_DIRECTORY) private readonly communities: CommunityDirectory,
  ) {}

  async forRecipient(
    recipientUserId: string,
    refs: readonly NotificationContextRef[],
  ): Promise<readonly NotificationContext[]> {
    if (refs.length > MAX_NOTIFICATION_CONTEXT_REFS) {
      throw new RangeError(`At most ${MAX_NOTIFICATION_CONTEXT_REFS} references per call.`);
    }
    const conversations = new Map<string, Conversation | null>();
    for (const { conversationId } of refs) {
      if (!conversations.has(conversationId)) {
        conversations.set(
          conversationId,
          await this.repository.findConversation(conversationId as ConversationId),
        );
      }
    }
    const titles = await this.communityTitles([...conversations.values()]);

    const contexts: NotificationContext[] = [];
    for (const ref of refs) {
      const conversation = conversations.get(ref.conversationId) ?? null;
      if (conversation === null) continue;
      const message =
        ref.messageId === null
          ? null
          : await this.repository.findMessage(conversation.id, ref.messageId as MessageId);
      if (ref.messageId !== null && message === null) continue;
      const page = await this.recipients.list(conversation.id, {
        onlyUserIds: [recipientUserId],
        readersOnly: true,
        visibleSequence: message?.sequence,
        limit: 1,
      });
      if (!page.userIds.includes(recipientUserId)) continue;

      const title =
        conversation.communityId !== null
          ? (titles.get(conversation.communityId) ?? null)
          : conversation.type === 'DIRECT'
            ? null
            : conversation.title;
      contexts.push({
        conversationId: conversation.id,
        messageId: message?.id ?? null,
        conversationTitle: title,
        messagePreview:
          message === null || message.deletedAt !== null || message.body === null
            ? null
            : [...message.body].slice(0, PREVIEW_LENGTH).join(''),
      });
    }
    return contexts;
  }

  private async communityTitles(
    conversations: readonly (Conversation | null)[],
  ): Promise<ReadonlyMap<string, string | null>> {
    const ids = [
      ...new Set(
        conversations.flatMap((conversation) =>
          conversation?.communityId == null ? [] : [conversation.communityId],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const answer = await askCommunities(this.logger, () => this.communities.describe(ids));
    if (!answer.ok) return new Map();
    return new Map(answer.value.map((summary) => [summary.communityId, summary.title]));
  }
}
