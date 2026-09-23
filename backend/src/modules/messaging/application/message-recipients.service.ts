import { Inject, Injectable } from '@nestjs/common';

import {
  MAX_RECIPIENT_PAGE,
  type MessageRecipients,
  type RecipientPage,
} from '../contracts/message-recipients';
import type { ConversationId } from '../domain/conversation';
import { MESSAGING_READ_MODEL, type MessagingReadModel } from '../domain/ports';
import { decodeMemberCursor, encodeMemberCursor } from './cursors';

/**
 * Current members of a conversation, for delivery modules. Ids only: what a
 * notification says, and to whom it may show a preview, is decided where the
 * message can be read — here, through the use cases — not in the fan-out.
 *
 * No principal: this answers trusted in-process code (the event subscribers),
 * never a request, and it discloses nothing but membership.
 */
@Injectable()
export class MessageRecipientsService implements MessageRecipients {
  constructor(@Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel) {}

  async list(
    conversationId: string,
    options: {
      readonly excludeUserId?: string;
      readonly cursor?: string | null;
      readonly limit: number;
    },
  ): Promise<RecipientPage> {
    const after = decodeMemberCursor(options.cursor);
    if (!after.ok) throw new RangeError('Invalid recipient cursor.');
    const page = await this.readModel.listMemberIds(conversationId as ConversationId, {
      limit: Math.max(1, Math.min(options.limit, MAX_RECIPIENT_PAGE)),
      afterUserId: after.value,
      excludeUserId: options.excludeUserId,
    });
    return {
      userIds: page.userIds,
      nextCursor: page.next === null ? null : encodeMemberCursor(page.next),
    };
  }
}
